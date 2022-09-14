import { interpret } from "xstate"
import parentMachine from "./parent"
import childMachine from "./child"
const pEvent = require(`p-event`).default
const EventEmitter = require(`events`)
const util = require(`util`)

const myEmitter = new EventEmitter()
const once = util.promisify(myEmitter.once)

// Steps to test
// starts and is idle
// hears build has started and responds with info about itself
// gets assigned a partition id
// gets events and passes them to gatsby
// emits event when gets the bootstrap finished done event
// gets build command & passes that to gatsby and emits even when done
// gets build_done event and returns to listening.

it(`should go all the way through`, done => {
  async function asyncFunction() {
    let currentParentState
    let currentChild1State
    const parentInstance = interpret(
      parentMachine.withContext({
        workersCount: 0,
        partionsDoneSyncingCount: 0,
        bus: myEmitter,
      })
    ).onTransition(state => {
      currentParentState = state
      if (state.matches(`done`)) {
        done()
      }
    })
    const child1Instance = interpret(
      childMachine.withContext({
        bus: myEmitter,
      })
    ).onTransition(state => {
      currentChild1State = state
    })

    // Send in events
    myEmitter.on(`event`, msg => {
      console.log(msg)
      if (msg.author == `parent`) {
        child1Instance.send(msg)
      } else {
        parentInstance.send(msg)
      }
    })

    parentInstance.start()
    child1Instance.start()

    expect(currentChild1State.value).toEqual(`syncing`)
    expect(currentParentState.context.workersCount).toEqual(1)
    expect(currentChild1State.context.partitionNumber).toEqual(1)

    // Children finish syncing so building can start
    parentInstance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })
    await new Promise(resolve => setTimeout(resolve, 10))
    child1Instance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })
    expect(currentParentState.value).toEqual(`waitingForWorkersToBuild`)
    expect(currentChild1State.value).toEqual(`building`)
    expect(currentChild1State.context.partitionNumber).toEqual(1)
    expect(currentChild1State.context.partitionCount).toEqual(1)

    // From internal Gatsby machine.
    child1Instance.send(`PARTITION_BUILDING_FINISHED`)
  }
  asyncFunction()
})
