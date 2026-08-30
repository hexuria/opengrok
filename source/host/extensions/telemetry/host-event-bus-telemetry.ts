export const HOST_EVENT_BUS_EVENT = "sand.host.event_bus";
export interface HostEventBusReport {
  kind: string;
  topic: string;
  errorClass: string;
}
export function hostEventBusTelemetry(report: HostEventBusReport) {
  return {
    level: "error",
    event: HOST_EVENT_BUS_EVENT,
    metadata: {
      kind: report.kind,
      topic: report.topic,
      error_class: report.errorClass,
    },
  };
}
