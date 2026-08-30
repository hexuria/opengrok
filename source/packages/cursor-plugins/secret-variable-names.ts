const SECRET_WORDS = new Set(["CREDENTIAL", "CREDENTIALS", "KEY", "PASSPHRASE", "PASSWORD", "SECRET", "TOKEN"]);
function toSegments(name: string): string[] { return name.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/[^a-z\d]+/gi, "_").toUpperCase().split("_").filter(Boolean); }
export const isSecretPluginVariableName = (name: string): boolean => toSegments(name).some((segment) => SECRET_WORDS.has(segment));
