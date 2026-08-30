export interface ProjectDetails { subagent?: unknown; sideChat?: unknown }
export function isRootProjectDetails(projectDetails: ProjectDetails | null | undefined): boolean {
  return projectDetails != null && projectDetails.subagent === undefined && projectDetails.sideChat === undefined;
}
