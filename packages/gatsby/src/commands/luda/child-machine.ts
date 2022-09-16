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
  initial: `idle`,
  context: {
    // partitionNumber: ,
  },
  on: {
    BUILD_STARTED: `syncing`,
  },
  states: {
    idle: {
      entry: [
        assign({
          partitionNumber: undefined,
          partitionCount: undefined,
        }),
      ],
    },
    syncing: {
      entry: [
        assign({
          partitionNumber: undefined,
          partitionCount: undefined,
        }),
        context =>
          context.bus.emit(`event`, {
            type: `WORKER_ANNOUNCE`,
            id: context.id,
            author: `child`,
          }),
      ],
      invoke: {
        id: `syncToGatsby`,
        src: (context, event) => (callback, onReceive) => {
          // This will send the 'INC' event to the parent every second
          // const id = setInterval(() => callback(`INC`), 1000)
          // // Perform cleanup
          // return () => clearInterval(id)
        },
      },
      on: {
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
      },
    },
    building: {
      invoke: {
        id: `buildPages`,
        src: context => context.gatsbyController.buildPages(),
        onDone: {
          target: `idle`,
          actions: [
            context =>
              context.bus.emit(`event`, {
                type: `PARTITION_BUILDING_FINISHED`,
                id: context.id,
                author: `child`,
              }),
          ],
        },
        onError: {},
      },
    },
  },
})

export default workerManagerMachine
