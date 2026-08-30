export const SAND_WEBAUTHN_SIGNER_PLATFORMS = ["darwin", "win32"] as const;

export function sandWebauthnSignerShips(platform: NodeJS.Platform): boolean {
  return (SAND_WEBAUTHN_SIGNER_PLATFORMS as readonly string[]).includes(platform);
}

export function sandWebauthnProxyMirroredEnablement(enabled: boolean, platform: NodeJS.Platform): boolean {
  return enabled && sandWebauthnSignerShips(platform);
}

