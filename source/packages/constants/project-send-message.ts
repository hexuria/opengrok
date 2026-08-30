export function isProjectSendMessageEnabled(state: { isRootProjectConversation?: boolean }): boolean {
  return state.isRootProjectConversation === true;
}
