import { createMachine, assign } from "xstate"
import { EventEmitter } from "events"

interface IWorker {
  id: string
  doneSyncing: boolean
  doneBuilding: boolean
}

interface IContext {
  workersCount: number
  workers: Array<IWorker>
  partionsDoneSyncingCount: number
  partionsDoneBuildingCount: number
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
        BOOTSTRAPPING_DONE: `waitingForWorkersToFinishSyncing`,
        // must have id
        // if id unique, increment count + store
        // id in workers array
        WORKER_ANNOUNCE: {
          actions: [
            (context, event) =>
              context.bus.emit(`event`, {
                type: `PARTITION_ASSIGNMENT`,
                workerId: event.id,
                partitionNumber: context.workersCount,
                author: `parent`,
              }),
            assign({
              workersCount: (context, _event) => (context.workersCount += 1),
              workers: (context, event) => {
                context.workers.push({ id: event.id })
                return context.workers
              },
            }),
          ],
        },
      },
    },
    waitingForWorkersToFinishSyncing: {
      on: {
        PARTITION_DONE_SYNCING: {
          actions: [
            assign({
              partionsDoneSyncingCount: (context, event) => {
                const worker = context.workers.find(w => w.id === event.id)
                if (worker) {
                  return (context.partionsDoneSyncingCount += 1)
                } else {
                  return context.partionsDoneSyncingCount
                }
              },
              workers: (context, event) => {
                const worker = context.workers.find(w => w.id === event.id)
                if (worker) {
                  worker.doneSyncing = true
                }
                return context.workers
              },
            }),
          ],
        },
        // TODO track when they finish and add guard which
        // prevents the transition until they're all done.
        // Assuming guards run after assignments are done
        "": {
          target: `waitingForWorkersToBuild`,
          cond: (context, event) =>
            context.workersCount > 0 &&
            context.partionsDoneSyncingCount == context.workersCount,
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
        PARTITION_BUILDING_FINISHED: {
          actions: [
            assign({
              partionsDoneBuildingCount: (context, event) => {
                const worker = context.workers.find(w => w.id === event.id)
                if (worker) {
                  return (context.partionsDoneBuildingCount += 1)
                } else {
                  return context.partionsDoneBuildingCount
                }
              },
              workers: (context, event) => {
                const worker = context.workers.find(w => w.id === event.id)
                if (worker) {
                  worker.doneBuilding = true
                }
                return context.workers
              },
            }),
          ],
        },
        "": {
          target: `done`,
          cond: context =>
            context.partionsDoneBuildingCount == context.workersCount,
        },
      },
    },
    done: {
      on: {
        SOMETHING: `done`,
      },
      // type: `final`,
    },
  },
})

export default parentMachine
