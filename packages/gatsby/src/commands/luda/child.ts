import { createMachine, assign } from "xstate"
import { EventEmitter } from "events"

interface IContext {
  partitionNumber: number
  partitionCount: number
  bus: EventEmitter
}

const workerManagerMachine = createMachine<IContext>({
  id: `workerManager`,
  initial: `waitingForBuild`,
  context: {
    // partitionNumber: ,
  },
  states: {
    waitingForBuild: {
      on: {
        BUILD_STARTED: `syncing`,
      },
    },
    syncing: {
      entry: [
        context =>
          context.bus.emit(`event`, {
            type: `WORKER_ANNOUNCE`,
            author: `child`,
          }),
      ],
      on: {
        // This is the last event which is sent from parent during
        // bootstrapping so we report back to parent that we got it.
        BOOTSTRAPPING_DONE: {
          actions: [
            context =>
              context.bus.emit(`event`, {
                type: `PARTITION_DONE_SYNCING`,
                author: `child`,
              }),
          ],
        },
        START_BUILDING: {
          target: `building`,
          actions: assign({
            partitionCount: (_, event) => event.partitionCount,
          }),
        },
        PARTITION_ASSIGNMENT: {
          actions: assign({
            partitionNumber: (_, event) => event.partitionNumber,
          }),
        },
      },
    },
    building: {
      exit: [
        assign({
          partitionNumber: undefined,
          partitionCount: undefined,
        }),
      ],
      on: {
        PARTITION_BUILDING_FINISHED: {
          actions: [
            context =>
              context.bus.emit(`event`, {
                type: `PARTITION_BUILDING_FINISHED`,
                author: `child`,
              }),
          ],
        },
        BUILDING_DONE: `waitingForBuild`,
      },
    },
  },
})

export default workerManagerMachine
