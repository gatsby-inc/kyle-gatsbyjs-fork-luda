import { createMachine, assign } from "xstate"
import { EventEmitter } from "events"

interface IContext {
  id: string
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
            id: context.id,
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
                id: context.id,
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
            partitionNumber: (context, event) => {
              if (context.id == event.workerId) {
                return event.partitionNumber
              } else {
                return context.partitionNumber
              }
            },
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
        FINISHED_BUILDING: {
          target: `waitingForBuild`,
          actions: [
            context =>
              context.bus.emit(`event`, {
                type: `PARTITION_BUILDING_FINISHED`,
                id: context.id,
                author: `child`,
              }),
          ],
        },
      },
    },
  },
})

export default workerManagerMachine
