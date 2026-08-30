import type { SandboxRule } from "../shell-core.js";

export class MockIgnoreService {
  isCursorIgnored(_path: string): Promise<boolean> { return Promise.resolve(false); } isGitIgnored(_path: string): Promise<boolean> { return Promise.resolve(false); } isIgnoredByAny(_path: string): Promise<boolean> { return Promise.resolve(false); }
  listCursorIgnoreFilesByRoot(_root: string): Promise<never[]> { return Promise.resolve([]); } isRepoBlocked(_path: string): Promise<boolean> { return Promise.resolve(false); }
  getCursorIgnoreMapping(): Promise<Record<string, never>> { return Promise.resolve({}); } getGitIgnoreMapping(): Promise<Record<string, never>> { return Promise.resolve({}); } getRepoBlockExcludeGlobs(_root: string): Promise<never[]> { return Promise.resolve([]); }
}
export class MockPermissionsService {
  private shouldBlockShellCommandImpl: (_ctx: unknown, _command: string, _options: unknown, requestedPolicy?: SandboxRule) => Promise<{ kind: "allow"; policy: SandboxRule }> = async (_ctx, _command, _options, requestedPolicy) => ({ kind: "allow", policy: requestedPolicy ?? { type: "insecure_none" } });
  private shouldEnforceShellInvariantBlocksImpl: (_ctx: unknown, _options: unknown, _requestedPolicy?: SandboxRule) => Promise<{ kind: "allow" }> = async () => ({ kind: "allow" });
  private isShellCommandFullyAllowlistedImpl: (_ctx: unknown, _command: string, _options: unknown) => Promise<boolean> = async () => false;
  private isMcpFullyAllowlistedImpl: (_ctx: unknown, _options: unknown) => Promise<boolean> = async () => false;
  shouldBlockRead(_path: string): Promise<boolean> { return Promise.resolve(false); }
  shouldBlockWrite(_ctx: unknown, _path: string, _newContents: string): Promise<boolean> { return Promise.resolve(false); }
  shouldBlockShellCommand(ctx: unknown, command: string, options: unknown, requestedPolicy?: SandboxRule): Promise<{ kind: "allow"; policy: SandboxRule }> { return this.shouldBlockShellCommandImpl(ctx, command, options, requestedPolicy); }
  shouldEnforceShellInvariantBlocks(ctx: unknown, options: unknown, requestedPolicy?: SandboxRule): Promise<{ kind: "allow" }> { return this.shouldEnforceShellInvariantBlocksImpl(ctx, options, requestedPolicy); }
  setShouldEnforceShellInvariantBlocks(impl: typeof this.shouldEnforceShellInvariantBlocksImpl): void { this.shouldEnforceShellInvariantBlocksImpl = impl; }
  isShellCommandFullyAllowlisted(ctx: unknown, command: string, options: unknown): Promise<boolean> { return this.isShellCommandFullyAllowlistedImpl(ctx, command, options); }
  setIsShellCommandFullyAllowlisted(impl: typeof this.isShellCommandFullyAllowlistedImpl): void { this.isShellCommandFullyAllowlistedImpl = impl; }
  shouldBlockMcp(_ctx: unknown, _args: unknown): Promise<boolean> { return Promise.resolve(false); }
  isMcpFullyAllowlisted(ctx: unknown, options: unknown): Promise<boolean> { return this.isMcpFullyAllowlistedImpl(ctx, options); }
  isWebFetchFullyAllowlisted(_ctx: unknown, _options: unknown): Promise<boolean> { return Promise.resolve(false); }
  setIsMcpFullyAllowlisted(impl: typeof this.isMcpFullyAllowlistedImpl): void { this.isMcpFullyAllowlistedImpl = impl; }
  addToAllowList(_ctx: unknown, _kind: unknown, _value: unknown): Promise<void> { return Promise.resolve(); }
  addToDenyList(_ctx: unknown, _kind: unknown, _value: unknown): Promise<void> { return Promise.resolve(); }
  setShouldBlockShellCommand(impl: typeof this.shouldBlockShellCommandImpl): void { this.shouldBlockShellCommandImpl = impl; }
}
