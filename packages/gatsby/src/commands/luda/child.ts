import { interpret } from "xstate"
import crypto from "crypto"
const v8 = require(`v8`)
import fs from "fs-extra"
import path from "path"
import childMachine from "./child-machine"
import parallelBuild from "../parallel-build"
import tar from "tar"
import { execSync } from "child_process"
const stream = require(`stream`)
const { promisify } = require(`util`)
const got = require(`got`)

const pipeline = promisify(stream.pipeline)

import { createClient } from "redis"

// Add simple HTTP server for the fly.io health check
const http = require(`http`)

const requestListener = function (req, res) {
  res.writeHead(200)
  res.end(`Hello, World!`)
}

const server = http.createServer(requestListener)
server.listen(8080)

let eventsSynced = 0
async function main() {
  const client = createClient({
    url: `redis://default:5Jfpsh9R7aOp3hkU49mbHKODfHxvhLsN@redis-19578.c21350.us-west-2-1.ec2.cloud.rlrcp.com:19578`,
  })

  client.on(`error`, err => console.log(`Redis Client Error`, err))

  await client.connect()

  const redisEmitter = {
    emit: (channel, msg) => {
      const message = Buffer.from(v8.serialize(msg))
      client.publish(channel, message)
    },
  }
  const subscriber = client.duplicate()
  await subscriber.connect()

  const srcLocation = process.cwd()

  // Download redux/node state files
  const urls = [
    {
      url: `https://storage.googleapis.com/kyle-public/redux/redux.rest.state`,
      path: `.cache/redux/redux.rest.state`,
    },
    {
      url: `https://storage.googleapis.com/kyle-public/redux/redux.node.state_0`,
      path: `.cache/redux/redux.node.state_0`,
    },
    {
      url: `https://storage.googleapis.com/kyle-public/redux/redux.page.state_0`,
      path: `.cache/redux/redux.page.state_0`,
    },
    {
      url: `https://storage.googleapis.com/kyle-public/data.mdb`,
      path: `.cache/data/datastore/data.mdb`,
    },
  ]

  await Promise.all(
    urls.map(async urlInfo => {
      const fullPath = path.join(srcLocation, urlInfo.path)
      await fs.ensureDir(path.parse(fullPath).dir)
      await pipeline(got.stream(urlInfo.url), fs.createWriteStream(fullPath))
      console.log(`downloaded file to ${fullPath}`)
    })
  )

  // Do very minimal bootstrap of the Gatsby worker controller
  // to pass in as context.
  const program = {
    directory: srcLocation,
    sitePackageJson: require(path.join(srcLocation, `package.json`)),
    noUglify: false,
    host: process.env.HOSTNAME,
    port: 10000,
    version: `1.0.0`,
    prefixPaths: false,
  }

  const gatsbyController = await parallelBuild(program)

  const child1Id = crypto.randomUUID()
  const child1Instance = interpret(
    childMachine.withContext({
      id: child1Id,
      gatsbyController,
      bus: redisEmitter,
    })
  ).onTransition(state => {
    // currentChild1State = state
    if (state.changed) {
      console.log(`MYSTATE`, state.value)
    }
  })

  // Create replication queue where actions are pushed
  // the syncing invocation then processes those until it gets
  // to the end and then signals it's done.

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`) // $& means the whole matched string
  }
  function replaceAll(str, match, replacement) {
    return str.replace(new RegExp(escapeRegExp(match), `g`), () => replacement)
  }
  setInterval(() => console.log({ child1Id, eventsSynced }), 1000)

  let upstreamRootDirectory: string
  await subscriber.subscribe(
    `event`,
    msgToParse => {
      const msg = v8.deserialize(msgToParse)
      eventsSynced += 1
      if (msg.action?.type === `UPSTREAM_SOURCE_DIRECTORY`) {
        upstreamRootDirectory = msg.action.directory
      }
      if (msg.type === `SSR_ENGINE`) {
        fs.writeFileSync(`ssr-engine-tarball.tgz`, msg.buffer)
        tar.x({ file: `ssr-engine-tarball.tgz` }).then(() => {
          // Rewrite paths
          const files = execSync(
            `grep -rinl "${upstreamRootDirectory}" .cache/*`
          )
            .toString()
            .split(`\n`)
            .filter(line => line !== ``)
            // Don't rewrite the lmdb db.
            .filter(line => !line.includes(`.mdb`))
            // Or the redux store.
            .filter(line => !line.includes(`redux`))

          files.forEach(file => {
            console.log(
              `replacing in ${file}, ${upstreamRootDirectory} => ${program.directory}`
            )
            let fileStr = fs.readFileSync(file, `utf-8`)
            fileStr = replaceAll(
              fileStr,
              upstreamRootDirectory,
              program.directory
            )
            fs.writeFileSync(file, fileStr)
          })

          console.log(`filesToBeReplaced`, { files })
          // Taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
        })
        return
      }

      if (msg.type !== `SITE_REPLICATION`) {
        console.log(`event`, msg.type)
        child1Instance.send(msg)
      } else {
        if (msg.action.type !== `CREATE_NODE`) {
          console.log(`event`, msg.action.type)
        }
        gatsbyController.replicationLogQueue.push(msg)
      }
    },
    true
  )

  child1Instance.start()
}

main()
