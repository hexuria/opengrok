import type { Context } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";

const logger = createLogger("RemoteConversationActionManager");
void logger;

export class NoopConversationActionReceiver {
  async pop(_context: Context): Promise<undefined> {
    return undefined;
  }

  async peek(_context: Context): Promise<undefined> {
    return undefined;
  }
}
