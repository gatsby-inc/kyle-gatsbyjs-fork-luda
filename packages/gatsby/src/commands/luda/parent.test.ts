import { interpret } from "xstate"
import parentMachine from "./parent"
import childMachine from "./child"
const pEvent = require(`p-event`).default
import Emittery from "emittery"
import crypto from "crypto"

const emitter = new Emittery()
jest.setTimeout(700)

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
    let currentChild2State
    const parentInstance = interpret(
      parentMachine.withContext({
        workersCount: 0,
        workers: [],
        partionsDoneSyncingCount: 0,
        partionsDoneBuildingCount: 0,
        bus: emitter,
      })
    ).onTransition(state => {
      currentParentState = state
    })
    const child1Id = crypto.randomUUID()
    const child1Instance = interpret(
      childMachine.withContext({
        id: child1Id,
        bus: emitter,
      })
    ).onTransition(state => {
      currentChild1State = state
    })
    const child2Id = crypto.randomUUID()
    const child2Instance = interpret(
      childMachine.withContext({
        id: child2Id,
        bus: emitter,
      })
    ).onTransition(state => {
      currentChild2State = state
    })

    // Send in events
    emitter.on(`event`, msg => {
      console.log(`event`, msg)
      child1Instance.send(msg)
      child2Instance.send(msg)
      parentInstance.send(msg)
    })

    child1Instance.start()
    child2Instance.start()
    parentInstance.start()

    // Wait for worker 1 to get assigned
    await pEvent(
      emitter,
      `event`,
      event =>
        event.type === `PARTITION_ASSIGNMENT` && event.partitionNumber === 1
    )

    // Child is in right state & parent knows about 1 worker.
    expect(currentChild1State.value).toEqual(`syncing`)
    expect(currentChild2State.value).toEqual(`syncing`)
    expect(currentParentState.context.workersCount).toEqual(2)
    expect(currentParentState.context.workers).toEqual([
      { id: child1Id },
      { id: child2Id },
    ])
    expect(currentChild1State.context.partitionNumber).toEqual(1)
    expect(currentChild2State.context.partitionNumber).toEqual(2)

    // Wait for serial build work to finish (yup, blazing fast)
    await new Promise(resolve => setTimeout(resolve, 50))

    // Gatsby emits BOOTSTRAPPING_DONE to both parent & child (Gatsby is
    // streaming actions/events to pub/sub during build).
    parentInstance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })
    child1Instance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })
    child2Instance.send({ type: `BOOTSTRAPPING_DONE`, author: `gatsby` })

    await pEvent(emitter, `event`, event => event.type === `START_BUILDING`)
    expect(currentParentState.value).toEqual(`waitingForWorkersToBuild`)
    expect(currentParentState.context.workers).toEqual([
      { id: child1Id, doneSyncing: true },
      { id: child2Id, doneSyncing: true },
    ])
    expect(currentChild1State.value).toEqual(`building`)
    expect(currentChild2State.value).toEqual(`building`)
    expect(currentChild1State.context.partitionNumber).toEqual(1)
    expect(currentChild1State.context.partitionCount).toEqual(2)
    expect(currentChild2State.context.partitionNumber).toEqual(2)
    expect(currentChild2State.context.partitionCount).toEqual(2)

    // Wait for parallel build work to finish (yup, blazing fast)
    await new Promise(resolve => setTimeout(resolve, 50))

    // This event is from the worker Gatsby instance.
    process.nextTick(() => {
      child1Instance.send(`FINISHED_BUILDING`)
      child2Instance.send(`FINISHED_BUILDING`)
    })

    await pEvent(
      emitter,
      `event`,
      event => event.type === `PARTITION_BUILDING_FINISHED`
    )
    expect(currentParentState.context.workers).toEqual([
      { id: child1Id, doneSyncing: true, doneBuilding: true },
      { id: child2Id, doneSyncing: true, doneBuilding: true },
    ])

    // Children clean themselves up at end of the build.
    expect(currentChild1State.context.partitionCount).toEqual(undefined)
    expect(currentChild1State.context.partitionNumber).toEqual(undefined)
    expect(currentChild2State.context.partitionCount).toEqual(undefined)
    expect(currentChild2State.context.partitionNumber).toEqual(undefined)

    done()
  }

  asyncFunction()
})
