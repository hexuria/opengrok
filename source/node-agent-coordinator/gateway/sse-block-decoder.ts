const LF = 10;

export class SseBlockDecoder {
  private readonly decoder = new TextDecoder();
  private readonly parts: string[] = [];
  private prevEndedWithLf = false;

  constructor(private readonly onBlock: (block: string) => void) {}

  push(bytes: Uint8Array): void {
    const chunk = this.decoder.decode(bytes, { stream: true });
    if (chunk.length === 0) return;
    let start = 0;
    if (this.prevEndedWithLf && chunk.charCodeAt(0) === LF) {
      const joined = this.parts.length === 1 ? this.parts[0] ?? "" : this.parts.join("");
      this.onBlock(joined.slice(0, joined.length - 1));
      this.parts.length = 0;
      start = 1;
    }
    let separator = chunk.indexOf("\n\n", start);
    while (separator >= 0) {
      if (this.parts.length === 0) this.onBlock(chunk.slice(start, separator));
      else {
        this.parts.push(chunk.slice(start, separator));
        this.onBlock(this.parts.join(""));
        this.parts.length = 0;
      }
      start = separator + 2;
      separator = chunk.indexOf("\n\n", start);
    }
    const tail = start === 0 ? chunk : chunk.slice(start);
    if (tail.length > 0) this.parts.push(tail);
    const last = this.parts.length > 0 ? this.parts[this.parts.length - 1] ?? "" : "";
    this.prevEndedWithLf = last.length > 0 && last.charCodeAt(last.length - 1) === LF;
  }
}
