import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolutionConfig } from "./scaling.js";

const execFileAsync = promisify(execFile);
export const API_WIDTH = 1280;

export interface DisplayInfo { width: number; height: number; refreshRate: number }

export function parseDisplayNum(display: string): number {
  const colonIndex = display.lastIndexOf(":");
  if (colonIndex === -1) throw new Error(`Invalid X11 display string: ${display} (missing ':')`);
  const numStr = display.slice(colonIndex + 1).split(".")[0]!;
  const num = Number.parseInt(numStr, 10);
  if (!Number.isFinite(num) || num < 0) throw new Error(`Invalid X11 display number in: ${display} (parsed: ${numStr})`);
  return num;
}

export function parseXrandrOutput(output: string): DisplayInfo {
  let width: number | undefined;
  let height: number | undefined;
  let refreshRate: number | undefined;
  for (const line of output.split("\n")) {
    if (line.includes("*")) {
      const resolution = line.trim().match(/^(\d+)x(\d+)/);
      if (resolution?.[1] !== undefined && resolution[2] !== undefined) {
        width = Number.parseInt(resolution[1], 10);
        height = Number.parseInt(resolution[2], 10);
      }
      const rateMatch = line.match(/(\d+(?:\.\d+)?)\*(?:\+)?/);
      if (rateMatch?.[1] !== undefined) {
        const rate = Number.parseFloat(rateMatch[1]);
        if (rate > 0 && rate <= 500) refreshRate = Math.round(rate);
      }
      if (width && height) break;
    }
  }
  if (!width || !height) {
    const current = output.match(/current\s+(\d+)\s*x\s*(\d+)/i);
    if (current?.[1] !== undefined && current[2] !== undefined) {
      width = Number.parseInt(current[1], 10);
      height = Number.parseInt(current[2], 10);
    }
  }
  if (!width || !height) {
    throw new Error(`Could not detect display resolution from xrandr output.\nExpected a line with '*' indicating active mode, or 'current WxH'.\nxrandr output:\n${output}`);
  }
  if (!refreshRate) refreshRate = 60;
  return { width, height, refreshRate };
}

export function buildResolutionConfig(displayWidth: number, displayHeight: number): ResolutionConfig {
  return {
    display: { width: displayWidth, height: displayHeight },
    api: { width: API_WIDTH, height: Math.round(API_WIDTH / (displayWidth / displayHeight)) },
  };
}

export async function detectDisplay(display: string): Promise<{ display: DisplayInfo; resolution: ResolutionConfig; resolutionString: string }> {
  const { stdout } = await execFileAsync("xrandr", ["--display", display], { timeout: 5_000 });
  const info = parseXrandrOutput(stdout);
  return { display: info, resolution: buildResolutionConfig(info.width, info.height), resolutionString: `${info.width}x${info.height}` };
}
