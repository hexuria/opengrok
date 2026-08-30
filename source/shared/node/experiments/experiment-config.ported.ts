/**
 * HAND-AUTHORED gate extensions, and the seam that joins them to the
 * mechanically recovered registry.
 *
 * `experiment-config.gen.ts` is regenerated from the immutable 0.18 evidence
 * artifact and must never be hand-edited, so gates that this reconstruction
 * ports forward from a later release live here instead. The generated registry
 * is spread last: a generated flag always keeps its recovered snapshot value
 * even if an entry below ever collides with one of its names.
 */
import { SAND_NOTIFICATION_SOUNDS_GATE } from "../../notification-sound.js";
import {
  SAND_TRANSCRIPT_DOUBLE_WRITE_GATE,
  SAND_TRANSCRIPT_SERVER_TAIL_GATE,
  SAND_TRANSCRIPT_STORE_FIRST_GATE,
  SAND_TRANSCRIPT_STORE_READ_GATE,
} from "../../transcript-server-gates.js";
import { FLAGS as GENERATED_FLAGS } from "./experiment-config.gen.js";

export const PORTED_FLAGS = {
  // Ported from 0.27. Plays a bundled tone in the renderer when the main
  // process raises an OS notification.
  //
  // 0.27 gated this behind `isAnysphereUser && Statsig`. This snapshot has no
  // isAnysphereUser field and no Statsig entry for the gate, so a closed
  // bundled default would make the settings group and playback path
  // unreachable. Opening the default is the reconstruction-appropriate
  // substitute. `SandExperimentService` does not ask Statsig for PORTED_FLAGS
  // (they are not in the 0.18 catalog). Turn it off locally with
  // SAND_FEATURE_GATE_OVERRIDES=sand_notification_sounds=0 in a dev build, or
  // uncheck "Play Sound for Notifications".
  [SAND_NOTIFICATION_SOUNDS_GATE]: {
    client: true,
    default: true,
  },
  // Ported from 0.27. store_read / server_tail are the main-process List
  // read/tail gates. store_first is renderer-only. double_write is FLAGS-only
  // and adds Commit beside the local write. Unlike sand_notification_sounds
  // they stay CLOSED: opening a main-process gate changes the data path.
  // SandExperimentService does not ask Statsig for PORTED_FLAGS.
  // Turn one on locally with SAND_FEATURE_GATE_OVERRIDES=<name>=1.
  [SAND_TRANSCRIPT_SERVER_TAIL_GATE]: {
    client: true,
    default: false,
  },
  [SAND_TRANSCRIPT_STORE_READ_GATE]: {
    client: true,
    default: false,
  },
  [SAND_TRANSCRIPT_STORE_FIRST_GATE]: {
    client: true,
    default: false,
  },
  [SAND_TRANSCRIPT_DOUBLE_WRITE_GATE]: {
    client: true,
    default: false,
  },
};

export const FLAGS = { ...PORTED_FLAGS, ...GENERATED_FLAGS };
export type FeatureFlagName = keyof typeof FLAGS;
