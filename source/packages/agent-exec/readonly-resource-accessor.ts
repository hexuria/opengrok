import {
  BackgroundShellSpawnResult,
  WriteShellStdinError,
  WriteShellStdinResult,
} from "../proto/generated/agent/v1/background_shell_exec_pb.js";
import {
  DeletePermissionDenied,
  DeleteResult,
} from "../proto/generated/agent/v1/delete_exec_pb.js";
import {
  McpPermissionDenied,
  McpResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.js";
import {
  ShellPermissionDenied,
  ShellResult,
  ShellStream,
} from "../proto/generated/agent/v1/shell_exec_pb.js";
import {
  WritePermissionDenied,
  WriteResult,
} from "../proto/generated/agent/v1/write_exec_pb.js";
import {
  backgroundShellExecutorResource,
  writeBackgroundShellInputExecutorResource,
} from "./background-shell.js";
import { deleteExecutorResource } from "./delete.js";
import { mcpExecutorResource } from "./mcp.js";
import type { RemoteExecManager } from "./remote.js";
import {
  CombinedResourceAccessor,
  type RemoteResource,
  type ResourceAccessor,
} from "./resource-provider.js";
import { shellExecutorResource } from "./shell.js";
import { shellStreamExecutorResource } from "./shell-stream.js";
import { writeExecutorResource } from "./write.js";

const READONLY_WRITE_ERROR_MESSAGE =
  "This operation is not allowed in readonly mode. The subagent was launched with readonly: true, which restricts write operations.";

interface ShellLikeArgs {
  command?: string | undefined;
  workingDirectory?: string | undefined;
}

function createReadonlyShellPermissionDenied(
  errorMessage: string,
  args: ShellLikeArgs,
): ShellPermissionDenied {
  return new ShellPermissionDenied({
    command: args.command ?? "",
    workingDirectory: args.workingDirectory ?? "",
    error: errorMessage,
    isReadonly: true,
  });
}

function createReadonlyShellExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: ShellLikeArgs): Promise<ShellResult> {
      return new ShellResult({
        result: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      });
    },
  };
}

function createReadonlyShellStreamExecutor(errorMessage: string) {
  return {
    async *execute(_ctx: unknown, args: ShellLikeArgs): AsyncIterable<ShellStream> {
      yield new ShellStream({
        event: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      });
    },
  };
}

function createReadonlyBackgroundShellExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: ShellLikeArgs): Promise<BackgroundShellSpawnResult> {
      return new BackgroundShellSpawnResult({
        result: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      });
    },
  };
}

function createReadonlyWriteExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { path: string }): Promise<WriteResult> {
      return new WriteResult({
        result: {
          case: "permissionDenied",
          value: new WritePermissionDenied({
            path: args.path,
            error: errorMessage,
            isReadonly: true,
          }),
        },
      });
    },
  };
}

function createReadonlyDeleteExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { path: string }): Promise<DeleteResult> {
      return new DeleteResult({
        result: {
          case: "permissionDenied",
          value: new DeletePermissionDenied({
            path: args.path,
            clientVisibleError: errorMessage,
            isReadonly: true,
          }),
        },
      });
    },
  };
}

function createReadonlyMcpExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { name: string }): Promise<McpResult> {
      return new McpResult({
        result: {
          case: "permissionDenied",
          value: new McpPermissionDenied({
            error: `${errorMessage} Tool: ${args.name}`,
            isReadonly: true,
          }),
        },
      });
    },
  };
}

function createReadonlyWriteBackgroundShellStdinExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, _args: unknown): Promise<WriteShellStdinResult> {
      return new WriteShellStdinResult({
        result: {
          case: "error",
          value: new WriteShellStdinError({ error: errorMessage }),
        },
      });
    },
  };
}

interface ReadonlyResourceEntryArgs {
  errorMessage: string;
  wrapShell: boolean;
  includeWriteBackgroundShellStdin: boolean;
}

function buildReadonlyResourceEntries(
  args: ReadonlyResourceEntryArgs,
): Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> {
  const localEntries: Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> = [
    [writeExecutorResource, createReadonlyWriteExecutor(args.errorMessage)],
    [deleteExecutorResource, createReadonlyDeleteExecutor(args.errorMessage)],
    [mcpExecutorResource, createReadonlyMcpExecutor(args.errorMessage)],
  ];
  if (args.wrapShell) {
    localEntries.push(
      [shellExecutorResource, createReadonlyShellExecutor(args.errorMessage)],
      [shellStreamExecutorResource, createReadonlyShellStreamExecutor(args.errorMessage)],
      [backgroundShellExecutorResource, createReadonlyBackgroundShellExecutor(args.errorMessage)],
    );
  }
  if (args.includeWriteBackgroundShellStdin) {
    localEntries.push([
      writeBackgroundShellInputExecutorResource,
      createReadonlyWriteBackgroundShellStdinExecutor(args.errorMessage),
    ]);
  }
  return localEntries;
}

export function createReadonlyResourceAccessor(
  baseAccessor: ResourceAccessor<RemoteExecManager>,
  wrapShell: boolean,
): ResourceAccessor<RemoteExecManager> {
  return new CombinedResourceAccessor(
    baseAccessor,
    buildReadonlyResourceEntries({
      errorMessage: READONLY_WRITE_ERROR_MESSAGE,
      wrapShell,
      includeWriteBackgroundShellStdin: false,
    }),
  );
}
