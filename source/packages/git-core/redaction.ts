const HTTP_URL_PATTERN = /https?:\/\/\S+/gi;
const TRAILING_URL_WRAPPER = /[)"'<>,.;:\]}]$/;
function splitTrailingUrlWrappers(candidate: string): { url: string; wrappers: string } {
  let urlEnd = candidate.length;
  while (urlEnd > 0 && TRAILING_URL_WRAPPER.test(candidate.slice(urlEnd - 1, urlEnd))) urlEnd -= 1;
  return { url: candidate.slice(0, urlEnd), wrappers: candidate.slice(urlEnd) };
}
function redactHttpUrlCandidate(candidate: string): string {
  const { url, wrappers } = splitTrailingUrlWrappers(candidate);
  const sensitiveSuffixStart = url.search(/[?#]/);
  const clean = sensitiveSuffixStart === -1 ? url : url.slice(0, sensitiveSuffixStart), authorityStart = clean.indexOf("//") + 2;
  const delimiter = clean.slice(authorityStart).search(/[/?#]/), authorityEnd = delimiter === -1 ? clean.length : authorityStart + delimiter;
  const userinfoEnd = clean.lastIndexOf("@", authorityEnd - 1);
  return userinfoEnd < authorityStart ? clean + wrappers : clean.slice(0, authorityStart) + clean.slice(userinfoEnd + 1) + wrappers;
}
export const redactHttpUrlUserinfo = (value: string): string => value.replace(HTTP_URL_PATTERN, redactHttpUrlCandidate);
