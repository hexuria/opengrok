import { createHash } from "node:crypto";

const HELPER_NAME = /^Grok Bot(?: Lab)? Helper(?: \((?:GPU|Plugin|Renderer)\))?$/;

export function hashProcessName(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function sanitizeProcessName(name: string): { readonly name: string; readonly nameHash: string } {
  const nameHash = hashProcessName(name);
  const label = basename(name).trim();
  if (HELPER_NAME.test(label)) return { name: label, nameHash };
  const [firstToken] = label.split(/\s+/);
  return { name: firstToken ?? "", nameHash };
}
