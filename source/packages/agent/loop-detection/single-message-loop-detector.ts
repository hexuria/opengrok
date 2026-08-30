export interface SingleMessageLoopDetectorConfig {
  multiLineLoopMinRepetitions(): number;
  multiLineLoopMinRepetitionsInCodeFence(): number;
  maxLineLength(): number;
  maxCheckTimeMs(): number;
  singleLineLoopMinRepetitions(): number;
  singleLineLoopMinRepetitionsInCodeFence(): number;
  singleLineLoopMinPTimesK(): number;
  singleLineLoopMinPTimesKInCodeFence(): number;
  singleLineLoopMaxP(): number;
  multiLineLoopMinPTimesK(): number;
  multiLineLoopMinPTimesKInCodeFence(): number;
  multiLineLoopMinTotalChars(): number;
  multiLineLoopMinTotalCharsInCodeFence(): number;
}

export interface SingleMessageLoopDetectorHooks {
  onSingleLineCheck?(event: { latencyMs: number; result: string; caller: string }): void;
  onMultiLineCheck?(event: { latencyMs: number; result: string; caller: string }): void;
  onTimeout?(event: { latencyMs: number; phase: string; caller: string }): void;
}

const BOX_DRAWING_CHARS = new Set([
  "─", "━", "═", "-", "_",
  "│", "┃", "║", "|",
  "┌", "┐", "└", "┘", "╔", "╗", "╚", "╝", "┏", "┓", "┗", "┛", "╓", "╖", "╙", "╜",
  "├", "┤", "┬", "┴", "┼", "╟", "╢", "╤", "╧", "╫", "╠", "╣", "╦", "╩", "╬", "╞", "╡", "╥", "╨", "╪",
  "+",
]);

interface SingleLineLoop {
  start: number;
  period: number;
  repetitions: number;
  root: string;
}

export class SingleMessageLoopDetector {
  declare readonly config: SingleMessageLoopDetectorConfig;
  declare readonly hooks: SingleMessageLoopDetectorHooks | undefined;
  declare currentLine: string;
  declare insideCodeFence: boolean;
  declare startIdx: number;
  declare lineCount: number;
  declare detectedMultiLinePattern: string[] | null;
  declare multiLinePeriodMatchRunLengths: number[];
  declare detectedSingleLineLoop: SingleLineLoop | null;
  declare periodMatchRunLengths: number[];
  declare didTimeout: boolean;
  declare readonly MULTI_LINE_LOOP_MIN_REPETITIONS: number;
  declare readonly MAX_LINE_LENGTH: number;
  declare readonly MAX_CHECK_TIME_MS: number;
  declare readonly MAX_LINE_QUEUE_SIZE: number;
  declare readonly SINGLE_LINE_LOOP_MIN_REPETITIONS: number;
  declare readonly SINGLE_LINE_LOOP_MIN_P_TIMES_K: number;
  declare readonly SINGLE_LINE_LOOP_MAX_P_LIMIT: number;
  declare readonly lineBuffer: string[];

  constructor(config: SingleMessageLoopDetectorConfig, hooks?: SingleMessageLoopDetectorHooks) {
    this.config = config;
    this.hooks = hooks;
    this.currentLine = "";
    this.insideCodeFence = false;
    this.startIdx = 0;
    this.lineCount = 0;
    this.detectedMultiLinePattern = null;
    this.multiLinePeriodMatchRunLengths = [];
    this.detectedSingleLineLoop = null;
    this.periodMatchRunLengths = [];
    this.didTimeout = false;
    const configuredMaxCheckTimeMs = this.config.maxCheckTimeMs();
    this.MULTI_LINE_LOOP_MIN_REPETITIONS = this.config.multiLineLoopMinRepetitions();
    this.MAX_LINE_LENGTH = this.config.maxLineLength();
    this.MAX_CHECK_TIME_MS = configuredMaxCheckTimeMs > 0 ? configuredMaxCheckTimeMs : Number.POSITIVE_INFINITY;
    this.MAX_LINE_QUEUE_SIZE = 50 * this.MULTI_LINE_LOOP_MIN_REPETITIONS;
    this.SINGLE_LINE_LOOP_MIN_REPETITIONS = this.config.singleLineLoopMinRepetitions();
    this.SINGLE_LINE_LOOP_MIN_P_TIMES_K = this.config.singleLineLoopMinPTimesK();
    this.SINGLE_LINE_LOOP_MAX_P_LIMIT = this.config.singleLineLoopMaxP();
    this.lineBuffer = new Array(this.MAX_LINE_QUEUE_SIZE);
    this.periodMatchRunLengths = new Array(this.SINGLE_LINE_LOOP_MAX_P_LIMIT + 1).fill(0);
    this.multiLinePeriodMatchRunLengths = new Array(this.MAX_LINE_QUEUE_SIZE + 1).fill(0);
  }

  loopDetected(): boolean {
    return this.detectedSingleLineLoop !== null || this.detectedMultiLinePattern !== null;
  }

  timedOut(): boolean {
    return this.didTimeout;
  }

  isBoxBorderLine(line: string): boolean {
    let boxCharCount = 0;
    let totalNonWhitespace = 0;
    for (const char of line) {
      if (char !== " " && char !== "\t") totalNonWhitespace++;
      if (BOX_DRAWING_CHARS.has(char)) boxCharCount++;
    }
    if (totalNonWhitespace === 0) return false;
    return boxCharCount / totalNonWhitespace >= 0.8;
  }

  addText({ newText, caller }: { newText: string; caller: string }): boolean {
    if (this.loopDetected() || this.didTimeout) return this.loopDetected();
    const deadlineMs = performance.now() + this.MAX_CHECK_TIME_MS;
    for (const char of newText) {
      if (char === "\n") {
        this.updateCodeFenceStateOnLineEnd(this.currentLine);
        if (this.currentLine.trim().length > 0 && !this.isBoxBorderLine(this.currentLine)) {
          this.addLineToQueue(this.currentLine);
          const detectedPattern = this.checkForMultiLineLoop({ caller, deadlineMs });
          if (this.didTimeout) return false;
          if (detectedPattern !== null) {
            this.detectedMultiLinePattern = detectedPattern;
            return true;
          }
        }
        this.currentLine = "";
        this.periodMatchRunLengths.fill(0);
      } else {
        if (this.currentLine.length >= this.MAX_LINE_LENGTH) continue;
        this.currentLine += char;
        const startTime = performance.now();
        if (!this.isBoxBorderLine(this.currentLine) && !/\s/.test(char)) {
          const pos = this.currentLine.length - 1;
          const maxP = Math.min(this.SINGLE_LINE_LOOP_MAX_P_LIMIT, pos);
          const minReps = this.insideCodeFence ? this.config.singleLineLoopMinRepetitionsInCodeFence() : this.SINGLE_LINE_LOOP_MIN_REPETITIONS;
          const minPTimesK = this.insideCodeFence ? this.config.singleLineLoopMinPTimesKInCodeFence() : this.SINGLE_LINE_LOOP_MIN_P_TIMES_K;
          for (let p = 1; p <= maxP; p++) {
            if ((p & 31) === 0 && this.markTimedOutIfNeeded({ caller, deadlineMs, phase: "single_line", startTime })) return false;
            if (this.currentLine[pos] === this.currentLine[pos - p]) {
              const matched = ++this.periodMatchRunLengths[p]!;
              const repetitions = Math.floor(matched / p) + 1;
              const pTimesK = p * repetitions;
              if (repetitions >= minReps && pTimesK >= minPTimesK) {
                this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startTime, result: "loop_detected_single_line_substring", caller });
                const root = this.currentLine.slice(this.currentLine.length - p, this.currentLine.length);
                this.detectedSingleLineLoop = { start: this.currentLine.length - p, period: p, repetitions, root };
                return true;
              }
            } else {
              this.periodMatchRunLengths[p] = 0;
            }
          }
          this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startTime, result: "no_loop_detected_single_line_substring", caller });
        }
      }
    }
    return false;
  }

  addLineToQueue(line: string): void {
    const insertIdx = (this.startIdx + this.lineCount) % this.MAX_LINE_QUEUE_SIZE;
    this.lineBuffer[insertIdx] = line;
    if (this.lineCount < this.MAX_LINE_QUEUE_SIZE) this.lineCount++;
    else this.startIdx = (this.startIdx + 1) % this.MAX_LINE_QUEUE_SIZE;
  }

  getLineAt(logicalIndex: number): string {
    const physicalIndex = (this.startIdx + logicalIndex) % this.MAX_LINE_QUEUE_SIZE;
    return this.lineBuffer[physicalIndex]!;
  }

  checkForMultiLineLoop({ caller, deadlineMs }: { caller: string; deadlineMs: number }): string[] | null {
    const startTime = performance.now();
    const currentLine = this.getLineAt(this.lineCount - 1);
    const maxPeriod = Math.min(this.lineCount - 1, this.MAX_LINE_QUEUE_SIZE - 1);
    for (let p = 1; p <= maxPeriod; p++) {
      if ((p & 7) === 0 && this.markTimedOutIfNeeded({ caller, deadlineMs, phase: "multi_line", startTime })) return null;
      const priorIndex = this.lineCount - 1 - p;
      const priorLine = this.getLineAt(priorIndex);
      if (currentLine === priorLine) {
        const matched = ++this.multiLinePeriodMatchRunLengths[p]!;
        const repetitions = Math.floor(matched / p) + 1;
        const pTimesK = p * repetitions;
        const insideFence = this.insideCodeFence;
        const minReps = insideFence ? this.config.multiLineLoopMinRepetitionsInCodeFence() : this.MULTI_LINE_LOOP_MIN_REPETITIONS;
        const minPTimesK = insideFence ? this.config.multiLineLoopMinPTimesKInCodeFence() : this.config.multiLineLoopMinPTimesK();
        const minTotalChars = insideFence ? this.config.multiLineLoopMinTotalCharsInCodeFence() : this.config.multiLineLoopMinTotalChars();
        if (repetitions >= minReps && pTimesK >= minPTimesK) {
          const pattern: string[] = [];
          const startOfRoot = this.lineCount - 1 - p + 1;
          for (let j = startOfRoot; j < this.lineCount; j++) pattern.push(this.getLineAt(j));
          const rootChars = pattern.reduce((sum, line) => sum + line.length, 0);
          const totalRepeatedChars = rootChars * repetitions;
          if (totalRepeatedChars < minTotalChars) continue;
          this.detectedMultiLinePattern = pattern;
          this.hooks?.onMultiLineCheck?.({ latencyMs: performance.now() - startTime, result: "loop_detected", caller });
          return pattern;
        }
      } else {
        this.multiLinePeriodMatchRunLengths[p] = 0;
      }
    }
    this.hooks?.onMultiLineCheck?.({ latencyMs: performance.now() - startTime, result: "no_loop_detected", caller });
    return null;
  }

  markTimedOutIfNeeded({ caller, deadlineMs, phase, startTime }: { caller: string; deadlineMs: number; phase: string; startTime: number }): boolean {
    if (this.didTimeout) return true;
    if (performance.now() < deadlineMs) return false;
    this.didTimeout = true;
    this.hooks?.onTimeout?.({ latencyMs: performance.now() - startTime, phase, caller });
    return true;
  }

  updateCodeFenceStateOnLineEnd(line: string): void {
    if (line.length === 0) return;
    const matches = line.match(/```+(?!`)/g);
    if (!matches || matches.length === 0) return;
    if (matches.length % 2 === 1) this.insideCodeFence = !this.insideCodeFence;
  }

  getSingleLineLoopInfo(): { pattern: string; repetitions: number; period: number } | null {
    if (!this.detectedSingleLineLoop) return null;
    return { pattern: this.detectedSingleLineLoop.root, repetitions: this.detectedSingleLineLoop.repetitions, period: this.detectedSingleLineLoop.period };
  }

  getMultiLineLoopInfo(): { pattern: string; repetitions: number } | null {
    if (!this.detectedMultiLinePattern) return null;
    return { pattern: this.detectedMultiLinePattern.join("\n"), repetitions: this.MULTI_LINE_LOOP_MIN_REPETITIONS };
  }

  reset(): void {
    this.currentLine = "";
    this.insideCodeFence = false;
    this.didTimeout = false;
    this.lineCount = 0;
    this.startIdx = 0;
    this.detectedMultiLinePattern = null;
    this.detectedSingleLineLoop = null;
    this.periodMatchRunLengths.fill(0);
    this.multiLinePeriodMatchRunLengths.fill(0);
  }
}
