import { createContext, type Context } from "../packages/context/core.js";
import {
  getLoggerBackend,
  loggerKey,
  type ContextLoggerBackend,
} from "../packages/context/logger.js";

export { getLoggerBackend, loggerKey };

/**
 * Exact host/runner context construction from the two immutable class-field
 * anchors in `src/app/dist/host/host-main.cjs` (665646 and 668234).
 */
export function createProductionRunnerContext(): Context {
  const silentLogger: ContextLoggerBackend = { log: () => {} };
  return createContext().with(loggerKey, silentLogger);
}
