/**
 * Preload-facing name for the exact shipped main RPC registry. The canonical
 * registry is shared with Electron main so the two sides cannot drift.
 */
export {
  MAIN_METHOD_TABLE as MAIN_RPC_METHOD_TABLE,
  MAIN_RPC_CONTRACT_NAME,
  MAIN_RPC_EVENT_FAMILY,
  type MainMethod,
  isMainMethod,
} from "../shared/rpc/main.js";
