import path from "path"
import report from "gatsby-cli/lib/reporter"
import fastq from "fastq"
import { slash } from "gatsby-core-utils"
import signalExit from "signal-exit"
import fs from "fs-extra"
import telemetry from "gatsby-telemetry"
import { updateInternalSiteMetadata, isTruthy, uuid } from "gatsby-core-utils"
import { buildHTMLPagesAndDeleteStaleArtifacts, IBuildArgs } from "./build-html"
import { GraphQLRunner } from "../query/graphql-runner"
import glob from "globby"
import { initTracer, stopTracer } from "../utils/tracer"
import * as db from "../redux/save-state"
import { store, emitter, savePartialStateToDisk } from "../redux"
import * as appDataUtil from "../utils/app-data"
import { flush as flushPendingPageDataWrites } from "../utils/page-data"
import { actions } from "../redux/actions"
import { loadConfig } from "../bootstrap/load-config"
import { loadPlugins } from "../bootstrap/load-plugins"
import { resolveModule } from "../utils/module-resolver"
import { compileGatsbyFiles } from "../utils/parcel/compile-gatsby-files"
import { waitUntilAllJobsComplete } from "../utils/wait-until-jobs-complete"
import { Stage } from "./types"
import {
  calculateDirtyQueries,
  runStaticQueries,
  runPageQueries,
  writeOutRequires,
} from "../services"
import {
  markWebpackStatusAsPending,
  markWebpackStatusAsDone,
} from "../utils/webpack-status"
import {
  mergeWorkerState,
  runQueriesInWorkersQueue,
} from "../utils/worker/pool"
import { writeQueryContext } from "../utils/page-ssr-module/bundle-webpack"
import { shouldGenerateEngines } from "../utils/engines-helpers"
import reporter from "gatsby-cli/lib/reporter"
import {
  materializePageMode,
  getPageMode,
  preparePageTemplateConfigs,
} from "../utils/page-mode"
import { waitUntilWorkerJobsAreComplete } from "../utils/jobs/worker-messaging"
import { globalTracer } from "opentracing"
import * as WorkerPool from "../utils/worker/pool"
const { getDataStore, getTypes, detectLmdbStore } = require(`../datastore`)
const { PubSub } = require(`@google-cloud/pubsub`)
const v8 = require(`v8`)
process.env.GATSBY_EXPERIMENTAL_PARALLEL_QUERY_RUNNING = true

const projectId = `your-project-id` // Your Google Cloud Platform project ID
const topicNameOrId = `my-topic` // Name for the new topic to create
const subscriptionName = `my-sub` // Name for the new subscription to create
// Instantiates a client
const pubsub = new PubSub({ projectId })
const topic = pubsub.topic(topicNameOrId)

const tracer = globalTracer()

async function parallelBuild(
  program: IBuildArgs,
  // Let external systems running Gatsby to inject attributes
  externalTelemetryAttributes: Record<string, any>
): Promise<void> {
  // global gatsby object to use without store
  global.__GATSBY = {
    buildId: uuid.v4(),
    root: program!.directory,
  }

  store.dispatch({
    type: `SET_PROGRAM`,
    payload: program,
  })

  const parentSpan = tracer.startSpan(`worker-manager`)

  if (isTruthy(process.env.VERBOSE)) {
    program.verbose = true
  }
  report.setVerbose(program.verbose)

  report.verbose(`Running build in "${process.env.NODE_ENV}" environment`)

  await updateInternalSiteMetadata({
    name: program.sitePackageJson.name,
    sitePath: program.directory,
    lastRun: Date.now(),
    pid: process.pid,
  })

  markWebpackStatusAsPending()

  const publicDir = path.join(program.directory, `public`)
  if (!externalTelemetryAttributes) {
    await initTracer(
      process.env.GATSBY_OPEN_TRACING_CONFIG_FILE ||
        program.openTracingConfigFile
    )
  }

  const buildActivity = report.phantomActivity(`build`)
  buildActivity.start()

  telemetry.trackCli(`BUILD_START`)
  signalExit(exitCode => {
    telemetry.trackCli(`BUILD_END`, {
      exitCode: exitCode as number | undefined,
    })
  })

  const buildSpan = buildActivity.span
  buildSpan.setTag(`directory`, program.directory)

  // Add external tags to buildSpan
  if (externalTelemetryAttributes) {
    Object.entries(externalTelemetryAttributes).forEach(([key, value]) => {
      buildActivity.span.setTag(key, value)
    })
  }

  // Bootstrap
  const bootstrapContext = {
    program,
    shouldRunCreatePagesStatefully: true,
  }

  // What must the worker-runner know & be able to do
  // - data
  //  - pages
  //  - nodes
  //  - queries
  // - do
  //  - jobs

  // Initialize
  const directory = slash(program.directory)
  let activityForJobs

  emitter.on(`CREATE_JOB`, () => {
    if (!activityForJobs) {
      activityForJobs = reporter.phantomActivity(`Running jobs`)
      activityForJobs.start()
    }
  })

  const onEndJob = (): void => {
    if (activityForJobs && store.getState().jobs.active.length === 0) {
      activityForJobs.end()
      activityForJobs = null
    }
  }

  emitter.on(`END_JOB`, onEndJob)

  // Compile root gatsby files
  let activity = reporter.activityTimer(`compile gatsby files`)
  activity.start()
  await compileGatsbyFiles(program.directory)
  activity.end()

  // Load gatsby config
  activity = reporter.activityTimer(`load gatsby config`, {
    parentSpan,
  })
  activity.start()
  const config = await loadConfig({
    siteDirectory: program.directory,
    processFlags: true,
  })
  activity.end()

  // Load plugins
  activity = reporter.activityTimer(`load plugins`, {
    parentSpan,
  })
  activity.start()
  const flattenedPlugins = await loadPlugins(config, program.directory)
  activity.end()

  // Ensure directories exist
  const lmdbCacheDirectoryName = `caches-lmdb`

  const cacheDirectory = `${program.directory}/.cache`
  const publicDirectory = `${program.directory}/public`
  const workerCacheDirectory = `${program.directory}/.cache/worker`
  const lmdbCacheDirectory = `${program.directory}/.cache/${lmdbCacheDirectoryName}`

  const cacheJsonDirExists = fs.existsSync(`${cacheDirectory}/json`)
  const publicDirExists = fs.existsSync(publicDirectory)
  const workerCacheDirExists = fs.existsSync(workerCacheDirectory)
  const lmdbCacheDirExists = fs.existsSync(lmdbCacheDirectory)

  const lmdbStoreIsUsed = detectLmdbStore()

  // check the cache file that is used by the current configuration
  const cacheDirExists = lmdbStoreIsUsed
    ? lmdbCacheDirExists
    : cacheJsonDirExists

  // For builds in case public dir exists, but cache doesn't, we need to clean up potentially stale
  // artifacts from previous builds (due to cache not being available, we can't rely on tracking of artifacts)
  if (
    process.env.NODE_ENV === `production` &&
    publicDirExists &&
    !cacheDirExists
  ) {
    activity = reporter.activityTimer(
      `delete html and css files from previous builds`,
      {
        parentSpan,
      }
    )
    activity.start()
    const files = await glob(
      [
        `public/**/*.{html,css}`,
        `!public/page-data/**/*`,
        `!public/static`,
        `!public/static/**/*.{html,css}`,
      ],
      {
        cwd: program.directory,
      }
    )
    await Promise.all(files.map(file => fs.remove(file)))
    activity.end()
  }

  // Now that we know the .cache directory is safe, initialize the cache
  // directory.
  await fs.ensureDir(cacheDirectory)

  // When the main process and workers communicate they save parts of their redux state to .cache/worker
  // We should clean this directory to remove stale files that a worker might accidentally reuse then
  if (
    workerCacheDirExists &&
    process.env.GATSBY_EXPERIMENTAL_PARALLEL_QUERY_RUNNING
  ) {
    activity = reporter.activityTimer(
      `delete worker cache from previous builds`,
      {
        parentSpan,
      }
    )
    activity.start()
    await fs
      .remove(workerCacheDirectory)
      .catch(() => fs.emptyDir(workerCacheDirectory))
    activity.end()
  }

  activity = reporter.activityTimer(`copy gatsby files`, {
    parentSpan,
  })
  activity.start()
  const srcDir = `${__dirname}/../../cache-dir`
  const siteDir = cacheDirectory
  const tryRequire = `${__dirname}/../utils/test-require-error.js`
  try {
    await fs.copy(srcDir, siteDir, {
      overwrite: true,
    })
    await fs.copy(tryRequire, `${siteDir}/test-require-error.js`)
    if (lmdbStoreIsUsed) {
      await fs.ensureDir(`${cacheDirectory}/${lmdbCacheDirectoryName}`)
    } else {
      await fs.ensureDir(`${cacheDirectory}/json`)
    }

    // Ensure .cache/fragments exists and is empty. We want fragments to be
    // added on every run in response to data as fragments can only be added if
    // the data used to create the schema they're dependent on is available.
    await fs.emptyDir(`${cacheDirectory}/fragments`)
  } catch (err) {
    reporter.panic(`Unable to copy site files to .cache`, err)
  }

  // Find plugins which implement gatsby-browser and gatsby-ssr and write
  // out api-runners for them.
  const hasAPIFile = (env, plugin): string | undefined => {
    // The plugin loader has disabled SSR APIs for this plugin. Usually due to
    // multiple implementations of an API that can only be implemented once
    if (env === `ssr` && plugin.skipSSR === true) return undefined

    const envAPIs = plugin[`${env}APIs`]

    // Always include gatsby-browser.js files if they exist as they're
    // a handy place to include global styles and other global imports.
    try {
      if (env === `browser`) {
        const modulePath = path.join(plugin.resolve, `gatsby-${env}`)
        return slash(resolveModule(modulePath) as string)
      }
    } catch (e) {
      // ignore
    }

    if (envAPIs && Array.isArray(envAPIs) && envAPIs.length > 0) {
      const modulePath = path.join(plugin.resolve, `gatsby-${env}`)
      return slash(resolveModule(modulePath) as string)
    }
    return undefined
  }

  const isResolved = (plugin): plugin is IPluginResolution => !!plugin.resolve
  const isResolvedSSR = (plugin): plugin is IPluginResolutionSSR =>
    !!plugin.resolve

  const ssrPlugins: Array<IPluginResolutionSSR> = flattenedPlugins
    .map(plugin => {
      return {
        name: plugin.name,
        resolve: hasAPIFile(`ssr`, plugin),
        options: plugin.pluginOptions,
      }
    })
    .filter(isResolvedSSR)

  const browserPlugins: Array<IPluginResolution> = flattenedPlugins
    .map(plugin => {
      return {
        resolve: hasAPIFile(`browser`, plugin),
        options: plugin.pluginOptions,
      }
    })
    .filter(isResolved)

  const browserPluginsRequires = browserPlugins
    .map(plugin => {
      // we need a relative import path to keep contenthash the same if directory changes
      const relativePluginPath = path.relative(siteDir, plugin.resolve)
      return `{
      plugin: require('${slash(relativePluginPath)}'),
      options: ${JSON.stringify(plugin.options)},
    }`
    })
    .join(`,`)

  const browserAPIRunner = `module.exports = [${browserPluginsRequires}]\n`

  let sSRAPIRunner = ``

  try {
    sSRAPIRunner = fs.readFileSync(`${siteDir}/api-runner-ssr.js`, `utf-8`)
  } catch (err) {
    reporter.panic(`Failed to read ${siteDir}/api-runner-ssr.js`, err)
  }

  const ssrPluginsRequires = ssrPlugins
    .map(
      plugin =>
        `{
      name: '${plugin.name}',
      plugin: require('${plugin.resolve}'),
      options: ${JSON.stringify(plugin.options)},
    }`
    )
    .join(`,`)
  sSRAPIRunner = `var plugins = [${ssrPluginsRequires}]\n${sSRAPIRunner}`

  fs.writeFileSync(
    `${siteDir}/api-runner-browser-plugins.js`,
    browserAPIRunner,
    `utf-8`
  )
  fs.writeFileSync(`${siteDir}/api-runner-ssr.js`, sSRAPIRunner, `utf-8`)

  activity.end()
  const workerPool = WorkerPool.create()

  workerPool.all.loadConfigAndPlugins({
    siteDirectory: program.directory,
    program,
  })

  const context = {
    ...bootstrapContext,
    store,
    program,
  }

  // writes sync and async require files to disk
  // used inside routing "html" + "javascript"
  // await writeOutRequires({
  // store,
  // parentSpan: buildSpan,
  // })

  async function buildPages({ partitionNumber, partitionCount }) {
    savePartialStateToDisk([`inferenceMetadata`])
    savePartialStateToDisk([`components`, `staticQueryComponents`])

    workerPool.all.buildSchema()

    const { queryIds } = await calculateDirtyQueries({ store })
    // queryIds.pageQueryIds = [
    // {
    // internalComponentName: `ComponentIndex`,
    // path: `/`,
    // matchPath: undefined,
    // component: `/Users/kylemathews/programs/gatsby-sourcing-studio-test/src/pages/index.tsx`,
    // componentPath: `/Users/kylemathews/programs/gatsby-sourcing-studio-test/src/pages/index.tsx`,
    // componentChunkName: `component---src-pages-index-tsx`,
    // isCreatedByStatefulCreatePages: true,
    // context: {},
    // updatedAt: 1663107104434,
    // pluginCreator___NODE: `6c26384c-7351-5f04-bd89-c600c6f4111f`,
    // pluginCreatorId: `6c26384c-7351-5f04-bd89-c600c6f4111f`,
    // mode: `SSG`,
    // },
    // {
    // internalComponentName: `Component/404.html`,
    // path: `/404.html`,
    // matchPath: undefined,
    // component: `/Users/kylemathews/programs/gatsby-sourcing-studio-test/src/pages/404.tsx`,
    // componentPath: `/Users/kylemathews/programs/gatsby-sourcing-studio-test/src/pages/404.tsx`,
    // componentChunkName: `component---src-pages-404-tsx`,
    // isCreatedByStatefulCreatePages: true,
    // context: {},
    // updatedAt: 1663107104413,
    // pluginCreator___NODE: `6c26384c-7351-5f04-bd89-c600c6f4111f`,
    // pluginCreatorId: `6c26384c-7351-5f04-bd89-c600c6f4111f`,
    // mode: `SSG`,
    // },
    // ]

    // Only run queries with mode SSG
    queryIds.pageQueryIds = queryIds.pageQueryIds.filter(
      query => getPageMode(query) === `SSG` && query.path !== `/404/`
    )

    function partitionArray(srcArray) {
      const destArray = []
      let pointer = -1 + partitionNumber
      while (true) {
        if (srcArray.length > pointer) {
          destArray.push(srcArray[pointer])
        } else {
          break
        }

        pointer = pointer + partitionCount
      }

      return destArray
    }

    const partitionedPageQueries = partitionArray(queryIds.pageQueryIds)
    queryIds.pageQueryIds = partitionedPageQueries

    console.log({
      partitionedPageQueries: partitionedPageQueries.map(q => q.path),
    })

    await runQueriesInWorkersQueue(workerPool, queryIds, {
      parentSpan: buildSpan,
    })
    console.log(5)
    // Jobs still might be running even though query running finished
    await Promise.all([
      waitUntilAllJobsComplete(),
      waitUntilWorkerJobsAreComplete(),
    ])
    await mergeWorkerState(workerPool, buildSpan)

    // create scope so we don't leak state object
    {
      const state = store.getState()
      await writeQueryContext({
        staticQueriesByTemplate: state.staticQueriesByTemplate,
        components: state.components,
      })
    }

    // TODO would need to pass in updated webpackCompilationHash
    const webpackCompilationHash = Math.random().toString()
    const webpackSSRCompilationHash: string | null = null
    // create scope so we don't leak state object
    {
      const state = store.getState()
      if (
        webpackCompilationHash !== state.webpackCompilationHash ||
        !appDataUtil.exists(publicDir)
      ) {
        store.dispatch({
          type: `SET_WEBPACK_COMPILATION_HASH`,
          payload: webpackCompilationHash,
        })

        const rewriteActivityTimer = report.activityTimer(
          `Rewriting compilation hashes`,
          {
            parentSpan: buildSpan,
          }
        )
        rewriteActivityTimer.start()

        await appDataUtil.write(publicDir, webpackCompilationHash as string)

        rewriteActivityTimer.end()
      }
    }

    console.log(5.5)
    await flushPendingPageDataWrites(buildSpan)
    console.log(6)
    markWebpackStatusAsDone()

    await waitUntilAllJobsComplete()

    if (shouldGenerateEngines()) {
      // well, tbf we should just generate this in `.cache` and avoid deleting it :shrug:
      program.keepPageRenderer = true
    }

    const { toRegenerate, toDelete } =
      await buildHTMLPagesAndDeleteStaleArtifacts({
        program,
        partitionArray,
        workerPool,
        parentSpan: buildSpan,
      })
  }

  // await db.saveState()
  report.info(`Done bootstrapping in ${process.uptime()} sec`)
  buildActivity.end()

  /*


  buildActivity.end()
  if (!externalTelemetryAttributes) {
    await stopTracer()
  }
  */

  const replicationLogQueue = fastq(worker, 1)

  let upstreamRootDirectory: string
  function worker(arg, cb) {
    const action = arg.action

    // Massage actions
    if (action.type === `SOURCE_DIRECTORY`) {
      upstreamRootDirectory = action.directory
    }

    if (action.type === `CREATE_PAGE`) {
      const newPath = path.join(
        program.directory,
        path.relative(upstreamRootDirectory, action.payload.component)
      )
      action.payload.component = newPath
      action.payload.componentPath = newPath
    }
    if (action.type === `QUERY_EXTRACTED`) {
      const newPath = path.join(
        program.directory,
        path.relative(upstreamRootDirectory, action.payload.componentPath)
      )
      action.payload.componentPath = newPath
    }

    if (action.type === `BUILD_TYPE_METADATA`) {
      action.payload.nodes = getDataStore().iterateNodesByType(
        action.payload.typeName
      )
    }

    store.dispatch(action)
    cb()
  }

  // TODO
  // - return function to process actions
  // - return function to run builds.
  return { replicationLogQueue, buildPages }
}

export default parallelBuild

// async function main() {
// await parallelBuild(program)
// [>
// const subscription = topic.subscription(subscriptionName)
// // await subscription.create()
// console.log(3)
// subscription.on(`message`, async message => {
// let action = {}
// try {
// action = v8.deserialize(message.data)
// } catch (e) {
// console.log(`not parseable`)
// }
// console.log(`Received message:`, action.type, action.timestamp)
// if (action.type) {
// if (action.type === `BUILD_TYPE_METADATA`) {
// action.payload.nodes = getDataStore().iterateNodesByType(
// action.payload.typeName
// )
// }
// store.dispatch(action)
// }
// if (action.type === `BUILD_ENDED`) {
// await db.saveState()
// console.log(`saved state`)
// }
// })
// console.log(4)
// */
// }

// main()
