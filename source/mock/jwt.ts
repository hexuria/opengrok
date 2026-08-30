import { MOCK_JWT_EMAIL, MOCK_JWT_SUBJECT, MOCK_JWT_TTL_SECONDS } from "./constants.js";

export interface MockJwtClaims {
  readonly sub: string;
  readonly email: string;
  readonly exp: number;
  readonly iat: number;
  readonly mock: true;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function mintMockJwt(overrides: { readonly email?: string; readonly sub?: string; readonly exp?: number } = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: MockJwtClaims = {
    sub: overrides.sub ?? MOCK_JWT_SUBJECT,
    email: overrides.email ?? MOCK_JWT_EMAIL,
    exp: overrides.exp ?? iat + MOCK_JWT_TTL_SECONDS,
    iat,
    mock: true,
  };
  return `${encodeJson({ alg: "none", typ: "JWT" })}.${encodeJson(payload)}.mock`;
}

export function createMockTokenPair(overrides: { readonly email?: string; readonly sub?: string } = {}): {
  readonly accessToken: string;
  readonly refreshToken: string;
} {
  const accessToken = mintMockJwt(overrides);
  return { accessToken, refreshToken: accessToken };
}
