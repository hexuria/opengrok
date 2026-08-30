import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { getConfigDir } from "./paths.js";
import { parsePermissionsAutoRunConfig } from "./project-permissions-file-provider.js";

export interface PermissionsAutoRunInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

export interface Permissions {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface EffectivePermissions extends Permissions {
  readonly approvalMode: "unrestricted";
  readonly userConfiguredPolicy: { readonly type: "insecure_none" };
}

export type PermissionsTransformer = (permissions: Permissions) => Permissions | void;

export class PermissionsFileProvider {
  private readonly permissions: Permissions;
  private readonly autoRunInstructions: {
    allowInstructions: readonly string[];
    blockInstructions: readonly string[];
  };

  constructor(
    permissions: Permissions,
    autoRunInstructions: PermissionsAutoRunInstructions,
  ) {
    this.permissions = permissions;
    this.autoRunInstructions = autoRunInstructions;
  }

  static getPermissionsFilePath(): string {
    return join(getConfigDir(), "permissions.json");
  }

  static async load(filePath?: string): Promise<PermissionsFileProvider | undefined> {
    const path = filePath ?? PermissionsFileProvider.getPermissionsFilePath();
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      const raw = await readFile(path, "utf8");
      const parsed = parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return undefined;
      }
      const config = parsed as Record<string, unknown>;
      const mcpEntries = filterStrings(getFieldCaseInsensitive(config, "mcpAllowlist"));
      const terminalEntries = filterStrings(getFieldCaseInsensitive(config, "terminalAllowlist"));
      const autoRunConfig =
        getFieldCaseInsensitive(config, "autoReview") ??
        getFieldCaseInsensitive(config, "autoRun");
      const autoRun = parsePermissionsAutoRunConfig(autoRunConfig);
      const autoRunInstructions = {
        allowInstructions: autoRun?.allowInstructions ?? [],
        blockInstructions: autoRun?.blockInstructions ?? [],
      };
      if (
        mcpEntries.length === 0 &&
        terminalEntries.length === 0 &&
        autoRunInstructions.allowInstructions.length === 0 &&
        autoRunInstructions.blockInstructions.length === 0
      ) {
        return undefined;
      }
      const allow = [
        ...terminalEntries.map(command => `Shell(${command})`),
        ...mcpEntries.map(entry => `Mcp(${entry})`),
      ];
      return new PermissionsFileProvider({ allow, deny: [] }, autoRunInstructions);
    } catch {
      return undefined;
    }
  }

  async getPermissions(): Promise<EffectivePermissions> {
    return {
      allow: this.permissions.allow,
      deny: this.permissions.deny,
      approvalMode: "unrestricted",
      userConfiguredPolicy: { type: "insecure_none" },
    };
  }

  getAutoRunInstructions(): PermissionsAutoRunInstructions {
    return {
      allowInstructions: [...this.autoRunInstructions.allowInstructions],
      blockInstructions: [...this.autoRunInstructions.blockInstructions],
    };
  }

  async updatePermissions(transformer: PermissionsTransformer): Promise<void> {
    void transformer;
  }
}

function filterStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function getFieldCaseInsensitive(
  object: Record<string, unknown>,
  key: string,
): unknown {
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(object)) {
    if (candidate.toLowerCase() === lower) {
      return object[candidate];
    }
  }
  return undefined;
}
