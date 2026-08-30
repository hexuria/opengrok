type SlackV1_5ThreadBoundSessionProps = {
  readonly isSlackV1_5?: boolean | undefined;
  readonly namedAgentSessionKind?: string | undefined;
};

export function isSlackV1_5ThreadBoundSession(
  props: SlackV1_5ThreadBoundSessionProps,
): boolean {
  if (props.isSlackV1_5 !== true) {
    return false;
  }
  const sessionKind = props.namedAgentSessionKind?.trim() ?? "";
  return sessionKind === "" || sessionKind === "slack_thread";
}
