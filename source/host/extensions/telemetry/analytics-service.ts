export interface AnalyticsClient {
  trackEvent(
    name: string,
    properties: Record<string, string | number | boolean>,
  ): void;
}

export interface AutomationRunAnalyticsReport {
  conversationId: string;
  automationId: string;
  trigger: string;
  outcome: string;
  isGroup: boolean;
  sentMessageCount?: number | null;
}

type ReportMethod = (...args: never[]) => unknown;

/** The exact telemetry surface consumed by the host agent runtime. */
export interface TelemetryService {
  startTurn: ReportMethod;
  reportToolCallError: ReportMethod;
  reportToolCallStalled: ReportMethod;
  reportToolCallStarted: ReportMethod;
  reportAgentError: ReportMethod;
  reportBotBlock: ReportMethod;
  reportDaemonPing: ReportMethod;
  reportBoxBootStage: ReportMethod;
  reportExecDaemonRestart: ReportMethod;
  reportSupervisorRestart: ReportMethod;
  reportTurnInterrupt: ReportMethod;
  reportTurnAwait: ReportMethod;
  reportTurnRetry: ReportMethod;
  reportUserMessageReceived: ReportMethod;
  reportClosingSendNudge: ReportMethod;
  reportSubagentRevival: ReportMethod;
  reportShellRevival: ReportMethod;
  reportComputerUseUsage: ReportMethod;
  reportTtft: ReportMethod;
  reportSendDispatch: ReportMethod;
  reportQueueAccepted: ReportMethod;
  reportQueueDequeued: ReportMethod;
  reportQueueWatchdog: ReportMethod;
  reportAckObligation: ReportMethod;
  reportPendingWake: ReportMethod;
  reportTurnUsage: ReportMethod;
  reportTurnEmptyDelivery: ReportMethod;
  reportJournalOutcome: ReportMethod;
  reportAutoReviewExpireSweepFailed: ReportMethod;
  reportAutomationLifecycle: ReportMethod;
  reportAutomationFireDropped: ReportMethod;
  reportAutomationRun: ReportMethod;
}

/**
 * Preserve every method explicitly. Class prototype methods are not enumerable,
 * so object spread would silently erase this facade at runtime.
 */
export function withAutomationRunAnalytics<T extends TelemetryService>(
  telemetry: T,
  analytics: AnalyticsClient,
) {
  const forward = <K extends keyof TelemetryService>(name: K) => {
    type Method = T[K];
    return (...args: Parameters<Method>): ReturnType<Method> =>
      telemetry[name](...args) as ReturnType<Method>;
  };
  const reportAutomationRun = telemetry.reportAutomationRun as unknown as (
    report: AutomationRunAnalyticsReport,
  ) => unknown;

  return {
    startTurn: forward("startTurn"),
    reportToolCallError: forward("reportToolCallError"),
    reportToolCallStalled: forward("reportToolCallStalled"),
    reportToolCallStarted: forward("reportToolCallStarted"),
    reportAgentError: forward("reportAgentError"),
    reportBotBlock: forward("reportBotBlock"),
    reportDaemonPing: forward("reportDaemonPing"),
    reportBoxBootStage: forward("reportBoxBootStage"),
    reportExecDaemonRestart: forward("reportExecDaemonRestart"),
    reportSupervisorRestart: forward("reportSupervisorRestart"),
    reportTurnInterrupt: forward("reportTurnInterrupt"),
    reportTurnAwait: forward("reportTurnAwait"),
    reportTurnRetry: forward("reportTurnRetry"),
    reportUserMessageReceived: forward("reportUserMessageReceived"),
    reportClosingSendNudge: forward("reportClosingSendNudge"),
    reportSubagentRevival: forward("reportSubagentRevival"),
    reportShellRevival: forward("reportShellRevival"),
    reportComputerUseUsage: forward("reportComputerUseUsage"),
    reportTtft: forward("reportTtft"),
    reportSendDispatch: forward("reportSendDispatch"),
    reportQueueAccepted: forward("reportQueueAccepted"),
    reportQueueDequeued: forward("reportQueueDequeued"),
    reportQueueWatchdog: forward("reportQueueWatchdog"),
    reportAckObligation: forward("reportAckObligation"),
    reportPendingWake: forward("reportPendingWake"),
    reportTurnUsage: forward("reportTurnUsage"),
    reportTurnEmptyDelivery: forward("reportTurnEmptyDelivery"),
    reportJournalOutcome: forward("reportJournalOutcome"),
    reportAutoReviewExpireSweepFailed: forward(
      "reportAutoReviewExpireSweepFailed",
    ),
    reportAutomationLifecycle: forward("reportAutomationLifecycle"),
    reportAutomationFireDropped: forward("reportAutomationFireDropped"),
    reportAutomationRun: (report: AutomationRunAnalyticsReport) => {
      analytics.trackEvent("sand.automation.run", {
        agent_id: report.conversationId,
        automation_id: report.automationId,
        trigger: report.trigger,
        outcome: report.outcome,
        is_group: report.isGroup,
        ...(report.sentMessageCount != null
          ? { sent_message_count: report.sentMessageCount }
          : {}),
      });
      return reportAutomationRun(report);
    },
  };
}
