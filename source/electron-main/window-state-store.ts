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

function overlapWith(
  bounds: SandWindowBounds,
  workArea: SandWindowBounds,
): { readonly width: number; readonly height: number; readonly area: number } {
  const width = Math.max(
    0,
    Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x),
  );
  const height = Math.max(
    0,
    Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y),
  );
  return { width, height, area: width * height };
}

function clampToWorkArea(bounds: SandWindowBounds, workArea: SandWindowBounds): SandWindowBounds {
  const width = Math.min(Math.max(bounds.width, SAND_MIN_WINDOW_SIZE.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, SAND_MIN_WINDOW_SIZE.height), workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function isUsableWorkArea(workArea: SandWindowBounds): boolean {
  return workArea.width >= SAND_MIN_WINDOW_SIZE.width && workArea.height >= SAND_MIN_WINDOW_SIZE.height;
}

/**
 * Enough of the frame must sit on a display that a person can grab it. A 1px
 * sliver on the remaining laptop after an external display is unplugged is how
 * this app used to look like it quit on launch.
 */
export const SAND_MIN_VISIBLE_OVERLAP = { width: 100, height: 40 } as const;

function isGrabVisible(overlap: { readonly width: number; readonly height: number }): boolean {
  return overlap.width >= SAND_MIN_VISIBLE_OVERLAP.width && overlap.height >= SAND_MIN_VISIBLE_OVERLAP.height;
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
    readonly overlap: { readonly width: number; readonly height: number; readonly area: number };
  } | null = null;
  for (const workArea of workAreas) {
    const overlap = overlapWith(persisted.normalBounds, workArea);
    if (best === null || overlap.area > best.overlap.area) best = { workArea, overlap };
  }
  const usable = workAreas.filter(isUsableWorkArea);
  if (best === null || usable.length === 0) {
    // Never pass maximize through with no bounds: Electron then creates the
    // window without x/y, macOS restores the ghost display, and maximize()
    // parks it there.
    return { bounds: null, maximize: false };
  }
  const visibleOnBest = isGrabVisible(best.overlap) && isUsableWorkArea(best.workArea);
  const home = visibleOnBest
    ? best.workArea
    : usable.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const source = visibleOnBest
    ? persisted.normalBounds
    : { ...persisted.normalBounds, x: home.x, y: home.y };
  return { bounds: clampToWorkArea(source, home), maximize: persisted.isMaximized };
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
