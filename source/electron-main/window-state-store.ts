import { z } from "zod";

export const SAND_MIN_WINDOW_SIZE = { width: 512, height: 520 } as const;

const coordinateSchema = z.number().finite().int();
const sizeSchema = coordinateSchema.positive();
const windowStateSchema = z.object({
  version: z.literal(1),
  normalBounds: z.object({
    x: coordinateSchema,
    y: coordinateSchema,
    width: sizeSchema,
    height: sizeSchema,
  }),
  isMaximized: z.boolean(),
});

export type SandWindowState = z.infer<typeof windowStateSchema>;
export type SandWindowBounds = SandWindowState["normalBounds"];

export function parsePersistedSandWindowState(value: unknown): SandWindowState | null {
  const parsed = windowStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function resolveSandWindowLaunchPlacement(args: {
  readonly persisted: SandWindowState | null;
  readonly workAreas: readonly SandWindowBounds[];
}): { readonly bounds: SandWindowBounds | null; readonly maximize: boolean } {
  const { persisted, workAreas } = args;
  if (persisted === null || workAreas.length === 0) {
    return { bounds: null, maximize: false };
  }
  let best: {
    readonly workArea: SandWindowBounds;
    readonly overlapWidth: number;
    readonly overlapHeight: number;
    readonly area: number;
  } | null = null;
  for (const workArea of workAreas) {
    const overlapWidth = Math.max(
      0,
      Math.min(
        persisted.normalBounds.x + persisted.normalBounds.width,
        workArea.x + workArea.width,
      ) - Math.max(persisted.normalBounds.x, workArea.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(
        persisted.normalBounds.y + persisted.normalBounds.height,
        workArea.y + workArea.height,
      ) - Math.max(persisted.normalBounds.y, workArea.y),
    );
    const area = overlapWidth * overlapHeight;
    if (best === null || area > best.area) {
      best = { workArea, overlapWidth, overlapHeight, area };
    }
  }
  if (
    best === null ||
    best.overlapWidth < 100 ||
    best.overlapHeight < 40 ||
    best.workArea.width < SAND_MIN_WINDOW_SIZE.width ||
    best.workArea.height < SAND_MIN_WINDOW_SIZE.height
  ) {
    return { bounds: null, maximize: persisted.isMaximized };
  }
  const width = Math.min(
    Math.max(persisted.normalBounds.width, SAND_MIN_WINDOW_SIZE.width),
    best.workArea.width,
  );
  const height = Math.min(
    Math.max(persisted.normalBounds.height, SAND_MIN_WINDOW_SIZE.height),
    best.workArea.height,
  );
  const x = Math.min(
    Math.max(persisted.normalBounds.x, best.workArea.x),
    best.workArea.x + best.workArea.width - width,
  );
  const y = Math.min(
    Math.max(persisted.normalBounds.y, best.workArea.y),
    best.workArea.y + best.workArea.height - height,
  );
  return { bounds: { x, y, width, height }, maximize: persisted.isMaximized };
}

export interface SandWindowStateStoreIo {
  readonly readTextFile: () => string | null;
  readonly writeTextFile: (text: string) => Promise<void>;
  readonly reportFailure: (stage: "parse" | "write", error: unknown) => void;
}

export class SandWindowStateStore {
  private writeInFlight = false;
  private trailingText: string | null = null;

  public constructor(private readonly io: SandWindowStateStoreIo) {}

  public load(): SandWindowState | null {
    const text = this.io.readTextFile();
    if (text === null) return null;
    try {
      const state = parsePersistedSandWindowState(JSON.parse(text) as unknown);
      if (state === null) {
        this.io.reportFailure("parse", new Error("schema validation failed"));
      }
      return state;
    } catch (error) {
      this.io.reportFailure("parse", error);
      return null;
    }
  }

  public note(state: SandWindowState): void {
    const text = JSON.stringify(state, null, 2);
    if (this.writeInFlight) {
      this.trailingText = text;
      return;
    }
    this.startWrite(text);
  }

  private startWrite(text: string): void {
    this.writeInFlight = true;
    void this.io
      .writeTextFile(text)
      .catch((error: unknown) => this.io.reportFailure("write", error))
      .finally(() => {
        this.writeInFlight = false;
        const trailingText = this.trailingText;
        this.trailingText = null;
        if (trailingText !== null) this.startWrite(trailingText);
      });
  }
}
