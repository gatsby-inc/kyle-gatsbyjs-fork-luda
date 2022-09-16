import { interpret } from "xstate"
import crypto from "crypto"
const v8 = require(`v8`)
import fs from "fs-extra"
import path from "path"
import childMachine from "./child-machine"
import parallelBuild from "../parallel-build"
import tar from "tar"
import { execSync } from "child_process"

import { createClient } from "redis"

async function main() {
  const client = createClient({
    url: `redis://137.66.4.103:10000`,
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

  // Do very minimal bootstrap of the Gatsby worker controller
  // to pass in as context.
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

  console.log({ program })
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
    console.log(`MYSTATE`, state.value, state.context)
  })

  // Create replication queue where actions are pushed
  // the syncing invocation then processes those until it gets
  // to the end and then signals it's done.

  let upstreamRootDirectory: string
  await subscriber.subscribe(
    `event`,
    msgToParse => {
      const msg = v8.deserialize(msgToParse)
      if (msg.action?.type === `SOURCE_DIRECTORY`) {
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

          console.log(`filesToBeReplaced`, { files })
          // Taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
          function escapeRegExp(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`) // $& means the whole matched string
          }
          function replaceAll(str, match, replacement) {
            return str.replace(
              new RegExp(escapeRegExp(match), `g`),
              () => replacement
            )
          }
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
        })
        return
      }

      console.log(`event`, msg)
      if (msg.type !== `SITE_REPLICATION`) {
        child1Instance.send(msg)
      } else {
        gatsbyController.replicationLogQueue.push(msg)
      }
    },
    true
  )

  child1Instance.start()
}

main()
