export type LocalHostTarget = "docker-gateway" | "wait-docker-gateway" | "ensure-docker";

export function chooseLocalHostTarget(status: {
  readonly dockerGatewayReady: boolean;
  readonly desktopGatewayReady: boolean;
  readonly dockerContainerRunning: boolean;
}): LocalHostTarget {
  if (status.dockerGatewayReady) return "docker-gateway";
  if (status.dockerContainerRunning) return "wait-docker-gateway";
  return "ensure-docker";
}
