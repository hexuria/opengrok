import { createLogger } from "../../context/logger.js";

// Module initialization creates the default manager logger even though the
// retained host closure tree-shakes every manager declaration.
const logger = createLogger("ControlledConversationActionManager");
void logger;
