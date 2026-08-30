import {
  type SandAutoReviewController,
  type SandAutoReviewExpiryPolicy,
} from "./sand-auto-review.js";
import {
  describeSandMcpAutoReviewAction,
  describeSandShellAutoReviewAction,
  summarizeSandMcpAutoReviewAction,
} from "./sand-auto-review-summaries.js";

export interface ShellApprovalTarget {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly description?: string;
  readonly blockReason: string;
  readonly proposedAllowRule?: string;
}

export interface ShellApprovalRequest {
  readonly target: ShellApprovalTarget;
  readonly fingerprint: string;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}

export function createSandShellApprovalProvider(args: {
  readonly controller: Pick<SandAutoReviewController, "requestApproval">;
  readonly agentId: string;
  readonly surface: "host_shell" | "box_shell";
  readonly getExpiryPolicy: () => SandAutoReviewExpiryPolicy;
  readonly beforeApproval?: (args: {
    readonly toolCallId: string;
    readonly signal?: AbortSignal;
    readonly command: string;
    readonly description?: string;
  }) => Promise<{ readonly allowed: boolean; readonly reason?: string }>;
}) {
  return {
    async requestApproval(request: ShellApprovalRequest) {
      const description = request.target.description?.trim();
      if (args.beforeApproval != null) {
        const prior = await args.beforeApproval({
          toolCallId: request.toolCallId,
          ...(request.signal == null ? {} : { signal: request.signal }),
          command: request.target.command,
          ...(description == null || description.length === 0 ? {} : { description }),
        });
        if (!prior.allowed) {
          return { approved: false as const, reason: prior.reason };
        }
      }
      return args.controller.requestApproval({
        agentId: args.agentId,
        surface: args.surface,
        fingerprint: request.fingerprint,
        reason: request.target.blockReason,
        summary: describeSandShellAutoReviewAction({
          surface: args.surface,
          ...(request.target.workingDirectory == null
            ? {}
            : { workingDirectory: request.target.workingDirectory }),
          ...(description == null || description.length === 0 ? {} : { description }),
        }),
        command: request.target.command,
        ...(request.target.proposedAllowRule == null
          ? {}
          : { proposedRule: request.target.proposedAllowRule }),
        ...(request.signal == null ? {} : { signal: request.signal }),
        expiryPolicy: args.getExpiryPolicy(),
      });
    },
  };
}

export interface McpApprovalRequest {
  readonly fingerprint: string;
  readonly signal?: AbortSignal;
  readonly target: {
    readonly blockReason: string;
    readonly serverDisplayName: string;
    readonly toolName: string;
    readonly mcpArguments?: unknown;
    readonly description?: string;
    readonly proposedAllowRule?: string;
  };
}

export function createSandMcpApprovalProvider(args: {
  readonly controller: Pick<SandAutoReviewController, "requestApproval">;
  readonly agentId: string;
  readonly getExpiryPolicy: () => SandAutoReviewExpiryPolicy;
}) {
  return {
    requestApproval(request: McpApprovalRequest) {
      const description = request.target.description?.trim();
      return args.controller.requestApproval({
        agentId: args.agentId,
        surface: "mcp",
        fingerprint: request.fingerprint,
        reason: request.target.blockReason,
        summary: describeSandMcpAutoReviewAction({
          serverDisplayName: request.target.serverDisplayName,
          toolName: request.target.toolName,
          ...(request.target.mcpArguments === undefined
            ? {}
            : { mcpArguments: request.target.mcpArguments }),
          ...(description == null || description.length === 0 ? {} : { description }),
        }),
        command: summarizeSandMcpAutoReviewAction({
          serverDisplayName: request.target.serverDisplayName,
          toolName: request.target.toolName,
          mcpArguments: request.target.mcpArguments,
        }),
        ...(request.target.proposedAllowRule == null
          ? {}
          : { proposedRule: request.target.proposedAllowRule }),
        ...(request.signal == null ? {} : { signal: request.signal }),
        expiryPolicy: args.getExpiryPolicy(),
      });
    },
  };
}
