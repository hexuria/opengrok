import { z } from "zod";
export const CapabilitySchema = z.enum(["canvas"]);
export const CapabilitiesSchema = z.array(CapabilitySchema).transform((capabilities) => [...new Set(capabilities)].sort());
export type Capability = z.infer<typeof CapabilitySchema>;
