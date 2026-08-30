import path from "node:path";

export const NATIVE_OBSERVATION_SCHEMA_VERSION = 1;
export const NATIVE_OBSERVATION_REPORT_KIND = "native-observation";
export const NATIVE_OBSERVATION_CLASSES = Object.freeze({
  structuralOnly: "structural-only",
  preloadReplacementMain: "non-production-replacement-main-preload-harness",
  coordinatorNode: "non-production-coordinator-node-harness",
  coordinatorNativeReplacementMain: "non-production-coordinator-native-harness",
  prerequisiteNoLaunch: "deterministic-prerequisite-no-launch",
  productionStartup: "admissible-production-startup-observation",
});
export const NATIVE_OBSERVATION_ENV_DENYLIST = Object.freeze([
  "GROK_BOT_RECONSTRUCTED_DEV",
  "ELECTRON_RUN_AS_NODE",
  "VITE_DEV_SERVER_URL",
  "SAND_DEV_LOGIN",
  "SAND_DEV_LOGIN_EMAIL",
  "SAND_BACKEND_URL",
  "CURSOR_API_BASE_URL",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_V8_COVERAGE",
  "ELECTRON_LOG_FILE",
  "ELECTRON_ENABLE_LOGGING",
  "SAND_HOST_GATEWAY_URL",
  "SAND_HOST_GATEWAY_TOKEN",
  "SAND_HOST_GATEWAY_NETWORK_TOKEN",
  "SAND_FEATURE_GATE_OVERRIDES",
  "SAND_MODEL_EXPERIMENT_OVERRIDE",
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion",
  "reportKind",
  "observationClass",
  "status",
  "generatedAt",
  "provenance",
  "diagnostics",
  "observedProcessWindow",
  "payload",
]);
const PROVENANCE_FIELDS = Object.freeze([
  "producer",
  "targetRealpath",
  "applicationsLocation",
  "environmentDenylist",
  "mockKeychainCapability",
  "freshRoots",
  "productionStartup",
  "replacementMain",
]);
const APPLICATIONS_FIELDS = Object.freeze(["systemRoot", "status"]);
const ENVIRONMENT_FIELDS = Object.freeze(["keys", "deniedKeysAbsent"]);
const FRESH_ROOT_FIELDS = Object.freeze(["status", "userDataDir", "dataRoot"]);
const DIAGNOSTIC_FIELDS = Object.freeze(["check", "status", "detail"]);
const PROCESS_WINDOW_FIELDS = Object.freeze([
  "carrier",
  "durationMs",
  "completed",
  "renderer",
  "host",
  "coordinator",
  "daemon",
]);
const PRODUCERS = new Set([
  "native-e2e",
  "runtime-entrypoint-smoke",
  "native-preload-observation",
  "coordinator-channel-e2e",
  "coordinator-production-native-observation",
]);
const CLASS_STATUSES = Object.freeze({
  [NATIVE_OBSERVATION_CLASSES.structuralOnly]: new Set(["pass", "fail"]),
  [NATIVE_OBSERVATION_CLASSES.preloadReplacementMain]: new Set(["pass", "fail"]),
  [NATIVE_OBSERVATION_CLASSES.coordinatorNode]: new Set(["pass", "fail"]),
  [NATIVE_OBSERVATION_CLASSES.coordinatorNativeReplacementMain]: new Set(["pass", "fail"]),
  [NATIVE_OBSERVATION_CLASSES.prerequisiteNoLaunch]: new Set(["prerequisite"]),
  [NATIVE_OBSERVATION_CLASSES.productionStartup]: new Set(["pass", "fail"]),
});
const CLASS_PRODUCERS = Object.freeze({
  [NATIVE_OBSERVATION_CLASSES.structuralOnly]: new Set(["native-e2e", "runtime-entrypoint-smoke"]),
  [NATIVE_OBSERVATION_CLASSES.preloadReplacementMain]: new Set(["native-preload-observation"]),
  [NATIVE_OBSERVATION_CLASSES.coordinatorNode]: new Set(["coordinator-channel-e2e"]),
  [NATIVE_OBSERVATION_CLASSES.coordinatorNativeReplacementMain]: new Set(["coordinator-production-native-observation"]),
  [NATIVE_OBSERVATION_CLASSES.prerequisiteNoLaunch]: new Set(PRODUCERS),
  [NATIVE_OBSERVATION_CLASSES.productionStartup]: new Set(["native-e2e", "runtime-entrypoint-smoke"]),
});

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, fields, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be a plain object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${label} fields must be exactly ${expected.join(", ")}; received ${actual.join(", ")}`);
  return true;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isNormalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function isSystemApplicationsTarget(value) {
  return isNormalizedAbsolute(value) && value.startsWith("/Applications/") && value !== "/Applications/";
}

function isBooleanOrNull(value) {
  return value === null || typeof value === "boolean";
}

function jsonValue(value, label, errors, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") {
    errors.push(`${label} contains non-JSON value ${typeof value}`);
    return;
  }
  if (seen.has(value)) {
    errors.push(`${label} contains a cycle`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => jsonValue(entry, `${label}[${index}]`, errors, seen));
  else if (Object.getPrototypeOf(value) !== Object.prototype) errors.push(`${label} contains a non-plain object`);
  else for (const [key, entry] of Object.entries(value)) jsonValue(entry, `${label}.${key}`, errors, seen);
  seen.delete(value);
}

export function validateNativeObservationReport(report) {
  const errors = [];
  if (!exactFields(report, TOP_LEVEL_FIELDS, "report", errors)) return { valid: false, errors };
  if (report.schemaVersion !== NATIVE_OBSERVATION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${NATIVE_OBSERVATION_SCHEMA_VERSION}`);
  if (report.reportKind !== NATIVE_OBSERVATION_REPORT_KIND) errors.push(`reportKind must be ${NATIVE_OBSERVATION_REPORT_KIND}`);
  const statuses = CLASS_STATUSES[report.observationClass];
  if (statuses == null) errors.push(`unknown observationClass ${String(report.observationClass)}`);
  else if (!statuses.has(report.status)) errors.push(`${report.observationClass} does not allow status ${String(report.status)}`);
  if (!isIsoTimestamp(report.generatedAt)) errors.push("generatedAt must be an exact UTC ISO timestamp");

  const provenance = report.provenance;
  if (exactFields(provenance, PROVENANCE_FIELDS, "provenance", errors)) {
    if (!PRODUCERS.has(provenance.producer)) errors.push(`unknown provenance producer ${String(provenance.producer)}`);
    else if (CLASS_PRODUCERS[report.observationClass] != null && !CLASS_PRODUCERS[report.observationClass].has(provenance.producer)) errors.push(`${report.observationClass} cannot be produced by ${provenance.producer}`);
    if (provenance.targetRealpath !== null && !isNormalizedAbsolute(provenance.targetRealpath)) errors.push("provenance.targetRealpath must be null or a normalized absolute path");
    if (typeof provenance.productionStartup !== "boolean") errors.push("provenance.productionStartup must be boolean");
    if (typeof provenance.replacementMain !== "boolean") errors.push("provenance.replacementMain must be boolean");
    if (provenance.productionStartup === true && provenance.replacementMain === true) errors.push("productionStartup and replacementMain cannot both be true");

    const applications = provenance.applicationsLocation;
    if (exactFields(applications, APPLICATIONS_FIELDS, "provenance.applicationsLocation", errors)) {
      if (applications.systemRoot !== "/Applications") errors.push("applicationsLocation.systemRoot must be exactly /Applications");
      if (!["accepted", "refused", "not-applicable"].includes(applications.status)) errors.push("applicationsLocation.status is invalid");
      if (applications.status === "accepted" && !isSystemApplicationsTarget(provenance.targetRealpath)) errors.push("accepted Applications provenance requires exact containment below system /Applications");
    }

    const environment = provenance.environmentDenylist;
    if (exactFields(environment, ENVIRONMENT_FIELDS, "provenance.environmentDenylist", errors)) {
      if (JSON.stringify(environment.keys) !== JSON.stringify(NATIVE_OBSERVATION_ENV_DENYLIST)) errors.push("environmentDenylist.keys must equal the frozen production denylist in exact order");
      if (environment.deniedKeysAbsent !== null && typeof environment.deniedKeysAbsent !== "boolean") errors.push("environmentDenylist.deniedKeysAbsent must be boolean or null");
    }

    if (!["present", "absent", "not-applicable"].includes(provenance.mockKeychainCapability)) errors.push("mockKeychainCapability is invalid");
    const roots = provenance.freshRoots;
    if (exactFields(roots, FRESH_ROOT_FIELDS, "provenance.freshRoots", errors)) {
      if (!["isolated", "not-applicable"].includes(roots.status)) errors.push("freshRoots.status is invalid");
      if (roots.status === "not-applicable" && (roots.userDataDir !== null || roots.dataRoot !== null)) errors.push("not-applicable freshRoots must use null paths");
      if (roots.status === "isolated" && (!isNormalizedAbsolute(roots.userDataDir) || !isNormalizedAbsolute(roots.dataRoot))) errors.push("isolated freshRoots require normalized absolute paths");
    }
  }

  if (!Array.isArray(report.diagnostics) || report.diagnostics.length === 0) errors.push("diagnostics must be a non-empty array");
  else report.diagnostics.forEach((diagnostic, index) => {
    if (!exactFields(diagnostic, DIAGNOSTIC_FIELDS, `diagnostics[${index}]`, errors)) return;
    if (typeof diagnostic.check !== "string" || diagnostic.check.length === 0) errors.push(`diagnostics[${index}].check must be non-empty`);
    if (!["pass", "fail", "skip"].includes(diagnostic.status)) errors.push(`diagnostics[${index}].status is invalid`);
    if (typeof diagnostic.detail !== "string" || diagnostic.detail.length === 0) errors.push(`diagnostics[${index}].detail must be non-empty`);
  });
  if (Array.isArray(report.diagnostics)) {
    const hasFailure = report.diagnostics.some((diagnostic) => diagnostic?.status === "fail");
    if (report.status === "pass" && hasFailure) errors.push("pass status cannot contain a failing diagnostic");
    if (report.status === "fail" && !hasFailure) errors.push("fail status requires a failing diagnostic");
    if (report.status === "prerequisite" && report.diagnostics.every((diagnostic) => diagnostic?.status === "pass")) errors.push("prerequisite status requires a skipped or failing diagnostic");
  }

  const window = report.observedProcessWindow;
  if (exactFields(window, PROCESS_WINDOW_FIELDS, "observedProcessWindow", errors)) {
    if (!["none", "node-worker", "electron-window"].includes(window.carrier)) errors.push("observedProcessWindow.carrier is invalid");
    if (window.durationMs !== null && (!Number.isInteger(window.durationMs) || window.durationMs < 0)) errors.push("observedProcessWindow.durationMs must be a non-negative integer or null");
    if (typeof window.completed !== "boolean") errors.push("observedProcessWindow.completed must be boolean");
    for (const key of ["renderer", "host", "coordinator", "daemon"]) if (!isBooleanOrNull(window[key])) errors.push(`observedProcessWindow.${key} must be boolean or null`);
    if (window.carrier === "none" && (window.durationMs !== null || window.completed !== false || [window.renderer, window.host, window.coordinator, window.daemon].some((value) => value !== null))) errors.push("carrier none requires an unobserved process window");
    if (window.carrier !== "none" && window.durationMs === null) errors.push("observed carrier requires durationMs");
  }

  if (!isRecord(report.payload)) errors.push("payload must be a plain producer-detail object");
  else jsonValue(report.payload, "payload", errors);

  const observationClass = report.observationClass;
  if (observationClass === NATIVE_OBSERVATION_CLASSES.structuralOnly) {
    if (provenance?.productionStartup !== false || provenance?.replacementMain !== false) errors.push("structural-only must not claim production startup or replacement main");
    if (window?.carrier !== "none") errors.push("structural-only must not have a process carrier");
  }
  if (observationClass === NATIVE_OBSERVATION_CLASSES.preloadReplacementMain) {
    if (provenance?.productionStartup !== false || provenance?.replacementMain !== true || window?.carrier !== "electron-window") errors.push("preload replacement-main class requires non-production electron-window replacement-main provenance");
    if (report.status === "pass" && window?.completed !== true) errors.push("passing preload replacement-main observation requires a completed process window");
  }
  if (observationClass === NATIVE_OBSERVATION_CLASSES.coordinatorNode) {
    if (provenance?.productionStartup !== false || provenance?.replacementMain !== false || window?.carrier !== "node-worker") errors.push("coordinator Node class requires non-production node-worker provenance");
    if (report.status === "pass" && window?.completed !== true) errors.push("passing coordinator Node observation requires a completed process window");
  }
  if (observationClass === NATIVE_OBSERVATION_CLASSES.coordinatorNativeReplacementMain) {
    if (provenance?.productionStartup !== false || provenance?.replacementMain !== true || window?.carrier !== "electron-window") errors.push("coordinator native class requires non-production electron-window replacement-main provenance");
    if (report.status === "pass" && window?.completed !== true) errors.push("passing coordinator native observation requires a completed process window");
  }
  if (observationClass === NATIVE_OBSERVATION_CLASSES.prerequisiteNoLaunch) {
    if (report.status !== "prerequisite" || window?.carrier !== "none") errors.push("prerequisite-no-launch requires prerequisite status and no process carrier");
    if (["native-preload-observation", "coordinator-production-native-observation"].includes(provenance?.producer) && (provenance?.productionStartup !== false || provenance?.replacementMain !== true)) errors.push("replacement-main harness prerequisite provenance must retain non-production replacement-main intent");
    if (provenance?.producer === "coordinator-channel-e2e" && (provenance?.productionStartup !== false || provenance?.replacementMain !== false)) errors.push("coordinator Node prerequisite provenance must retain non-production node-worker intent");
    if (["native-e2e", "runtime-entrypoint-smoke"].includes(provenance?.producer) && provenance?.replacementMain !== false) errors.push("production/structural prerequisite provenance cannot claim a replacement main");
  }
  if (observationClass === NATIVE_OBSERVATION_CLASSES.productionStartup) {
    if (provenance?.productionStartup !== true || provenance?.replacementMain !== false) errors.push("production-startup requires production main without replacement");
    if (provenance?.applicationsLocation?.status !== "accepted" || !isSystemApplicationsTarget(provenance?.targetRealpath)) errors.push("production-startup requires exact system /Applications acceptance");
    if (provenance?.environmentDenylist?.deniedKeysAbsent !== true) errors.push("production-startup requires every denied environment key absent");
    if (provenance?.mockKeychainCapability !== "present") errors.push("production-startup requires packaged mock-Keychain capability");
    if (provenance?.freshRoots?.status !== "isolated" || provenance.freshRoots.dataRoot !== path.join(provenance.freshRoots.userDataDir ?? "", "sand-data")) errors.push("production-startup requires fresh absolute user-data and sand-data roots");
    if (window?.carrier !== "electron-window" || window.completed !== true) errors.push("production-startup requires a completed electron-window observation");
    const sandLabDiagnostics = Array.isArray(report.diagnostics)
      ? report.diagnostics.filter((diagnostic) => diagnostic?.check === "package:sand-lab")
      : [];
    if (sandLabDiagnostics.length !== 1 || sandLabDiagnostics[0]?.status !== "pass") errors.push("production-startup requires exactly one passing package:sand-lab diagnostic");
    if (report.status === "pass" && (window?.renderer !== true || window?.host !== false || window?.coordinator !== false)) errors.push("passing production startup requires renderer present with host/coordinator absent for a fresh logged-out profile");
  }

  return { valid: errors.length === 0, errors };
}

export function assertNativeObservationReport(report) {
  const validation = validateNativeObservationReport(report);
  if (!validation.valid) throw new TypeError(`Invalid native observation report: ${validation.errors.join("; ")}`);
  return report;
}
