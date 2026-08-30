import {
  SandOsNotificationDecider,
  buildNotificationContent,
  toNotificationSnapshot,
  type NotificationAgent,
  type NotificationTransition,
} from "../../shared/os-notification.js";
import type { SandNotificationPreferences, SandNotificationSoundId } from "../../shared/notification-sound.js";

export interface DesktopNotificationPort {
  on(event: "click", listener: () => void): void;
  once(event: "close", listener: () => void): void;
  show(): void;
  close(): void;
}

export interface NotificationWindowPort {
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export class SandOsNotificationManager {
  private decider = new SandOsNotificationDecider();
  private readonly active = new Set<DesktopNotificationPort>();
  private hasSeededBaseline = false;
  private preSeedDeltas: Array<{ readonly agent: NotificationAgent }> = [];

  constructor(private readonly deps: {
    readonly getWindow: () => NotificationWindowPort | null;
    readonly isSupported: () => boolean;
    readonly createNotification: (options: { readonly title: string; readonly body: string; readonly silent: boolean; readonly urgency: "critical" | "normal" }) => DesktopNotificationPort;
    readonly openAgent: (agentId: string) => void;
    readonly now?: () => number;
    /** Omit all three and the manager behaves exactly as it did before sounds existed. */
    readonly playSound?: (sound: SandNotificationSoundId) => void;
    readonly getPreferences?: () => SandNotificationPreferences;
    readonly isSoundsFeatureEnabled?: () => boolean;
  }) {}

  handleAgentsEvent(event: { readonly agents: readonly NotificationAgent[] }): void {
    const window = this.deps.getWindow();
    if (window == null || !this.deps.isSupported()) return;
    const transitions = this.decider.decide({ agents: event.agents.map(toNotificationSnapshot), isWindowFocused: window.isFocused(), nowMs: (this.deps.now ?? Date.now)() });
    this.flushPreSeedDeltas();
    for (const transition of transitions) this.show(transition);
  }

  handleAgentUpsertedEvent(event: { readonly agent: NotificationAgent }): void {
    if (!this.hasSeededBaseline) { this.preSeedDeltas.push(event); return; }
    this.processDelta(event);
  }

  seedBaseline(agents: readonly NotificationAgent[]): void {
    this.decider.seedBaseline(agents.map(toNotificationSnapshot));
    this.flushPreSeedDeltas();
  }

  forget(agentId: string): void { this.decider.forget(agentId); }

  reset(): void {
    this.decider = new SandOsNotificationDecider();
    this.hasSeededBaseline = false;
    this.preSeedDeltas = [];
    for (const notification of this.active) notification.close();
    this.active.clear();
  }

  private processDelta(event: { readonly agent: NotificationAgent }): void {
    const snapshot = toNotificationSnapshot(event.agent);
    const window = this.deps.getWindow();
    if (window == null || !this.deps.isSupported()) { this.decider.observeAgent(snapshot); return; }
    for (const transition of this.decider.decideAgent(snapshot, { isWindowFocused: window.isFocused(), nowMs: (this.deps.now ?? Date.now)() })) this.show(transition);
  }

  private flushPreSeedDeltas(): void {
    if (this.hasSeededBaseline) return;
    this.hasSeededBaseline = true;
    const buffered = this.preSeedDeltas;
    this.preSeedDeltas = [];
    for (const event of buffered) this.processDelta(event);
  }

  /** Our own tone replaces the OS chime rather than stacking on top of it. */
  private soundToPlay(): SandNotificationSoundId | null {
    if (this.deps.playSound == null || this.deps.getPreferences == null || this.deps.isSoundsFeatureEnabled?.() !== true) return null;
    const preferences = this.deps.getPreferences();
    return preferences.playSound ? preferences.sound : null;
  }

  private show(transition: NotificationTransition): void {
    const { title, body } = buildNotificationContent(transition);
    const sound = this.soundToPlay();
    const notification = this.deps.createNotification({ title, body, silent: transition.kind === "agent-done" || sound != null, urgency: transition.kind === "agent-needs-input" ? "critical" : "normal" });
    notification.on("click", () => this.focusAgent(transition.agentId));
    notification.once("close", () => this.active.delete(notification));
    this.active.add(notification);
    notification.show();
    if (sound != null) this.deps.playSound?.(sound);
  }

  private focusAgent(agentId: string): void {
    const window = this.deps.getWindow();
    if (window != null) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    this.deps.openAgent(agentId);
  }
}
