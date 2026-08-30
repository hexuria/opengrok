// Mechanically recovered from the immutable 0.18 bundle by scripts/recover-sentry-scrub.mjs.
type UnknownRecord = Record<string, unknown>;
type RestrictedPrivacyTier = "scrubbed" | "fatal-metadata";
type SandSentryPrivacyTier = "full" | RestrictedPrivacyTier;
type SandSentryItem = [UnknownRecord, unknown];
type SandSentryEnvelope = [UnknownRecord, SandSentryItem[]];
const REDACTED_PATH = "<REDACTED: user-file-path>";
const REDACTED_URL = "<REDACTED: url>";
const REDACTED_EXCEPTION_MESSAGE = "<REDACTED: exception-message>";
const REDACTION_VALUE = /^<REDACTED: [A-Za-z ,-]+>$/;
const BOUNDED_CODE = /^[A-Za-z0-9._:@-]+$/;
const BOUNDED_OPAQUE_ID = /^[A-Za-z0-9._:@|-]+$/;
const BOUNDED_NODE_FRAME_FILENAME = /^node:[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const BOUNDED_APP_URL = /^app:\/\/\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const COMPONENT_STACK_LINE = /^\s*(in|at)\s+([A-Za-z0-9$_.]{1,128})(?:\s|\(|$)/;
const MAX_EXCEPTIONS = 8;
const MAX_FRAMES = 100;
const MAX_THREADS = 16;
const MAX_COMPONENT_STACK_LINES = 64;
const STRICT_FATAL_TAGS = new Set(["app_flavor", "event.environment", "event.origin", "event.process", "exit.reason", "crash.kind", "sand.failure_code", "sand.process"]);
const SEVERITY_LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const SESSION_STATUSES = new Set(["ok", "exited", "crashed", "abnormal"]);
function isValidIanaTimeZone(value: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }

function isRecord2(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function nonNegativeNumber(value: unknown): number | undefined {
  const number7 = finiteNumber(value);
  return number7 !== void 0 && number7 >= 0 ? number7 : void 0;
}
function boundedCode(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return void 0;
  }
  return BOUNDED_CODE.test(value) ? value : void 0;
}
function boundedId(value: unknown): string | number | undefined {
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return void 0;
  }
  return BOUNDED_OPAQUE_ID.test(value) && removePropertiesWithPossibleUserInfo(value) === value ? value : void 0;
}
function boundedTagValue(value: unknown): string | undefined {
  const code = boundedCode(value);
  if (code === void 0) return void 0;
  return removePropertiesWithPossibleUserInfo(code) === code ? code : void 0;
}
function isSandSentryBoundedTagValue(value: unknown): boolean {
  return boundedTagValue(value) !== void 0;
}
function removePropertiesWithPossibleUserInfo(property: string): string {
  if (!property || REDACTION_VALUE.test(property)) return property;
  const userDataRegexes = [
    { label: "Google API Key", regex: /AIza[A-Za-z0-9_\\\-]{35}/ },
    { label: "Slack Token", regex: /xox[pbar]\-[A-Za-z0-9]/ },
    {
      label: "GitHub Token",
      regex: /(gh[psuro]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/
    },
    {
      label: "Generic Secret",
      regex: /(key|token|sig|secret|signature|password|passwd|pwd|android:value)[^a-zA-Z0-9]/i
    },
    {
      label: "CLI Credentials",
      regex: /((login|psexec|(certutil|psexec)\.exe).{1,50}(\s-u(ser(name)?)?\s+.{3,100})?\s-(admin|user|vm|root)?p(ass(word)?)?\s+["']?[^$\-\/\s]|(^|[\s\r\n\\])net(\.exe)?.{1,5}(user\s+|share\s+\/user:| user -? secrets ? set) \s + [^ $\s \/])/
    },
    {
      label: "Microsoft Entra ID",
      regex: /eyJ(?:0eXAiOiJKV1Qi|hbGci|[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.)/
    },
    {
      label: "Email",
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
    }
  ];
  for (const { label, regex } of userDataRegexes) {
    if (regex.test(property)) return `<REDACTED: ${label}>`;
  }
  return property;
}
function scrubAppUrl(value: unknown): string | undefined {
  if (value === REDACTED_URL) return REDACTED_URL;
  if (typeof value !== "string") return void 0;
  try {
    const url3 = new URL(value);
    if (url3.protocol !== "app:" || url3.host !== "" || url3.username !== "" || url3.password !== "") {
      return REDACTED_URL;
    }
    const normalized = `app://${url3.pathname}`;
    return BOUNDED_APP_URL.test(normalized) ? normalized : REDACTED_URL;
  } catch {
    return REDACTED_URL;
  }
}
function setCode(target: UnknownRecord, key: string, value: unknown, maxLength = 128): void {
  const code = boundedCode(value, maxLength);
  if (code !== void 0) target[key] = code;
}
function setTagValue(target: UnknownRecord, key: string, value: unknown): void {
  const tagValue = boundedTagValue(value);
  if (tagValue !== void 0) target[key] = tagValue;
}
function setNumber(target: UnknownRecord, key: string, value: unknown): void {
  const number7 = finiteNumber(value);
  if (number7 !== void 0) target[key] = number7;
}
function setBoolean(target: UnknownRecord, key: string, value: unknown): void {
  if (typeof value === "boolean") target[key] = value;
}
function scrubFrameFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return void 0;
  if (value.length <= 512 && BOUNDED_NODE_FRAME_FILENAME.test(value)) return value;
  const appUrl = scrubAppUrl(value);
  if (appUrl !== REDACTED_URL) return appUrl;
  return REDACTED_PATH;
}
function scrubFrame(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const result: UnknownRecord = {};
  const filename = scrubFrameFilename(value.filename);
  if (filename !== void 0) result.filename = filename;
  const isReadableAppFrame = filename !== void 0 && filename !== REDACTED_PATH;
  if (isReadableAppFrame) {
    setTagValue(result, "function", value.function);
    setTagValue(result, "module", value.module);
  }
  setCode(result, "platform", value.platform);
  setNumber(result, "lineno", value.lineno);
  setNumber(result, "colno", value.colno);
  setBoolean(result, "in_app", value.in_app);
  setCode(result, "instruction_addr", value.instruction_addr);
  setCode(result, "addr_mode", value.addr_mode);
  setCode(result, "debug_id", value.debug_id);
  return result;
}
function scrubStacktrace(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || !Array.isArray(value.frames)) return void 0;
  const frames = value.frames.slice(0, MAX_FRAMES).map(scrubFrame).filter((frame) => frame !== void 0);
  return { frames };
}
function scrubMechanism(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const result: UnknownRecord = {};
  setCode(result, "type", value.type);
  setBoolean(result, "handled", value.handled);
  setBoolean(result, "synthetic", value.synthetic);
  setBoolean(result, "is_exception_group", value.is_exception_group);
  setNumber(result, "exception_id", value.exception_id);
  setNumber(result, "parent_id", value.parent_id);
  return result;
}
function scrubExceptionType(value: unknown): string | undefined {
  return boundedTagValue(value) ?? (typeof value === "string" ? "<REDACTED: exception-type>" : void 0);
}
function scrubExceptionValues(value: unknown, tier: RestrictedPrivacyTier): UnknownRecord | undefined {
  if (!isRecord2(value) || !Array.isArray(value.values)) return void 0;
  const values = value.values.slice(0, MAX_EXCEPTIONS).flatMap((candidate: unknown) => {
    if (!isRecord2(candidate)) return [];
    const exception2: UnknownRecord = {};
    const type2 = scrubExceptionType(candidate.type);
    if (type2 !== void 0) exception2.type = type2;
    if (tier === "scrubbed") {
      if (typeof candidate.value === "string") {
        exception2.value = REDACTED_EXCEPTION_MESSAGE;
      }
      const threadId2 = boundedId(candidate.thread_id);
      if (threadId2 !== void 0) exception2.thread_id = threadId2;
      const stacktrace = scrubStacktrace(candidate.stacktrace);
      if (stacktrace !== void 0) exception2.stacktrace = stacktrace;
      const mechanism = scrubMechanism(candidate.mechanism);
      if (mechanism !== void 0) exception2.mechanism = mechanism;
    }
    return [exception2];
  });
  return values.length > 0 ? { values } : void 0;
}
function scrubTags(value: unknown, tier: RestrictedPrivacyTier): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const tags: UnknownRecord = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (boundedTagValue(key) === void 0) continue;
    if (tier === "fatal-metadata" && !STRICT_FATAL_TAGS.has(key)) continue;
    if (tier === "fatal-metadata") {
      const code = boundedTagValue(tagValue);
      if (code !== void 0) tags[key] = code;
    } else if (typeof tagValue === "string") {
      const code = boundedTagValue(tagValue);
      if (code !== void 0) tags[key] = code;
    } else if (typeof tagValue === "boolean" || tagValue === null || typeof tagValue === "number" && Number.isFinite(tagValue)) {
      tags[key] = tagValue;
    }
  }
  return Object.keys(tags).length > 0 ? tags : void 0;
}
function scrubSdk(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const sdk: UnknownRecord = {};
  setCode(sdk, "name", value.name);
  setCode(sdk, "version", value.version);
  if (Array.isArray(value.integrations)) {
    sdk.integrations = value.integrations.map((integration: unknown) => boundedCode(integration)).filter((integration: unknown) => integration !== void 0).slice(0, 64);
  }
  if (Array.isArray(value.packages)) {
    sdk.packages = value.packages.slice(0, 64).flatMap((candidate: unknown) => {
      if (!isRecord2(candidate)) return [];
      const name = boundedCode(candidate.name);
      const version4 = boundedCode(candidate.version);
      return name !== void 0 && version4 !== void 0 ? [{ name, version: version4 }] : [];
    });
  }
  return Object.keys(sdk).length > 0 ? sdk : void 0;
}
function scrubUser(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const id = boundedId(value.id);
  return id === void 0 ? void 0 : { id };
}
function scrubRequest(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const request3: UnknownRecord = {};
  setCode(request3, "method", value.method);
  const url3 = scrubAppUrl(value.url);
  if (url3 !== void 0) request3.url = url3;
  return Object.keys(request3).length > 0 ? request3 : void 0;
}
function projectAppContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  for (const key of [
    "app_name",
    "app_start_time",
    "app_version",
    "app_identifier",
    "build_type",
    "app_arch"
  ]) {
    setCode(context2, key, value[key]);
  }
  setNumber(context2, "app_memory", value.app_memory);
  setNumber(context2, "free_memory", value.free_memory);
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function projectOsContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  for (const key of ["name", "version", "build", "kernel_version"]) {
    setCode(context2, key, value[key]);
  }
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function projectRuntimeContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  for (const key of ["name", "type", "version"]) setCode(context2, key, value[key]);
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function projectDeviceContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  for (const key of ["family", "arch", "screen_resolution", "orientation"]) {
    setCode(context2, key, value[key]);
  }
  for (const key of [
    "screen_height_pixels",
    "screen_width_pixels",
    "screen_density",
    "screen_dpi",
    "memory_size",
    "free_memory",
    "usable_memory",
    "storage_size",
    "free_storage",
    "processor_count",
    "processor_frequency"
  ]) {
    setNumber(context2, key, value[key]);
  }
  for (const key of ["online", "charging", "low_memory", "simulator"]) {
    setBoolean(context2, key, value[key]);
  }
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function projectElectronContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  const crashedUrl = scrubAppUrl(value.crashed_url);
  if (crashedUrl !== void 0) context2.crashed_url = crashedUrl;
  if (isRecord2(value.details)) {
    const details: UnknownRecord = {};
    for (const key of ["reason", "serviceName", "name", "type"]) {
      setCode(details, key, value.details[key]);
    }
    setNumber(details, "exitCode", value.details.exitCode);
    if (Object.keys(details).length > 0) context2.details = details;
  }
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function projectReactContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || typeof value.componentStack !== "string") return void 0;
  const lines2 = value.componentStack.split(/\r?\n/).slice(0, MAX_COMPONENT_STACK_LINES).flatMap((line) => {
    const match2 = COMPONENT_STACK_LINE.exec(line);
    return match2?.[1] !== void 0 && match2[2] !== void 0 ? [`${match2[1]} ${match2[2]}`] : [];
  });
  return lines2.length === 0 ? void 0 : { componentStack: lines2.join("\n") };
}
function projectCultureContext(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const context2: UnknownRecord = {};
  setCode(context2, "calendar", value.calendar);
  setCode(context2, "locale", value.locale);
  if (typeof value.timezone === "string" && isValidIanaTimeZone(value.timezone)) {
    context2.timezone = value.timezone;
  }
  setBoolean(context2, "is_24_hour_format", value.is_24_hour_format);
  return Object.keys(context2).length > 0 ? context2 : void 0;
}
function scrubContexts(value: unknown, tier: RestrictedPrivacyTier): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const contexts: UnknownRecord = {};
  const app38 = projectAppContext(value.app);
  if (app38 !== void 0) contexts.app = app38;
  const os9 = projectOsContext(value.os);
  if (os9 !== void 0) contexts.os = os9;
  if (tier === "fatal-metadata") {
    return Object.keys(contexts).length > 0 ? contexts : void 0;
  }
  for (const key of ["runtime", "browser", "chrome", "node"]) {
    const runtime = projectRuntimeContext(value[key]);
    if (runtime !== void 0) contexts[key] = runtime;
  }
  const device = projectDeviceContext(value.device);
  if (device !== void 0) contexts.device = device;
  const electron2 = projectElectronContext(value.electron);
  if (electron2 !== void 0) contexts.electron = electron2;
  const react = projectReactContext(value.react);
  if (react !== void 0) contexts.react = react;
  const culture = projectCultureContext(value.culture);
  if (culture !== void 0) contexts.culture = culture;
  return Object.keys(contexts).length > 0 ? contexts : void 0;
}
function scrubThreads(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || !Array.isArray(value.values)) return void 0;
  const values = value.values.slice(0, MAX_THREADS).flatMap((candidate: unknown) => {
    if (!isRecord2(candidate)) return [];
    const thread: UnknownRecord = {};
    const id = boundedId(candidate.id);
    if (id !== void 0) thread.id = id;
    setBoolean(thread, "main", candidate.main);
    setBoolean(thread, "crashed", candidate.crashed);
    setBoolean(thread, "current", candidate.current);
    const stacktrace = scrubStacktrace(candidate.stacktrace);
    if (stacktrace !== void 0) thread.stacktrace = stacktrace;
    return [thread];
  });
  return values.length > 0 ? { values } : void 0;
}
function projectScrubbedEvent(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const event: UnknownRecord = {};
  setCode(event, "event_id", value.event_id);
  setNumber(event, "timestamp", value.timestamp);
  setNumber(event, "start_timestamp", value.start_timestamp);
  if (typeof value.level === "string" && SEVERITY_LEVELS.has(value.level)) {
    event.level = value.level;
  }
  setCode(event, "platform", value.platform);
  setCode(event, "release", value.release, 128);
  setCode(event, "dist", value.dist, 64);
  setCode(event, "environment", value.environment, 64);
  const sdk = scrubSdk(value.sdk);
  if (sdk !== void 0) event.sdk = sdk;
  const request3 = scrubRequest(value.request);
  if (request3 !== void 0) event.request = request3;
  const exception2 = scrubExceptionValues(value.exception, "scrubbed");
  if (exception2 !== void 0) event.exception = exception2;
  const contexts = scrubContexts(value.contexts, "scrubbed");
  if (contexts !== void 0) event.contexts = contexts;
  const tags = scrubTags(value.tags, "scrubbed");
  if (tags !== void 0) event.tags = tags;
  const user = scrubUser(value.user);
  if (user !== void 0) event.user = user;
  const threads = scrubThreads(value.threads);
  if (threads !== void 0) event.threads = threads;
  return event;
}
function projectFatalMetadataEvent(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || value.level !== "fatal") return void 0;
  const event: UnknownRecord = { level: "fatal" };
  setCode(event, "event_id", value.event_id);
  setNumber(event, "timestamp", value.timestamp);
  setNumber(event, "start_timestamp", value.start_timestamp);
  setCode(event, "platform", value.platform);
  setCode(event, "release", value.release);
  setCode(event, "dist", value.dist, 64);
  setCode(event, "environment", value.environment);
  const exception2 = scrubExceptionValues(value.exception, "fatal-metadata");
  if (exception2 !== void 0) event.exception = exception2;
  const contexts = scrubContexts(value.contexts, "fatal-metadata");
  if (contexts !== void 0) event.contexts = contexts;
  const tags = scrubTags(value.tags, "fatal-metadata");
  if (tags !== void 0) event.tags = tags;
  return event;
}
function projectSession(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value)) return void 0;
  const session3: UnknownRecord = {};
  setBoolean(session3, "init", value.init);
  setCode(session3, "sid", value.sid);
  setCode(session3, "timestamp", value.timestamp, 64);
  setCode(session3, "started", value.started, 64);
  setNumber(session3, "duration", value.duration);
  if (typeof value.status === "string" && SESSION_STATUSES.has(value.status)) {
    session3.status = value.status;
  }
  setNumber(session3, "errors", value.errors);
  if (isRecord2(value.attrs)) {
    const attrs: UnknownRecord = {};
    setCode(attrs, "release", value.attrs.release, 128);
    setCode(attrs, "environment", value.attrs.environment, 64);
    if (Object.keys(attrs).length > 0) session3.attrs = attrs;
  }
  return Object.keys(session3).length > 0 ? session3 : void 0;
}
function projectSessionAggregates(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || !Array.isArray(value.aggregates)) return void 0;
  const result: UnknownRecord = {};
  if (isRecord2(value.attrs)) {
    const attrs: UnknownRecord = {};
    setCode(attrs, "release", value.attrs.release, 128);
    setCode(attrs, "environment", value.attrs.environment, 64);
    if (Object.keys(attrs).length > 0) result.attrs = attrs;
  }
  result.aggregates = value.aggregates.slice(0, 100).flatMap((candidate: unknown) => {
    if (!isRecord2(candidate)) return [];
    const aggregate: UnknownRecord = {};
    setCode(aggregate, "started", candidate.started, 64);
    setNumber(aggregate, "exited", candidate.exited);
    setNumber(aggregate, "errored", candidate.errored);
    setNumber(aggregate, "crashed", candidate.crashed);
    return [aggregate];
  });
  return result;
}
function projectClientReport(value: unknown): UnknownRecord | undefined {
  if (!isRecord2(value) || !Array.isArray(value.discarded_events)) return void 0;
  const timestamp2 = finiteNumber(value.timestamp);
  if (timestamp2 === void 0) return void 0;
  const discardedEvents = value.discarded_events.slice(0, 100).flatMap((candidate: unknown) => {
    if (!isRecord2(candidate)) return [];
    const reason = boundedCode(candidate.reason);
    const category = boundedCode(candidate.category);
    const quantity = nonNegativeNumber(candidate.quantity);
    return reason !== void 0 && category !== void 0 && quantity !== void 0 ? [{ reason, category, quantity }] : [];
  });
  return { timestamp: timestamp2, discarded_events: discardedEvents };
}
function projectEnvelopeHeader(value: unknown): UnknownRecord {
  if (!isRecord2(value)) return {};
  const header: UnknownRecord = {};
  setCode(header, "event_id", value.event_id);
  setCode(header, "sent_at", value.sent_at, 64);
  return header;
}
function projectRestrictedItem(item: SandSentryItem, tier: RestrictedPrivacyTier): SandSentryItem | undefined {
  const [header, payload] = item;
  switch (header.type) {
    case "event": {
      const event = tier === "scrubbed" ? projectScrubbedEvent(payload) : projectFatalMetadataEvent(payload);
      return event === void 0 ? void 0 : [{ type: "event" }, event];
    }
    case "session": {
      if (tier !== "scrubbed") return void 0;
      const session3 = projectSession(payload);
      return session3 === void 0 ? void 0 : [{ type: "session" }, session3];
    }
    case "sessions": {
      if (tier !== "scrubbed") return void 0;
      const sessions = projectSessionAggregates(payload);
      return sessions === void 0 ? void 0 : [{ type: "sessions" }, sessions];
    }
    case "client_report": {
      if (tier !== "scrubbed") return void 0;
      const report = projectClientReport(payload);
      return report === void 0 ? void 0 : [{ type: "client_report" }, report];
    }
    default:
      return void 0;
  }
}
function projectSandSentryEnvelope(envelope: SandSentryEnvelope, tier: SandSentryPrivacyTier): SandSentryEnvelope | undefined {
  if (tier === "full") return envelope;
  const items = envelope[1].map((item) => projectRestrictedItem(item, tier)).filter((item) => item !== void 0);
  if (items.length === 0) return void 0;
  return [projectEnvelopeHeader(envelope[0]), items];
}
export { isSandSentryBoundedTagValue, removePropertiesWithPossibleUserInfo, scrubAppUrl, projectSandSentryEnvelope };
