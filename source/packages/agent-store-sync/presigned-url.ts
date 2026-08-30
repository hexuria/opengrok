class PresignedUrlRejectedError extends Error {
  readonly code: string;
  readonly url: string;

  constructor(options: { readonly code: string; readonly message: string; readonly url: string }) {
    super(options.message);
    this.name = "PresignedUrlRejectedError";
    this.code = options.code;
    this.url = options.url;
  }
}

function defaultPresignedUrlValidator(url: URL): void {
  assertSafeAuthority(url);
  if (url.protocol !== "https:") {
    throw new PresignedUrlRejectedError({
      code: "scheme_not_allowed",
      message: `Refused presigned URL with non-https scheme: ${url.protocol}`,
      url: redactPresignedUrlString(url),
    });
  }
  const hostname = stripIPv6Brackets(url.hostname);
  if (isLocalOrInternalHost(hostname)) {
    throw new PresignedUrlRejectedError({
      code: "private_host_not_allowed",
      message: `Refused https presigned URL with private/internal host: ${hostname}`,
      url: redactPresignedUrlString(url),
    });
  }
  if (!isAwsS3Hostname(hostname)) {
    throw new PresignedUrlRejectedError({
      code: "host_not_allowed",
      message: `Refused presigned URL whose host is not an AWS S3 endpoint: ${hostname}`,
      url: redactPresignedUrlString(url),
    });
  }
}

function isAwsS3Hostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered !== "amazonaws.com" && !lowered.endsWith(".amazonaws.com")) {
    return false;
  }
  const labels = lowered.split(".");
  return labels.some(label => S3_OBJECT_LABELS.has(label));
}

const S3_OBJECT_LABELS = new Set(["s3", "s3-accelerate", "s3-fips"]);

function createHostAllowlistValidator(allowedHosts: readonly string[]): (url: URL) => void {
  const allowed = new Set(allowedHosts.map(host => host.toLowerCase()));
  return url => {
    defaultPresignedUrlValidator(url);
    if (!allowed.has(url.hostname.toLowerCase())) {
      throw new PresignedUrlRejectedError({
        code: "host_not_allowed",
        message: `Refused presigned URL whose host is not in the allowlist: ${url.hostname}`,
        url: redactPresignedUrlString(url),
      });
    }
  };
}

const BCS_AGENT_STORE_BUCKET_HOSTS = [
  "agent-stores.s3.us-east-1.amazonaws.com",
  "agent-stores.s3.amazonaws.com",
];

const PLAYGROUND_AGENT_STORE_BUCKET_HOSTS = [
  "agent-stores-928182716709-us-west-2-an.s3.us-west-2.amazonaws.com",
  "agent-stores-928182716709-us-west-2-an.s3.amazonaws.com",
];

function createBcsPresignedUrlValidator(): (url: URL) => void {
  return createHostAllowlistValidator(BCS_AGENT_STORE_BUCKET_HOSTS);
}

function isLocalAgentStoreBackendUrl(backendUrl: string): boolean {
  const trimmed = backendUrl.trim();
  if (trimmed === "") {
    return false;
  }
  return trimmed.includes("localhost") || trimmed.includes("lclhst.build");
}

function isPlaygroundAgentStoreBackendUrl(backendUrl: string): boolean {
  try {
    const hostname = new URL(backendUrl).hostname.toLowerCase();
    return hostname === "playground.cursor.sh" || hostname.endsWith(".playground.cursor.sh");
  } catch {
    return false;
  }
}

export function createAgentStorePresignedUrlValidatorForBackend(backendUrl: string): (url: URL) => void {
  if (isLocalAgentStoreBackendUrl(backendUrl)) {
    return createLocalDevAgentStorePresignedUrlValidator();
  }
  if (isPlaygroundAgentStoreBackendUrl(backendUrl)) {
    return createHostAllowlistValidator(PLAYGROUND_AGENT_STORE_BUCKET_HOSTS);
  }
  return createBcsPresignedUrlValidator();
}

function createLocalDevAgentStorePresignedUrlValidator(): (url: URL) => void {
  const bcsValidator = createBcsPresignedUrlValidator();
  return url => {
    assertSafeAuthority(url);
    const hostname = stripIPv6Brackets(url.hostname);
    if (url.protocol === "http:" && isLoopbackHostName(hostname)) {
      return;
    }
    bcsValidator(url);
  };
}

function assertSafeAuthority(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new PresignedUrlRejectedError({
      code: "userinfo_not_allowed",
      message: "Refused presigned URL with embedded userinfo",
      url: redactPresignedUrlString(url),
    });
  }
}

function redactPresignedUrlString(url: URL | string): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparseable-presigned-url>";
  }
}

export function assertPresignedUrlSafe(args: {
  readonly rawUrl: string;
  readonly relPath: string;
  readonly validatePresignedUrl: (url: URL) => void;
}): void {
  let parsed: URL;
  try {
    parsed = new URL(args.rawUrl);
  } catch {
    throw new Error(`Refusing unparseable presigned URL for ${args.relPath}`);
  }
  try {
    args.validatePresignedUrl(parsed);
  } catch (error) {
    throw new Error(
      `Refusing presigned URL for ${args.relPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function isLoopbackHostName(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return lowered === "localhost" || lowered === "ip6-localhost" || lowered === "127.0.0.1" || lowered === "::1" || lowered === "0:0:0:0:0:0:0:1";
}

function isLocalOrInternalHost(hostname: string): boolean {
  if (hostname.length === 0) {
    return true;
  }
  if (isLoopbackHostName(hostname)) {
    return true;
  }
  if (isIPv4Address(hostname)) {
    return isPrivateOrInternalIPv4(hostname);
  }
  if (isIPv6Address(hostname)) {
    return isPrivateOrInternalIPv6(hostname);
  }
  return false;
}

function stripIPv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIPv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every(part => {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) {
      return false;
    }
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

function isPrivateOrInternalIPv4(hostname: string): boolean {
  const [a, b] = hostname.split(".").map(Number);
  if (a === undefined || b === undefined) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a >= 224 && a <= 239) || a >= 240) {
    return true;
  }
  return false;
}

function isIPv6Address(hostname: string): boolean {
  return hostname.includes(":");
}

function isPrivateOrInternalIPv6(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "::" || lowered === "::1") {
    return true;
  }
  const mapped = extractIPv4MappedAddress(lowered);
  if (mapped !== undefined) {
    return isPrivateOrInternalIPv4(mapped);
  }
  if (lowered.startsWith("fc") || lowered.startsWith("fd") || lowered.startsWith("fe8") || lowered.startsWith("fe9") || lowered.startsWith("fea") || lowered.startsWith("feb") || lowered.startsWith("ff")) {
    return true;
  }
  return false;
}

function extractIPv4MappedAddress(hostname: string): string | undefined {
  const dotted = hostname.match(/^(?:0:0:0:0:0|::):?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted !== null) {
    return dotted[1]!;
  }
  if (hostname.startsWith("::ffff:")) {
    const tail = hostname.slice("::ffff:".length);
    if (isIPv4Address(tail)) {
      return tail;
    }
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex !== null) {
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      if (Number.isFinite(high) && Number.isFinite(low) && high >= 0 && high <= 65535 && low >= 0 && low <= 65535) {
        return `${high >> 8 & 255}.${high & 255}.${low >> 8 & 255}.${low & 255}`;
      }
    }
  }
  return undefined;
}
