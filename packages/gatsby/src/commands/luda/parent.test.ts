import { interpret } from "xstate"
import parentMachine from "./parent"
import childMachine from "./child"
const pEvent = require(`p-event`).default
import Emittery from "emittery"

const emitter = new Emittery()

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
        bus: emitter,
      })
    ).onTransition(state => {
      currentParentState = state
      if (state.matches(`done`)) {
        done()
      }
    })
    const child1Instance = interpret(
      childMachine.withContext({
        bus: emitter,
      })
    ).onTransition(state => {
      currentChild1State = state
    })

    // Send in events
    emitter.on(`event`, msg => {
      console.log(`event`, msg)
      child1Instance.send(msg)
      parentInstance.send(msg)
    })

    parentInstance.start()
    child1Instance.start()

    // Wait for worker 1 to get assigned
    await pEvent(
      emitter,
      `event`,
      event =>
        event.type === `PARTITION_ASSIGNMENT` && event.partitionNumber === 1
    )

    // Child is in right state & parent knows about 1 worker.
    expect(currentChild1State.value).toEqual(`syncing`)
    expect(currentParentState.context.workersCount).toEqual(1)
    expect(currentChild1State.context.partitionNumber).toEqual(1)

    // Wait for serial build work to finish (yup, blazing fast)
    await new Promise(resolve => setTimeout(resolve, 50))

    // Gatsby emits BOOTSTRAPPING_DONE to both parent & child (Gatsby is streaming
    // actions/events to pub/sub during build).
    parentInstance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })
    child1Instance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })

    await pEvent(emitter, `event`, event => event.type === `START_BUILDING`)
    expect(currentParentState.value).toEqual(`waitingForWorkersToBuild`)
    expect(currentChild1State.value).toEqual(`building`)
    expect(currentChild1State.context.partitionNumber).toEqual(1)
    expect(currentChild1State.context.partitionCount).toEqual(1)

    // Wait for parallel build work to finish (yup, blazing fast)
    await new Promise(resolve => setTimeout(resolve, 50))

    // This event is from the worker Gatsby instance.
    child1Instance.send(`FINISHED_BUILDING`)
  }
  asyncFunction()
})
