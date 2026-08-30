import {
  createDebouncePolicy,
  realClock,
} from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { getSandRootDir } from "../../host-paths.js";
import { installHostTranscriptServer } from "../../transcript-server/install-transcript-server.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { PromptAcceptanceLedger } from "./prompt-acceptance-ledger.js";
import { OUTLINE_STREAM_COALESCE_MS } from "./roster-projection.js";
import { SandAckObligationStore } from "./sand-ack-obligation-store.js";
import { SandPendingWakeStore } from "./sand-pending-wake-store.js";
import { SandUpgradeResumeStore } from "./sand-upgrade-resume-store.js";
import {
  TranscriptManager,
  type TurnExecutionPort,
} from "./transcript-manager.js";

interface TranscriptHost {
  readonly events: {
    emit(topic: string, payload: unknown): Promise<void> | void;
  };
}

interface TranscriptExtensionDeps {
  readonly session: { readonly store: any };
  readonly telemetry: {
    readonly brain: any;
    readonly analytics: any;
    readonly flushTracing: () => void;
  };
  readonly memory: any;
  readonly "content-search": any;
  readonly attachments: any;
  readonly trays: any;
  readonly "turn-execution": {
    readonly canExecute: boolean;
    isRunReady(): Promise<boolean>;
    createRunner(...args: any[]): any;
    createGroupMemberRunner(...args: any[]): any;
  };
  readonly auth: {
    getAccessToken(options: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
  };
  readonly experiments: {
    checkFeatureGate(name: string): boolean;
  };
}

export const transcriptExtension = defineHostExtension<
  TranscriptManager,
  TranscriptHost
>({
  id: HostExtensions.Transcript,
  dependencies: [
    HostExtensions.Attachments,
    HostExtensions.Auth,
    HostExtensions.ContentSearch,
    HostExtensions.Experiments,
    HostExtensions.Memory,
    HostExtensions.Session,
    HostExtensions.Telemetry,
    HostExtensions.Trays,
    HostExtensions.TurnExecution,
  ],
  start: (context) => {
    const deps = context.deps as unknown as TranscriptExtensionDeps;
    const sandRoot = getSandRootDir();
    const manager = new TranscriptManager(
      deps.session.store,
      new SandUpgradeResumeStore(sandRoot),
      new SandAckObligationStore(sandRoot),
      new PromptAcceptanceLedger(sandRoot),
      new SandPendingWakeStore(sandRoot),
    );
    manager.setTelemetry(deps.telemetry.brain);
    manager.setProductAnalytics(deps.telemetry.analytics);
    manager.setTraceFlusher(deps.telemetry.flushTracing);
    manager.setMemory(deps.memory);
    manager.setContentSearch(deps[HostExtensions.ContentSearch]);
    manager.setAttachments(deps.attachments);
    manager.setTrayErrors(deps.trays);
    const outlineCoalescing = createDebouncePolicy(realClock, {
      name: "transcript-outline-stream",
      delayMs: OUTLINE_STREAM_COALESCE_MS,
    });
    const setOutlineStreamCoalescing = (
      manager.roster as unknown as {
        setOutlineStreamCoalescing?: (policy: typeof outlineCoalescing) => void;
      }
    ).setOutlineStreamCoalescing;
    setOutlineStreamCoalescing?.call(manager.roster, outlineCoalescing);

    const execution = deps[HostExtensions.TurnExecution];
    manager.setTurnExecution({
      get canExecute() {
        return execution.canExecute;
      },
      get canExecuteGroupMember() {
        return execution.canExecute;
      },
      isRunReady: () => execution.isRunReady(),
      createRunner: (...args: any[]) => execution.createRunner(...args),
      createGroupMemberRunner: (...args: any[]) =>
        execution.createGroupMemberRunner(...args),
    } satisfies TurnExecutionPort);
    manager.setAutomationConfigChanged(() => {
      void context.host.events.emit("transcript.automation-config-changed", {});
    });
    manager.setListenerConnectObserver(
      ({ agentId, platform }: { agentId: string; platform: string }) => {
        void context.host.events.emit("transcript.listener-connect-card", {
          agentId,
          platform,
        });
      },
    );
    manager.setAgentRunLifecycleObserver(
      (event: { type: "started" | "ended"; requestId: string }) => {
        void context.host.events.emit(
          event.type === "started"
            ? "transcript.run-started"
            : "transcript.run-ended",
          { requestId: event.requestId },
        );
      },
    );
    context.onStop(
      installHostTranscriptServer({
        auth: deps.auth ?? context.deps[HostExtensions.Auth] as TranscriptExtensionDeps["auth"],
        experiments: {
          checkFeatureGate: (name) =>
            (deps.experiments ?? context.deps[HostExtensions.Experiments] as TranscriptExtensionDeps["experiments"])
              .checkFeatureGate(name),
        },
      }),
    );
    context.onStop(() => manager.dispose());
    return manager;
  },
});
