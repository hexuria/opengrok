import { randomUUID } from "node:crypto";

export interface ReplicaStamp {
  replicaKey: string;
  epoch: string;
  sequence: number;
}

export interface ReplicaSnapshot<T, C = string> {
  replicaKey: string;
  epoch: string;
  throughSequence: number;
  coverage: C;
  value: T;
}

/** Per-process ordering authority for every independently replicated surface. */
export class HostReplicaWriter {
  readonly #epoch: string;
  readonly #sequences = new Map<string, number>();

  constructor(epoch = randomUUID()) {
    this.#epoch = epoch;
  }

  get processEpoch(): string {
    return this.#epoch;
  }

  /** Reserve before reading the content described by the stamp. */
  nextStamp(replicaKey: string): ReplicaStamp {
    const sequence = (this.#sequences.get(replicaKey) ?? 0) + 1;
    this.#sequences.set(replicaKey, sequence);
    return { replicaKey, epoch: this.#epoch, sequence };
  }

  lastSequence(replicaKey: string): number {
    return this.#sequences.get(replicaKey) ?? 0;
  }

  captureSnapshot<T, C = string>(
    replicaKey: string,
    coverage: C,
    value: T,
  ): ReplicaSnapshot<T, C> {
    return {
      replicaKey,
      epoch: this.#epoch,
      throughSequence: this.lastSequence(replicaKey),
      coverage,
      value,
    };
  }
}
