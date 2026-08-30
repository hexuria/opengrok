import { boxSupportsMultiWindow } from "./box-capabilities.js";
import { LoopbackSandBox, type LoopbackSandBoxOptions } from "./loopback-sand-box.js";
import { SharedDesktopSandBox, type SharedDesktopOptions, type SharedInnerBox } from "./shared-desktop-sand-box.js";
import type { ShellAccessor } from "./box-windows.js";

export function createSandBox<Accessor extends ShellAccessor>(options: LoopbackSandBoxOptions<Accessor>): LoopbackSandBox<Accessor> { return new LoopbackSandBox(options); }
export function formatSandBoxStartupSummary(args: { autoUpdateEnabled: boolean; isPackaged: boolean }): string { return `[sand-host] agent box backend: loopback (in-box); image: host's own container; auto-update: ${args.autoUpdateEnabled ? "on" : "off"}; build: ${args.isPackaged ? "packaged" : "dev"}`; }
export function applySharedDesktop<Accessor extends ShellAccessor>(box: LoopbackSandBox<Accessor>, options?: SharedDesktopOptions<Accessor>): SharedDesktopSandBox<Accessor>;
export function applySharedDesktop<Accessor, Box extends SharedInnerBox<Accessor>>(box: Box, options: SharedDesktopOptions<Accessor> = {}): Box | SharedDesktopSandBox<Accessor> { return boxSupportsMultiWindow(box) ? new SharedDesktopSandBox(box, options) : box; }
