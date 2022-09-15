import { createMachine, assign } from "xstate"
import { EventEmitter } from "events"

interface IContext {
  workersCount: number
  partionsDoneSyncingCount: number
  bus: EventEmitter
}

// TODO have a child state machine for redis — connects to
// it and relays messages back and forth
const parentMachine = createMachine<IContext>({
  id: `Parent`,
  initial: `bootstrapping`,
  context: {
    workersCount: 0,
  },
  states: {
    bootstrapping: {
      entry: [
        context =>
          context.bus.emit(`event`, {
            type: `BUILD_STARTED`,
            author: `parent`,
          }),
      ],
      on: {
        BOOTSTRAPPING_DONE: `waitingForWorkers`,
        // must have id
        // if id unique, increment count + store
        // id in workers array
        WORKER_ANNOUNCE: {
          actions: [
            context =>
              context.bus.emit(`event`, {
                type: `PARTITION_ASSIGNMENT`,
                partitionNumber: context.workersCount,
                author: `parent`,
              }),
            assign({
              workersCount: (context, _event) => (context.workersCount += 1),
            }),
          ],
        },
      },
    },
    waitingForWorkers: {
      on: {
        // TODO track when they finish and add guard which
        // prevents the transition until they're all done.
        // Assuming guards run after assignments are done
        PARTITION_DONE_SYNCING: {
          target: `waitingForWorkersToBuild`,
          cond: context =>
            context.partionsDoneSyncingCount + 1 == context.workersCount,
          actions: [
            assign({
              partionsDoneSyncingCount: context =>
                (context.partionsDoneSyncingCount += 1),
            }),
          ],
        },
      },
    },
    waitingForWorkersToBuild: {
      entry: [
        context =>
          context.bus.emit(`event`, {
            type: `START_BUILDING`,
            partitionCount: context.workersCount,
            author: `parent`,
          }),
      ],
      on: {
        PARTITION_BUILDING_FINISHED: `done`,
      },
    },
    done: {
      type: `final`,
    },
  },
})

export default parentMachine
