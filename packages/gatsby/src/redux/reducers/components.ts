import normalize from "../../utils/normalize-path"
import path from "path"
import { IGatsbyState, ActionsUnion } from "../types"

let programStatus = `BOOTSTRAPPING`

// TODO: replace usages of this reducer with queries.trackedComponents
//  It is here merely for compatibility.
export const componentsReducer = (
  state: IGatsbyState["components"] = new Map(),
  action: ActionsUnion
): IGatsbyState["components"] => {
  switch (action.type) {
    case `DELETE_CACHE`:
      return new Map()
    case `SET_PROGRAM_STATUS`:
      programStatus = action.payload
      return state
    case `UPSTREAM_SOURCE_DIRECTORY`: {
      // Rewrite componentPath
      const oldKeys = [...state.keys()]

      state.forEach((value, key) => {
        const newPath = path.join(
          process.cwd(),
          path.relative(action.directory, value.componentPath)
        )
        value.componentPath = newPath
        state.set(newPath, value)
      })

      console.log({ oldKeys, newKeys: [...state.keys()], action })

      oldKeys.forEach(key => state.delete(key))
      console.log({ newKeys: [...state.keys()] })

      return state
    }
    case `CREATE_PAGE`: {
      // Create XState service.
      let component = state.get(action.payload.componentPath)
      if (!component) {
        component = {
          componentPath: action.payload.componentPath,
          componentChunkName: action.payload.componentChunkName,
          query: ``,
          pages: new Set(),
          isInBootstrap: true,
          serverData: false,
          config: false,
        }
      }
      component.pages.add(action.payload.path)
      component.isInBootstrap = programStatus === `BOOTSTRAPPING`
      state.set(action.payload.componentPath, component)
      return state
    }
    case `QUERY_EXTRACTED`: {
      action.payload.componentPath = normalize(action.payload.componentPath)
      const component = state.get(action.payload.componentPath)!
      console.log(action, state.keys())
      component.query = action.payload.query
      state.set(action.payload.componentPath, component)
      return state
    }
    case `REMOVE_STATIC_QUERIES_BY_TEMPLATE`: {
      action.payload.componentPath = normalize(action.payload.componentPath)
      state.delete(action.payload.componentPath)
      return state
    }
    case `SET_COMPONENT_FEATURES`: {
      const path = normalize(action.payload.componentPath)
      const component = state.get(path)
      if (component) {
        component.serverData = action.payload.serverData
        component.config = action.payload.config
      }
      return state
    }
    case `DELETE_PAGE`: {
      console.log(`DELETE_PAGE`)
      const component = state.get(normalize(action.payload.component))!
      component.pages.delete(action.payload.path)
      return state
    }
  }

  return state
}
