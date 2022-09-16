import path from "path"
import report from "gatsby-cli/lib/reporter"
import signalExit from "signal-exit"
import fs from "fs-extra"
import telemetry from "gatsby-telemetry"
import tar from "tar"
import { updateInternalSiteMetadata, isTruthy, uuid } from "gatsby-core-utils"
import {
  buildRenderer,
  buildHTMLPagesAndDeleteStaleArtifacts,
  IBuildArgs,
} from "./build-html"
import { buildProductionBundle } from "./build-javascript"
import { bootstrap } from "../bootstrap"
import apiRunnerNode from "../utils/api-runner-node"
import { GraphQLRunner } from "../query/graphql-runner"
import { copyStaticDirs } from "../utils/get-static-dir"
import { initTracer, stopTracer } from "../utils/tracer"
import * as db from "../redux/save-state"
import { store, emitter } from "../redux"
import * as appDataUtil from "../utils/app-data"
import { flush as flushPendingPageDataWrites } from "../utils/page-data"
const v8 = require(`v8`)
import {
  structureWebpackErrors,
  reportWebpackWarnings,
} from "../utils/webpack-error-utils"
import {
  userGetsSevenDayFeedback,
  userPassesFeedbackRequestHeuristic,
  showFeedbackRequest,
  showSevenDayFeedbackRequest,
} from "../utils/feedback"
import { actions } from "../redux/actions"
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
import { showExperimentNotices } from "../utils/show-experiment-notice"
import {
  mergeWorkerState,
  runQueriesInWorkersQueue,
} from "../utils/worker/pool"
import { createGraphqlEngineBundle } from "../schema/graphql-engine/bundle-webpack"
import {
  createPageSSRBundle,
  writeQueryContext,
} from "../utils/page-ssr-module/bundle-webpack"
import { shouldGenerateEngines } from "../utils/engines-helpers"
import reporter from "gatsby-cli/lib/reporter"
import type webpack from "webpack"
import {
  materializePageMode,
  getPageMode,
  preparePageTemplateConfigs,
} from "../utils/page-mode"
import { validateEngines } from "../utils/validate-engines"
import { constructConfigObject } from "../utils/gatsby-cloud-config"
import { waitUntilWorkerJobsAreComplete } from "../utils/jobs/worker-messaging"
import { writeTypeScriptTypes } from "../utils/graphql-typegen/ts-codegen"

async function serialBuild(
  program: IBuildArgs,
  // Let external systems running Gatsby to inject attributes
  externalTelemetryAttributes: Record<string, any>,
  externalEmitter: any
): Promise<void> {
  externalEmitter.emit(`event`, {
    type: `SITE_REPLICATION`,
    action: {
      type: `SOURCE_DIRECTORY`,
      directory: program.directory,
    },
  })
  emitter.on(`*`, msg => {
    if (
      msg &&
      msg.type &&
      process.env.IS_WORKER !== `true` &&
      // Ignore
      // - webpack/babel
      // - random internal update events
      // - schema inference/creation (each worker has to do this still).
      //
      ![
        `SET_WEBPACK_CONFIG`,
        `REPLACE_WEBPACK_CONFIG`,
        `SET_BABEL_PLUGIN`,
        `SET_BABEL_PRESET`,
        `SET_PROGRAM`,
        `SET_PROGRAM_STATUS`,
        `SET_SITE_FLATTENED_PLUGINS`,
        `API_FINISHED`,
        `TOUCH_NODE`,
        `START_INCREMENTAL_INFERENCE`,
        `SET_SCHEMA_COMPOSER`,
        `SET_SCHEMA`,
      ].includes(msg.type)
    ) {
      let cleanedUpAction
      if (msg.type === `BUILD_TYPE_METADATA`) {
        delete msg.payload.nodes
        cleanedUpAction = msg
      } else if (msg.type === `CREATE_PAGE`) {
        cleanedUpAction = JSON.parse(JSON.stringify(msg))
      } else if (msg.type === `CREATE_NODE`) {
        cleanedUpAction = JSON.parse(JSON.stringify(msg))
      } else {
        cleanedUpAction = msg
      }
      // console.log(cleanedUpAction.type, cleanedUpAction)
      cleanedUpAction.timestamp = new Date().toJSON()
      externalEmitter.emit(`event`, {
        type: `SITE_REPLICATION`,
        action: cleanedUpAction,
      })
    }
  })

  // global gatsby object to use without store
  global.__GATSBY = {
    buildId: uuid.v4(),
    root: program!.directory,
  }

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

  const { gatsbyNodeGraphQLFunction, workerPool } = await bootstrap({
    program,
    parentSpan: buildSpan,
  })

  await apiRunnerNode(`onPreBuild`, {
    graphql: gatsbyNodeGraphQLFunction,
    parentSpan: buildSpan,
  })

  // writes sync and async require files to disk
  // used inside routing "html" + "javascript"
  await writeOutRequires({
    store,
    parentSpan: buildSpan,
  })

  let closeJavascriptBundleCompilation: (() => Promise<void>) | undefined
  let closeHTMLBundleCompilation: (() => Promise<void>) | undefined
  let webpackAssets: Array<webpack.StatsAsset> | null = null
  let webpackCompilationHash: string | null = null
  let webpackSSRCompilationHash: string | null = null

  const engineBundlingPromises: Array<Promise<any>> = []
  const buildActivityTimer = report.activityTimer(
    `Building production JavaScript and CSS bundles`,
    { parentSpan: buildSpan }
  )
  buildActivityTimer.start()

  try {
    const { stats, close } = await buildProductionBundle(
      program,
      buildActivityTimer.span
    )
    closeJavascriptBundleCompilation = close

    if (stats.hasWarnings()) {
      const rawMessages = stats.toJson({ all: false, warnings: true })
      reportWebpackWarnings(rawMessages.warnings, report)
    }

    webpackAssets = stats.toJson({
      all: false,
      assets: true,
      cachedAssets: true,
    }).assets as Array<webpack.StatsAsset>
    webpackCompilationHash = stats.hash as string
  } catch (err) {
    buildActivityTimer.panic(structureWebpackErrors(Stage.BuildJavascript, err))
  } finally {
    buildActivityTimer.end()
  }

  if (shouldGenerateEngines()) {
    const state = store.getState()
    const buildActivityTimer = report.activityTimer(
      `Building Rendering Engines`,
      { parentSpan: buildSpan }
    )
    try {
      buildActivityTimer.start()
      // bundle graphql-engine
      engineBundlingPromises.push(
        createGraphqlEngineBundle(program.directory, report, program.verbose)
      )

      engineBundlingPromises.push(
        createPageSSRBundle({
          rootDir: program.directory,
          components: state.components,
          staticQueriesByTemplate: state.staticQueriesByTemplate,
          webpackCompilationHash: webpackCompilationHash as string, // we set webpackCompilationHash above
          reporter: report,
          isVerbose: program.verbose,
        })
      )
      await Promise.all(engineBundlingPromises)
    } catch (err) {
      reporter.panic(err)
    } finally {
      buildActivityTimer.end()
    }
  }

  const buildSSRBundleActivityProgress = report.activityTimer(
    `Building HTML renderer`,
    { parentSpan: buildSpan }
  )
  buildSSRBundleActivityProgress.start()
  try {
    const { close, stats } = await buildRenderer(
      program,
      Stage.BuildHTML,
      buildSSRBundleActivityProgress.span
    )

    closeHTMLBundleCompilation = close
    webpackSSRCompilationHash = stats.hash as string

    await close()
  } catch (err) {
    buildActivityTimer.panic(structureWebpackErrors(Stage.BuildHTML, err))
  } finally {
    buildSSRBundleActivityProgress.end()
  }

  // exec outer config function for each template
  const pageConfigActivity = report.activityTimer(`Execute page configs`, {
    parentSpan: buildSpan,
  })
  pageConfigActivity.start()
  try {
    await preparePageTemplateConfigs(gatsbyNodeGraphQLFunction)
  } catch (err) {
    reporter.panic(err)
  } finally {
    pageConfigActivity.end()
  }

  if (shouldGenerateEngines()) {
    const validateEnginesActivity = report.activityTimer(
      `Validating Rendering Engines`,
      {
        parentSpan: buildSpan,
      }
    )
    validateEnginesActivity.start()
    try {
      await validateEngines(store.getState().program.directory)
    } catch (error) {
      validateEnginesActivity.panic({ id: `98001`, context: {}, error })
    } finally {
      validateEnginesActivity.end()
    }
  }

  const cacheActivity = report.activityTimer(`Caching Webpack compilations`, {
    parentSpan: buildSpan,
  })
  try {
    cacheActivity.start()
    await Promise.all([
      closeJavascriptBundleCompilation?.(),
      closeHTMLBundleCompilation?.(),
    ])
  } finally {
    cacheActivity.end()
  }

  // Create tarball of engine files and send them to pubsub
  await tar.c({ gzip: true, file: `ssr-engine-tarball.tgz` }, [
    `public/webpack.stats.json`,
    `.cache/page-ssr`,
    `.cache/_this_is_virtual_fs_path_`,
  ])
  const tarBuffer = fs.readFileSync(`ssr-engine-tarball.tgz`)
  externalEmitter.emit(`event`, {
    type: `SSR_ENGINE`,
    buffer: tarBuffer,
    timestamp: new Date().toJSON(),
  })

  // Copy files from the static directory to
  // an equivalent static directory within public.
  copyStaticDirs()

  // Make sure we saved the latest state so we have all jobs cached
  await db.saveState()

  report.info(`Done building in ${process.uptime()} sec`)

  buildActivity.end()
  if (!externalTelemetryAttributes) {
    await stopTracer()
  }
  externalEmitter.emit(`event`, {
    type: `BOOTSTRAPPING_DONE`,
    timestamp: new Date().toJSON(),
  })
}

const srcLocation = process.cwd()
const program = {
  directory: srcLocation,
  sitePackageJson: require(path.join(srcLocation, `package.json`)),
  noUglify: false,
  host: process.env.HOSTNAME,
  port: 10000,
  version: `1.0.0`,
  prefixPaths: false,
}

async function main() {
  // Create topic if it's not already created.
  // console.time(`createTopic`)
  // const [topics] = await pubsub.getTopics()
  // console.log(topics)
  // if (!topics.some(topic => topic.name.includes(topicNameOrId))) {
  // await pubsub.createTopic(topicNameOrId)
  // await topic.createSubscription(subscriptionName)
  // }
  // console.timeEnd(`createTopic`)
  // // process.exit()
  // await serialBuild(program)
  // topic.publish(
  // Buffer.from(
  // v8.serialize({ type: `BUILD_ENDED`, timestamp: new Date().toJSON() })
  // )
  // )
}

// main()
export default serialBuild
