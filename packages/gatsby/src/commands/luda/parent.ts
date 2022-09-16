import { interpret } from "xstate"
import parentMachine from "./parent-machine"
import serialBuild from "../serial-build"
import path from "path"
const v8 = require(`v8`)

import { createClient } from "redis"

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
  const client = createClient()

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

  const parentInstance = interpret(
    parentMachine.withContext({
      workersCount: 0,
      workers: [],
      partionsDoneSyncingCount: 0,
      partionsDoneBuildingCount: 0,
      // bus: emitter,
      bus: redisEmitter,
    })
  ).onTransition(state => {
    // currentParentState = state
    console.log(
      new Date().getTime(),
      `PARENT`,
      state.value,
      state.context,
      state.event
    )

    if (state.value === `done`) {
      console.log(`DONE!!!`, process.uptime())
      // process.exit()
    }
  })

  await subscriber.subscribe(
    `event`,
    msgToParse => {
      const msg = v8.deserialize(msgToParse)
      console.log(`event`, msg.type)
      parentInstance.send(msg)
    },
    true
  )

  parentInstance.start()

  serialBuild(program, null, redisEmitter)

  // Fake Gatsby
  // await new Promise(resolve => setTimeout(resolve, 1000))
  // client.publish(`event`, JSON.stringify({ type: `BOOTSTRAPPING_DONE` }))
}

main()
