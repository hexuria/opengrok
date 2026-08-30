import { createKey } from "../context/core.js";
export const execHookConversationIdKey = createKey<string | undefined>(Symbol("execHookConversationId"), undefined);
export const execHookGenerationIdKey = createKey<string | undefined>(Symbol("execHookGenerationId"), undefined);
export const execHookModelKey = createKey<string | undefined>(Symbol("execHookModel"), undefined);
export const execHookWorkspaceRootsKey = createKey<readonly string[] | undefined>(Symbol("execHookWorkspaceRoots"), undefined);
