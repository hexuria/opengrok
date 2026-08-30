export const SAND_BOX_IMAGE_TAG_PREFIX = "sand-box-";
export const SAND_BOX_IMAGE_TAG_LATEST = `${SAND_BOX_IMAGE_TAG_PREFIX}latest`;
export const SHORT_GIT_SHA_REGEX = /^[0-9a-f]{7,40}$/;
export const SAND_BOX_PRIMARY_NOVNC_PORT = 6080;
export const SAND_BOX_FORK_NOVNC_PORT = 6081;
export const SAND_SPECIAL_TREATMENT_NOVNC_PATH = "sand-special-treatment-v1/vnc.html";

export function buildSandBoxNoVncUrl(proxyBaseUrl: string, networkToken: string, token?: string, specialTreatment = false): string {
  const wake = "resume_lower_s=900&resume_upper_s=18000";
  const tokenParam = token === undefined ? "" : `token=${token}&`;
  const websockifyPath = `websockify?${tokenParam}network_token=${networkToken}&${wake}`;
  const viewerPath = specialTreatment ? SAND_SPECIAL_TREATMENT_NOVNC_PATH : "vnc.html";
  return `${proxyBaseUrl}/${viewerPath}?network_token=${networkToken}&${wake}&path=${encodeURIComponent(websockifyPath)}`;
}

export function isSandSpecialTreatmentNoVncUrl(value: string): boolean {
  try {
    return new URL(value).pathname.endsWith(`/${SAND_SPECIAL_TREATMENT_NOVNC_PATH}`);
  } catch {
    return false;
  }
}
