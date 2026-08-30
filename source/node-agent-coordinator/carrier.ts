import {
  COORDINATOR_CONTROL_CHANNEL,
  COORDINATOR_MAIN_DATA_CHANNEL,
  asCoordinatorControlEnvelope,
  asCoordinatorMainDataEnvelope,
  parseCoordinatorBootstrap,
  type CoordinatorBootstrap,
  type CoordinatorFrame
} from "../shared/rpc/coordinator-port.js";

export const BOOTSTRAP_FLAG = "--bootstrap=";

export interface PortLike {
  postMessage(value: unknown): void;
  on(event: "message" | "close", listener: (event: { readonly data?: unknown; readonly ports?: readonly PortLike[] }) => void): void;
  close?(): void;
  start?(): void;
}

export function isPortLike(value: unknown): value is PortLike {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Partial<PortLike>;
  return typeof candidate.postMessage === "function" && typeof candidate.on === "function";
}

export interface CarrierIntakeHandlers {
  readonly onControlFrame: (value: unknown) => void;
  readonly onDataFrame: (value: unknown) => void;
  readonly onMainDataFrame: (value: unknown) => void;
  readonly onClosed: () => void;
}

export interface CoordinatorCarrier {
  readonly kind: "fork-ipc" | "parent-port";
  readonly bootstrap: CoordinatorBootstrap;
  readonly control: { post(frame: CoordinatorFrame): void; close(): void };
  readonly data: { post(value: unknown): void; close(): void };
  readonly mainData: { post(value: unknown): void; close(): void };
  exitProcess(exitCode: number): void;
  bind(handlers: CarrierIntakeHandlers): void;
}

export type CarrierIntake =
  | { readonly adopted: true; readonly carrier: CoordinatorCarrier }
  | { readonly adopted: false; readonly rejection: { readonly detail: string } };

export function adoptForkIpc(argv: readonly string[]): CarrierIntake {
  const argument = argv.find((value) => value.startsWith(BOOTSTRAP_FLAG));
  if (argument == null) return { adopted: false, rejection: { detail: "missing --bootstrap argument" } };
  let parsed: unknown;
  try { parsed = JSON.parse(argument.slice(BOOTSTRAP_FLAG.length)) as unknown; }
  catch { return { adopted: false, rejection: { detail: "--bootstrap is not valid JSON" } }; }
  const intake = parseCoordinatorBootstrap(parsed);
  if (!intake.accepted) return { adopted: false, rejection: { detail: intake.rejection.detail } };
  const send = process.send?.bind(process);
  if (send == null) return { adopted: false, rejection: { detail: "no renderer data channel was transferred" } };
  let channelClosed = false;
  const closeChannel = () => {
    if (channelClosed) return;
    channelClosed = true;
    if (process.connected) process.disconnect?.();
  };
  const post = (value: unknown) => {
    try { send(value, () => {}); }
    catch {}
  };
  let bound = false;
  return {
    adopted: true,
    carrier: {
      kind: "fork-ipc",
      bootstrap: intake.bootstrap,
      control: { post: (frame) => post({ channel: COORDINATOR_CONTROL_CHANNEL, frame }), close: closeChannel },
      data: { post, close: closeChannel },
      mainData: { post: (frame) => post({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame }), close: closeChannel },
      exitProcess(exitCode) { process.exitCode = exitCode; },
      bind(intakeHandlers) {
        if (bound) return;
        bound = true;
        process.on("message", (value) => {
          const controlEnvelope = asCoordinatorControlEnvelope(value);
          if (controlEnvelope != null) { intakeHandlers.onControlFrame(controlEnvelope.frame); return; }
          const mainDataEnvelope = asCoordinatorMainDataEnvelope(value);
          if (mainDataEnvelope != null) { intakeHandlers.onMainDataFrame(mainDataEnvelope.frame); return; }
          intakeHandlers.onDataFrame(value);
        });
        process.on("disconnect", () => { channelClosed = true; intakeHandlers.onClosed(); });
      }
    }
  };
}

export function adoptParentPort(_parentPort: PortLike, handoff: { readonly data: unknown; readonly ports: readonly PortLike[] }): CarrierIntake {
  const body = handoff.data;
  const bootstrapValue = typeof body === "object" && body != null && "bootstrap" in body
    ? (body as { readonly bootstrap: unknown }).bootstrap
    : null;
  const intake = parseCoordinatorBootstrap(bootstrapValue);
  if (!intake.accepted) return { adopted: false, rejection: { detail: intake.rejection.detail } };
  const [controlPort, dataPort, mainDataPort] = handoff.ports;
  if (!isPortLike(controlPort) || !isPortLike(dataPort) || !isPortLike(mainDataPort)) {
    return { adopted: false, rejection: { detail: "parent handoff did not transfer three message ports" } };
  }
  const closed = { control: false, data: false, mainData: false };
  const closePort = (port: PortLike, key: keyof typeof closed) => {
    if (closed[key]) return;
    closed[key] = true;
    port.close?.();
  };
  const postTo = (port: PortLike, key: keyof typeof closed, value: unknown) => {
    if (closed[key]) return;
    try { port.postMessage(value); }
    catch {}
  };
  let bound = false;
  return {
    adopted: true,
    carrier: {
      kind: "parent-port",
      bootstrap: intake.bootstrap,
      control: { post: (frame) => postTo(controlPort, "control", frame), close: () => closePort(controlPort, "control") },
      data: { post: (value) => postTo(dataPort, "data", value), close: () => closePort(dataPort, "data") },
      mainData: { post: (value) => postTo(mainDataPort, "mainData", value), close: () => closePort(mainDataPort, "mainData") },
      exitProcess(exitCode) { process.exitCode = exitCode; process.exit(exitCode); },
      bind(intakeHandlers) {
        if (bound) return;
        bound = true;
        controlPort.on("message", (event) => intakeHandlers.onControlFrame(event.data));
        controlPort.on("close", () => { closed.control = true; intakeHandlers.onClosed(); });
        dataPort.on("message", (event) => intakeHandlers.onDataFrame(event.data));
        dataPort.on("close", () => { closed.data = true; intakeHandlers.onClosed(); });
        mainDataPort.on("message", (event) => intakeHandlers.onMainDataFrame(event.data));
        mainDataPort.on("close", () => { closed.mainData = true; intakeHandlers.onClosed(); });
        controlPort.start?.();
        dataPort.start?.();
        mainDataPort.start?.();
      }
    }
  };
}

export function adoptCarrier(): Promise<CarrierIntake> {
  const parentPort = (process as NodeJS.Process & { readonly parentPort?: unknown }).parentPort;
  if (parentPort != null && isPortLike(parentPort)) {
    return new Promise((resolve) => {
      parentPort.on("message", (event) => resolve(adoptParentPort(parentPort, { data: event.data, ports: event.ports ?? [] })));
      parentPort.start?.();
    });
  }
  return Promise.resolve(adoptForkIpc(process.argv));
}
