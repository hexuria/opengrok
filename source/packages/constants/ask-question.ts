export const ASK_QUESTION_AUTO_ANSWER_MARKER = "ask_question_auto_answer";
export const ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX = "No response was received within the time limit";
export const ASK_QUESTION_AUTO_ANSWER_REASON_BODY = `${ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX}. Proceed with the recommended option(s) you offered for each question, or your best judgment based on the information already available.`;

export type AskQuestionAutoAnswerIdentity = { marker: typeof ASK_QUESTION_AUTO_ANSWER_MARKER; kind: "timeout" | "other" };

export function createAskQuestionAutoAnswerIdentity(kind: AskQuestionAutoAnswerIdentity["kind"] = "timeout"): AskQuestionAutoAnswerIdentity {
  return { marker: ASK_QUESTION_AUTO_ANSWER_MARKER, kind };
}

export function formatAskQuestionAutoAnswerReason(identity = createAskQuestionAutoAnswerIdentity()): string {
  return `${identity.marker}:${identity.kind}|${ASK_QUESTION_AUTO_ANSWER_REASON_BODY}`;
}

export function parseAskQuestionAutoAnswerIdentity(reason: string | null | undefined): AskQuestionAutoAnswerIdentity | undefined {
  const trimmed = (reason !== null && reason !== undefined ? reason : "").trim();
  const match = trimmed.match(new RegExp(`^${ASK_QUESTION_AUTO_ANSWER_MARKER}:(timeout|other)\\|`));
  return match === null ? undefined : createAskQuestionAutoAnswerIdentity(match[1] as AskQuestionAutoAnswerIdentity["kind"]);
}

export function isAskQuestionAutoAnswerReason(reason: string | null | undefined): boolean {
  if (parseAskQuestionAutoAnswerIdentity(reason) !== undefined) return true;
  return (reason !== null && reason !== undefined ? reason : "").trim().startsWith(ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX);
}

export const ASK_QUESTION_AUTO_ANSWER_REASON = formatAskQuestionAutoAnswerReason();
