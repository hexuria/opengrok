import type { Context } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";
import { readExecutorResource } from "../../agent-exec/read.js";
import { writeExecutorResource } from "../../agent-exec/write.js";
import { ReadArgs } from "../../proto/generated/agent/v1/read_exec_pb.js";
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { getRequestPathModule } from "../utils/request-path.js";

type Any = any;

const logger = createLogger("@anysphere/agent:execute-plan");

export interface ExecutePlanPlanFileAction {
  readonly planFilePath?: { unwrap(purpose: PrivacyCapability): string } | undefined;
  readonly planId?: string | undefined;
}

export interface ExecutePlanPlanFileRequestContext {
  readonly env?: {
    readonly artifactsFolder?: string | undefined;
    readonly osVersion?: string | undefined;
  } | undefined;
}

export interface ExecutePlanPlanFileResourceAccessor {
  get(resource: typeof readExecutorResource): {
    execute(ctx: Context, args: ReadArgs): Promise<Any>;
  };
  get(resource: typeof writeExecutorResource): {
    execute(ctx: Context, args: WriteArgs): Promise<Any>;
  };
}

export interface ExecutePlanPlanFileResolution {
  readonly planFilePath: string | undefined;
  readonly recreatedPlanFilePath: string | undefined;
  readonly shouldUpsertPlanRegistryEntry: boolean;
  readonly availability: "unknown" | "on_disk" | "unavailable";
}

export function sanitizePlanFileName(candidate: string): string | undefined {
  const lastSegment = candidate.split(/[/\\]/).pop() ?? "";
  const sanitized = lastSegment.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return undefined;
  }
  return sanitized;
}

export async function resolvePlanFilePath(
  ctx: Context,
  requestContext: ExecutePlanPlanFileRequestContext,
  resourceAccessor: ExecutePlanPlanFileResourceAccessor,
  action: ExecutePlanPlanFileAction,
  planFileContent: string,
): Promise<ExecutePlanPlanFileResolution> {
  const providedPlanFilePath = action.planFilePath?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) || undefined;
  const artifactsFolder = requestContext.env?.artifactsFolder;
  if (artifactsFolder === undefined || artifactsFolder.length === 0) {
    return {
      planFilePath: providedPlanFilePath,
      recreatedPlanFilePath: undefined,
      shouldUpsertPlanRegistryEntry: false,
      availability: "unknown",
    };
  }

  let readResultCase: string | undefined;
  try {
    if (providedPlanFilePath !== undefined) {
      const readResult = await resourceAccessor.get(readExecutorResource).execute(
        ctx,
        // Probe existence only; plan content is already available in-memory.
        new ReadArgs({ path: providedPlanFilePath, limit: 1 }),
      );
      readResultCase = readResult.result.case;
      if (readResult.result.case === "success") {
        return {
          planFilePath: providedPlanFilePath,
          recreatedPlanFilePath: undefined,
          shouldUpsertPlanRegistryEntry: true,
          availability: "on_disk",
        };
      }
    }

    const pathModule = getRequestPathModule(
      requestContext.env?.osVersion === undefined
        ? {}
        : { env: { osVersion: requestContext.env.osVersion } },
    );
    const fallbackFileName =
      (providedPlanFilePath !== undefined
        ? sanitizePlanFileName(providedPlanFilePath)
        : undefined) ??
      (action.planId !== undefined
        ? sanitizePlanFileName(`${action.planId}.plan.md`)
        : undefined) ??
      "plan.md";
    const recreatedPlanFilePath = pathModule.join(
      artifactsFolder,
      "plans",
      fallbackFileName,
    );
    const writeResult = await resourceAccessor.get(writeExecutorResource).execute(
      ctx,
      new WriteArgs({
        path: recreatedPlanFilePath,
        fileText: planFileContent,
        returnFileContentAfterWrite: false,
      }),
    );
    if (writeResult.result.case !== "success") {
      logger.warn(ctx, "agent.execute_plan.plan_file_recreate_failed", {
        planId: action.planId,
        hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
        readResultCase,
        writeResultCase: writeResult.result.case,
      });
      return {
        planFilePath: providedPlanFilePath,
        recreatedPlanFilePath: undefined,
        shouldUpsertPlanRegistryEntry: false,
        availability: "unavailable",
      };
    }
    logger.info(ctx, "agent.execute_plan.plan_file_recreated", {
      planId: action.planId,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      readResultCase,
    });
    return {
      planFilePath: recreatedPlanFilePath,
      recreatedPlanFilePath,
      shouldUpsertPlanRegistryEntry: true,
      availability: "on_disk",
    };
  } catch (error) {
    logger.error(ctx, "agent.execute_plan.plan_file_resolution_failed", error, {
      planId: action.planId,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      readResultCase,
    });
    return {
      planFilePath: providedPlanFilePath,
      recreatedPlanFilePath: undefined,
      shouldUpsertPlanRegistryEntry: false,
      availability: "unavailable",
    };
  }
}
