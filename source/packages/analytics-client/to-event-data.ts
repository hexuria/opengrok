import { EventData } from "../proto/generated/aiserver/v1/analytics_pb.js";

export type AnalyticsEventProperties = Readonly<Record<string, unknown>>;

export function toEventData(props: AnalyticsEventProperties | null | undefined): Record<string, EventData> {
  const out: Record<string, EventData> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string") {
      out[key] = new EventData({ data: { case: "stringValue", value } });
    } else if (typeof value === "number") {
      out[key] = new EventData({ data: { case: "doubleValue", value } });
    } else if (typeof value === "boolean") {
      out[key] = new EventData({ data: { case: "boolValue", value } });
    } else if (typeof value === "bigint") {
      out[key] = new EventData({ data: { case: "intValue", value } });
    }
  }
  return out;
}
