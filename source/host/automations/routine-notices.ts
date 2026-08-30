import { triggerListeners } from "../../shared/automations.js";

export const GITHUB_LISTENER_SCOPE = "github-listener-scope";
export const GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS = Date.UTC(2026, 6, 30);

export interface NoticeAutomation {
  createdAt: number;
  trigger: Parameters<typeof triggerListeners>[0];
  raisedNotices?: readonly string[];
}

export interface RoutineNotice {
  id: string;
  applies(automation: NoticeAutomation): boolean;
  lines: readonly string[];
}

const githubListenerScopeNotice: RoutineNotice = {
  id: GITHUB_LISTENER_SCOPE,
  applies: (automation) => automation.createdAt < GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS && triggerListeners(automation.trigger).some(
    (listener) => listener.type === "github" && (listener.userAllowlist == null || listener.userAllowlist.length === 0)
  ),
  lines: [
    `NOTICE ${GITHUB_LISTENER_SCOPE} (raised once for this routine, and only here — act on it now or not at all): this routine's github listener filters nobody, so it fires for everyone in the repo, the shape of a listener written before userAllowlist existed. Decide whether this event was genuinely in scope for the saved prompt; silence by design is not a wasted fire.`,
    "If this fire is clearly wasted, update the listener now: narrow userAllowlist to a confirmed GitHub login or remove event kinds the saved prompt never covered. CI events are never user-gated. Tell the user what changed, and leave it alone when the mismatch or login is uncertain."
  ]
};

export const SAND_ROUTINE_NOTICES: readonly RoutineNotice[] = [githubListenerScopeNotice];

export function isRoutineNoticeId(value: string): boolean {
  return SAND_ROUTINE_NOTICES.some((notice) => notice.id === value);
}

export function routineNoticesToRaise(automation: NoticeAutomation): RoutineNotice[] {
  const raised = automation.raisedNotices ?? [];
  return SAND_ROUTINE_NOTICES.filter((notice) => notice.applies(automation) && !raised.includes(notice.id));
}

export function routineNoticeWakeLines(automation: NoticeAutomation): string[] {
  return routineNoticesToRaise(automation).flatMap((notice) => [...notice.lines]);
}
