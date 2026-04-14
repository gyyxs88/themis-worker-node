import {
  buildPlatformServiceAuthorizationHeader,
  type ManagedAgentPlatformNodeListPayload,
  type ManagedAgentPlatformNodeHeartbeatPayload,
  type ManagedAgentPlatformNodeRegisterPayload,
  type ManagedAgentPlatformWorkerPullPayload,
  type ManagedAgentPlatformWorkerRunCompletePayload,
  type ManagedAgentPlatformWorkerRunStatusPayload,
  type ManagedAgentPlatformWorkerNodeListInput,
  type ManagedAgentPlatformWorkerNodeHeartbeatInput,
  type ManagedAgentPlatformWorkerNodeRegistrationInput,
  type ManagedAgentPlatformWorkerPullInput,
  type ManagedAgentPlatformWorkerRunCompleteInput,
  type ManagedAgentPlatformWorkerRunStatusInput,
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

export function createListNodesRequest(
  config: WorkerPlatformConfig,
  input: ManagedAgentPlatformWorkerNodeListInput = {},
): WorkerPlatformRequest<ManagedAgentPlatformNodeListPayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/nodes/list`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      ...(typeof input.organizationId === "string" && input.organizationId.trim()
        ? { organizationId: input.organizationId.trim() }
        : {}),
    },
  };
}

export function createPullAssignedRunRequest(
  config: WorkerPlatformConfig,
  input: ManagedAgentPlatformWorkerPullInput,
): WorkerPlatformRequest<ManagedAgentPlatformWorkerPullPayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/worker/runs/pull`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      nodeId: input.nodeId,
    },
  };
}

export function createUpdateRunStatusRequest(
  config: WorkerPlatformConfig,
  input: ManagedAgentPlatformWorkerRunStatusInput,
): WorkerPlatformRequest<ManagedAgentPlatformWorkerRunStatusPayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/worker/runs/update`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      nodeId: input.nodeId,
      runId: input.runId,
      leaseToken: input.leaseToken,
      status: input.status,
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
      ...(input.waitingAction ? { waitingAction: input.waitingAction } : {}),
    },
  };
}

export function createCompleteRunRequest(
  config: WorkerPlatformConfig,
  input: ManagedAgentPlatformWorkerRunCompleteInput,
): WorkerPlatformRequest<ManagedAgentPlatformWorkerRunCompletePayload> {
  return {
    url: `${trimTrailingSlash(config.baseUrl)}/api/platform/worker/runs/complete`,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildPlatformServiceAuthorizationHeader(config.webAccessToken),
    },
    body: {
      ownerPrincipalId: config.ownerPrincipalId,
      nodeId: input.nodeId,
      runId: input.runId,
      leaseToken: input.leaseToken,
      ...(input.result ? { result: input.result } : {}),
    },
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
