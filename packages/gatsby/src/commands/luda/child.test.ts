import { interpret } from "xstate"
import childMachine from "./child"

// Steps to test
// starts and is idle
// hears build has started and responds with info about itself
// gets assigned a partition id
// gets events and passes them to gatsby
// emits event when gets the bootstrap finished done event
// gets build command & passes that to gatsby and emits even when done
// gets build_done event and returns to listening.

let callCount = 0
it(`should go all the way through`, done => {
  let currentState
  const workerChildMachine = interpret(childMachine).onTransition(state => {
    currentState = state
    if (state.matches(`waitingForBuild`)) {
      callCount += 1
      // This is the initial and last state so we wait for it to
      // hit this state the second time.
      if (callCount === 2) {
        done()
      }
    }
  })

  workerChildMachine.start()

  // New build.
  workerChildMachine.send({ type: `BUILD_STARTED` })
  expect(currentState.value).toEqual(`syncing`)

  workerChildMachine.send({ type: `PARTITION_ASSIGNMENT`, partitionNumber: 1 })
  expect(currentState.context.partitionNumber).toEqual(1)
  expect(currentState.value).toEqual(`syncing`)

  // Bootstrapping done
  workerChildMachine.send({ type: `BOOTSTRAPPING_DONE`, partitionCount: 20 })
  expect(currentState.value).toEqual(`building`)
  expect(currentState.context.partitionNumber).toEqual(1)
  expect(currentState.context.partitionCount).toEqual(20)

  // Build done
  workerChildMachine.send({ type: `BUILDING_DONE` })
  expect(currentState.value).toEqual(`waitingForBuild`)
  expect(currentState.context.partitionNumber).toEqual(undefined)
  expect(currentState.context.partitionCount).toEqual(undefined)
})
