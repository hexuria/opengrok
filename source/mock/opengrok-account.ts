/*
 * The OpenGrok account API, mocked.
 *
 * The desktop reaches two different backends and only one of them had a mock.
 * `GrokBotService` — the upstream Connect protocol — is mocked here in full.
 * The *account* API is not: `/models`, `/coworkers` and the rest are served by
 * the OpenGrok server over plain JSON (see
 * electron-main/box/opengrok-account-call.ts), and nothing in this repository
 * could answer them.
 *
 * That left the model picker impossible to exercise without the whole stack: a
 * Rust server, a Postgres, a gateway, and a schema in that gateway's database
 * holding a catalogue. On 2026-09-08 the last of those was gone — the gateway's
 * dev Postgres mounts its data directory as tmpfs, Docker restarted, and
 * `/v1/models` began answering 500 — and there was no way to drive the picker
 * at all while it lasted. That is what this mock is for: the desktop half,
 * without any of the other half.
 *
 * Not to be confused with a different empty-catalogue branch on the server: a
 * deployment that sets no gateway variables has no catalogue to ask and answers
 * `[]` with a note saying so. That one is real but is NOT why the picker was
 * empty here — this machine has `OG_GATEWAY_TOKEN` set, so the server did call
 * its gateway, and the gateway is what failed (server session's correction,
 * 2026-09-08). A dev catalogue would not have prevented it; restoring the
 * schema would.
 *
 * The catalogue below is not a token list. It is chosen to drive every branch
 * the picker has: the `oag/` ladder group, plain pins, both `@` suffixes, an
 * entry with no points at all, and more than nine rows so the list scrolls.
 */

/** Points multipliers as the gateway states them: strings, not numbers. */
export interface MockModelPoints {
  readonly shownX: string;
  readonly inputX: string;
  readonly outputX: string;
  readonly cacheReadX: string;
  readonly cacheWriteX: string;
}

export interface MockModelEntry {
  readonly id: string;
  /** null is a real answer: a gateway with no reference price for this model. */
  readonly points: MockModelPoints | null;
}

const points = (shown: string, input: string, output: string, read: string, write: string): MockModelPoints =>
  ({ shownX: shown, inputX: input, outputX: output, cacheReadX: read, cacheWriteX: write });

/**
 * What the mock gateway advertises.
 *
 * `oag/*` ids are the ladder — the picker groups them under "Let the gateway
 * choose" purely on that prefix — and everything else is a pin. Keep at least
 * one entry with null points and at least one of each `@` suffix, or the
 * picker's own branches stop being covered.
 */
export const MOCK_MODEL_CATALOGUE: readonly MockModelEntry[] = [
  { id: "oag/auto", points: points("1", "1", "1", "0.1", "1.25") },
  { id: "oag/fast", points: points("0.5", "0.5", "0.5", "0.05", "0.6") },
  { id: "oag/frontier", points: points("4", "4", "4", "0.4", "5") },
  { id: "xai/grok-4.6@sub", points: points("1", "1", "1", "0.1", "1.25") },
  { id: "xai/grok-4.6", points: points("1.5", "1.5", "1.5", "0.15", "1.9") },
  { id: "xai/grok-4.6-mini", points: points("0.25", "0.25", "0.25", "0.03", "0.3") },
  { id: "anthropic/claude-opus-4-6@api", points: points("10", "10", "10", "1", "12.5") },
  { id: "anthropic/claude-sonnet-4-5", points: points("3", "3", "3", "0.3", "3.75") },
  { id: "openai/gpt-5.5", points: points("2.5", "2.5", "2.5", "0.25", "3.1") },
  { id: "openai/gpt-5-mini", points: points("0.4", "0.4", "0.4", "0.04", "0.5") },
  { id: "google/gemini-3-pro", points: points("2", "2", "2", "0.2", "2.5") },
  // No reference price. The picker must show this one with no ×N and an empty
  // hover rather than skipping it or printing "×undefined".
  { id: "meta/llama-4-405b", points: null },
];

/** What a coworker is pinned to before anybody changes it. */
export const MOCK_DEFAULT_MODEL = "xai/grok-4.6@sub";

export interface MockCoworkerRow {
  readonly id: string;
  readonly name: string;
  readonly model: string;
}

export interface MockAccountAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * The pins, which are the only thing here that changes. The catalogue is fixed;
 * `PATCH /coworkers/{id}` moves a pin and `GET /coworkers` reads them back, so
 * the picker's save-then-reload round trip is a real round trip.
 */
export class MockOpenGrokAccount {
  private readonly pins = new Map<string, string>();

  constructor(private readonly defaultModel: string = MOCK_DEFAULT_MODEL) {}

  /** `GET /models`. No note: the client only reads one when the list is empty. */
  catalogue(): { readonly models: readonly MockModelEntry[] } {
    return { models: MOCK_MODEL_CATALOGUE };
  }

  modelFor(agentId: string): string {
    return this.pins.get(agentId) ?? this.defaultModel;
  }

  /**
   * `GET /coworkers`. A bare array, which is what the real server sends — the
   * desktop reads a wrapped shape too, but an empty roster must not become an
   * object, so the array is the shape to mock.
   */
  coworkers(agents: readonly MockAccountAgent[]): MockCoworkerRow[] {
    return agents.map((agent) => ({ id: agent.id, name: agent.name, model: this.modelFor(agent.id) }));
  }

  /**
   * `PATCH /coworkers/{id}`. Nothing checks the id against the catalogue, here
   * or on the real server: a typed model is a legitimate pin, and one the
   * gateway will not serve is fixed by picking another.
   */
  pin(agentId: string, model: string): MockCoworkerRow {
    this.pins.set(agentId, model);
    return { id: agentId, name: agentId, model };
  }
}
