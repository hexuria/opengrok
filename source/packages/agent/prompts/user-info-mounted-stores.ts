import { AGENT_STORE_AUTOMATION_MOUNT_NAME, AGENT_STORE_TEAM_MOUNT_NAME, AGENT_STORE_USER_MOUNT_NAME, NAMED_AGENT_HOME_STORE_MOUNT_NAME } from "../../constants/agent-store-ids.js";
import { MountedAgentStoreKind, type MountedAgentStore } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import { jsx, jsxs } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";

function describeStore(store: MountedAgentStore): string {
  const readOnlySuffix = store.readOnly ? " (read-only)" : "";
  const quotedAlias = store.alias !== undefined && store.alias.length > 0 ? ` "${store.alias}"` : "";
  switch (store.kind) {
    case MountedAgentStoreKind.SELF:
      return `Current agent's store: ${store.path}${readOnlySuffix}`;
    case MountedAgentStoreKind.PRINCIPAL:
      switch (store.alias) {
        case AGENT_STORE_USER_MOUNT_NAME:
          return `User's personal store: ${store.path}${readOnlySuffix}`;
        case AGENT_STORE_TEAM_MOUNT_NAME:
          return `Current team's shared store: ${store.path}${readOnlySuffix}`;
        case AGENT_STORE_AUTOMATION_MOUNT_NAME:
          return `Current automation's shared store: ${store.path}${readOnlySuffix}`;
        case NAMED_AGENT_HOME_STORE_MOUNT_NAME:
          return `Current named agent's shared home store: ${store.path}${readOnlySuffix}`;
        default:
          return `${store.path}${readOnlySuffix}`;
      }
    case MountedAgentStoreKind.PEER:
      return `Peer agent store${quotedAlias}: ${store.path}${readOnlySuffix}`;
    case MountedAgentStoreKind.SHARE:
      return `Shared store${quotedAlias}: ${store.path}${readOnlySuffix}`;
    default:
      return `${store.path}${readOnlySuffix}`;
  }
}

export function MountedAgentStoresSection({ stores }: { readonly stores: readonly MountedAgentStore[] }): PromptNode {
  const userStore = stores.find((store) => store.kind === MountedAgentStoreKind.PRINCIPAL && store.alias === AGENT_STORE_USER_MOUNT_NAME);
  const hasReadOnlyStores = stores.some((store) => store.readOnly);
  return jsxs("p", {
    children: [
      "Available persistent agent stores:",
      jsx("br", {}),
      stores.map((store) => `- ${describeStore(store)}`).join("\n"),
      jsx("br", {}),
      hasReadOnlyStores
        ? "Use normal file tools with these absolute paths. Stores marked (read-only) must not be written to; all other stores support reads and writes. "
        : "Use normal file tools with these absolute paths to read or write store contents. ",
      userStore !== undefined && `When the user says \"my user store\" or \"my personal store,\" use ${userStore.path}. `,
      "Only use stores listed here; omitted stores are unavailable.",
    ],
  });
}
