export const AGENTS_SECTION_ID = "__agents__";
export const AGENTS_SECTION_NAME = "Unassigned";
export interface SidebarSection { readonly id: string; readonly name: string; readonly agentIds: readonly string[]; readonly isCollapsed?: boolean; }
const NO_SIDEBAR_SECTIONS: readonly SidebarSection[] = [];
export class SidebarSections {
  static normalize(sections: readonly SidebarSection[]): readonly SidebarSection[] {
    const seenSectionIds = new Set<string>(); const claimedAgentIds = new Set<string>(); const normalized: SidebarSection[] = [];
    for (const section of sections) {
      const id = section.id.trim(); if (id.length === 0 || seenSectionIds.has(id)) continue;
      seenSectionIds.add(id); if (id === AGENTS_SECTION_ID) continue;
      const agentIds: string[] = [];
      for (const agentId of section.agentIds) { if (agentId.length === 0 || claimedAgentIds.has(agentId)) continue; claimedAgentIds.add(agentId); agentIds.push(agentId); }
      normalized.push({ id, name: section.name, agentIds });
    }
    if (normalized.length === 0) return NO_SIDEBAR_SECTIONS;
    normalized.push({ id: AGENTS_SECTION_ID, name: AGENTS_SECTION_NAME, agentIds: [] });
    return normalized;
  }
  static parse(value: readonly unknown[]): readonly SidebarSection[] {
    const records: SidebarSection[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry == null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>; if (typeof record.id !== "string") continue;
      records.push({ id: record.id, name: typeof record.name === "string" ? record.name : "", agentIds: Array.isArray(record.agentIds) ? record.agentIds.filter((id): id is string => typeof id === "string") : [] });
    }
    return SidebarSections.normalize(records);
  }
  static withFolds(sections: readonly SidebarSection[], collapsedSectionIds: readonly string[]): SidebarSection[] { const collapsed = new Set(collapsedSectionIds); return sections.map((section) => ({ ...section, isCollapsed: collapsed.has(section.id) })); }
  static carryFolds(args: { readonly sections: readonly SidebarSection[]; readonly stored?: readonly SidebarSection[] }): SidebarSection[] {
    const foldBySectionId = new Map<string, boolean>();
    for (const section of [...(args.stored ?? []), ...args.sections]) if (section.isCollapsed !== undefined) foldBySectionId.set(section.id.trim(), section.isCollapsed);
    return SidebarSections.normalize(args.sections).map((section) => ({ ...section, isCollapsed: foldBySectionId.get(section.id) ?? false }));
  }
}
