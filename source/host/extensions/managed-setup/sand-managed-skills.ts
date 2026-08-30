import { clampWorkflowBody, clampWorkflowDescription, clampWorkflowName, parseWorkflowFile } from "../../../shared/workflow-model.js";
import { isSafeFolderId } from "../../storage/folder-id.js";
import type { ManagedSkill } from "./managed-skills-cache.js";

export interface FetchedManagedSkill { id: string; description: string; content: string; enabled: boolean }

export function fetchedManagedSkillToSandSkill(skill: FetchedManagedSkill): ManagedSkill | null {
  if (!skill.enabled) return null;
  const id = skill.id.trim(); if (!isSafeFolderId(id)) return null;
  const parsed = parseWorkflowFile(skill.content); const body = clampWorkflowBody(parsed?.body ?? skill.content); if (body.trim().length === 0) return null;
  const name = clampWorkflowName(parsed?.name != null && parsed.name.length > 0 ? parsed.name : id); if (name.length === 0) return null;
  return { id, name, description: clampWorkflowDescription(parsed?.description != null && parsed.description.length > 0 ? parsed.description : skill.description), body };
}
