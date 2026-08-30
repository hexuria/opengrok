export interface AttachmentRosterPort {
  setFallbackAgentId(agentId: string | null): void;
}

export interface TranscriptRosterPort {
  liveRunningAgentIds(): Iterable<string>;
}

export interface ForeverBoxRosterPort {
  readonly diskPressureReminder: {
    enroll(agentIds: ReadonlySet<string>): void;
  };
  setBusy(isBusy: boolean): void;
}

export interface SnapshotBackstopPort {
  readonly isEnabled: boolean;
  scheduleSnapshot(agentId: string): void;
}

export interface BoxStoreSnapshotPort {
  readonly isEnabled: boolean;
  scheduleStoreDbSnapshot(agentId: string): void;
}

export interface SourceMapRosterPort {
  getOrCreate(agentId: string): unknown;
}

export interface HostRosterExtensions {
  api(id: "attachments"): AttachmentRosterPort;
  api(id: "transcript"): TranscriptRosterPort;
  api(id: "forever-box"): ForeverBoxRosterPort;
  api(id: "state-backstop"): SnapshotBackstopPort;
  api(id: "box-store-sync"): BoxStoreSnapshotPort;
  api(id: "source-map"): SourceMapRosterPort;
}

export interface HostRosterBookkeeping {
  readonly latestActiveAgentId: string | null;
  readonly isBusy: boolean;
  readonly runningAgentIds: ReadonlySet<string>;
  apply(activeAgentId: string | null | undefined): void;
}

export function createHostRosterBookkeeping(
  extensions: HostRosterExtensions
): HostRosterBookkeeping {
  let latestActiveAgentId: string | null = null;
  let runningAgentIds = new Set<string>();
  let isBusy = false;

  return {
    get latestActiveAgentId() {
      return latestActiveAgentId;
    },

    get isBusy() {
      return isBusy;
    },

    get runningAgentIds() {
      return new Set(runningAgentIds);
    },

    apply(activeAgentId) {
      const normalizedActiveAgentId =
        activeAgentId != null && activeAgentId.length > 0
          ? activeAgentId
          : null;

      latestActiveAgentId = normalizedActiveAgentId;
      extensions.api("attachments").setFallbackAgentId(normalizedActiveAgentId);

      const previouslyRunning = runningAgentIds;
      runningAgentIds = new Set(
        extensions.api("transcript").liveRunningAgentIds()
      );
      isBusy = runningAgentIds.size > 0;

      const foreverBox = extensions.api("forever-box");
      const started = new Set(
        [...runningAgentIds].filter(id => !previouslyRunning.has(id))
      );
      if (started.size > 0) foreverBox.diskPressureReminder.enroll(started);
      foreverBox.setBusy(isBusy);

      const stateBackstop = extensions.api("state-backstop");
      const boxStore = extensions.api("box-store-sync");
      if (stateBackstop.isEnabled || boxStore.isEnabled) {
        for (const agentId of previouslyRunning) {
          if (runningAgentIds.has(agentId)) continue;
          stateBackstop.scheduleSnapshot(agentId);
          boxStore.scheduleStoreDbSnapshot(agentId);
        }
      }

      if (normalizedActiveAgentId != null) {
        void extensions.api("source-map").getOrCreate(normalizedActiveAgentId);
      }
    }
  };
}
