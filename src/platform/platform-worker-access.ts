import {
  buildPlatformServiceAuthorizationHeader,
  type ManagedAgentPlatformNodeHeartbeatPayload,
  type ManagedAgentPlatformNodeRegisterPayload,
  type ManagedAgentPlatformWorkerNodeHeartbeatInput,
  type ManagedAgentPlatformWorkerNodeRegistrationInput,
} from "themis-contracts";

export interface WorkerPlatformConfig {
  baseUrl: string;
  ownerPrincipalId: string;
  webAccessToken: string;
}

export interface WorkerPlatformRequest<TBody> {
  url: string;
  headers: Record<string, string>;
  body: TBody;
}

export function createRegisterNodeRequest(
  config: WorkerPlatformConfig,
  node: ManagedAgentPlatformWorkerNodeRegistrationInput,
): WorkerPlatformRequest<ManagedAgentPlatformNodeRegisterPayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/nodes/register`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      node,
    },
  };
}

export function createHeartbeatNodeRequest(
  config: WorkerPlatformConfig,
  node: ManagedAgentPlatformWorkerNodeHeartbeatInput,
): WorkerPlatformRequest<ManagedAgentPlatformNodeHeartbeatPayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/nodes/heartbeat`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      node,
    },
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
