export const SUDO_ALIAS = "alias sudo='sudo -A'";
const isWindows = process.platform === "win32";
export const shouldEnableSudoAskpass = (env: NodeJS.ProcessEnv): boolean => !isWindows && Boolean(env.SUDO_ASKPASS);
export const getSudoAliasInjection = (env: NodeJS.ProcessEnv): string => shouldEnableSudoAskpass(env) ? `${SUDO_ALIAS}; ` : "";
export function transformSudoCommand(command: string): string {
  const result: string[] = [];
  let index = 0;
  while (index < command.length) {
    const isCommandStart = index === 0 || command.slice(Math.max(0, index - 2), index) === "&&" || command.slice(Math.max(0, index - 2), index) === "||" || command[index - 1] === "|" || command[index - 1] === ";";
    const lookback = command.slice(Math.max(0, index - 10), index);
    const isAfterOperator = /(?:&&|\|\||[|;])\s*$/.test(lookback) || (index === 0 && /^\s*$/.test(lookback));
    if ((isCommandStart || isAfterOperator) && command.slice(index, index + 4) === "sudo") {
      const afterSudo = index + 4;
      if (afterSudo >= command.length || /\s/.test(command[afterSudo]!)) {
        let flagStart = afterSudo;
        while (flagStart < command.length && /\s/.test(command[flagStart]!)) flagStart += 1;
        let hasAFlag = false;
        if (command[flagStart] === "-") {
          let flagEnd = flagStart + 1;
          while (flagEnd < command.length && /[^\s]/.test(command[flagEnd]!)) flagEnd += 1;
          hasAFlag = /^-[a-zA-Z]*A[a-zA-Z]*$/.test(command.slice(flagStart, flagEnd));
        }
        result.push(hasAFlag ? "sudo" : "sudo -A");
        index = afterSudo;
        continue;
      }
    }
    result.push(command[index]!);
    index += 1;
  }
  return result.join("");
}
