export function getAbortReasonInfo(reason: unknown) {
  if (reason instanceof Error) {
    return {
      abortReasonType: "error",
      abortReasonName: reason.name,
      abortReasonMessage: reason.message,
    };
  }
  if (typeof reason === "string") {
    return { abortReasonType: "string", abortReasonMessage: reason };
  }
  if (reason === void 0) {
    return { abortReasonType: "undefined" };
  }
  return { abortReasonType: typeof reason };
}
