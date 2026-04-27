import type {
  ManagedAgentPlatformWorkerAssignedRunResult,
  ManagedAgentPlatformWorkerNodeListInput,
  ManagedAgentPlatformWorkerNodeMutationResult,
  ManagedAgentPlatformWorkerNodeRecord,
  ManagedAgentPlatformWorkerNodeRegistrationInput,
  ManagedAgentPlatformWorkerNodeHeartbeatInput,
  ManagedAgentPlatformWorkerProbeResult,
  ManagedAgentPlatformWorkerSecretAckInput,
  ManagedAgentPlatformWorkerSecretAckResult,
  ManagedAgentPlatformWorkerSecretPullResult,
  ManagedAgentPlatformWorkerRunCompleteInput,
  ManagedAgentPlatformWorkerRunMutationResult,
  ManagedAgentPlatformWorkerRunStatusInput,
} from "themis-contracts";
import {
  createAckWorkerSecretsRequest,
  createCompleteRunRequest,
  createHeartbeatNodeRequest,
  createListNodesRequest,
  createPullAssignedRunRequest,
  createPullWorkerSecretsRequest,
  createRegisterNodeRequest,
  createUpdateRunStatusRequest,
  type WorkerPlatformConfig,
  type WorkerPlatformRequest,
} from "./platform-worker-access.js";

export interface PlatformWorkerClientOptions extends WorkerPlatformConfig {
  fetchImpl?: typeof fetch;
}

export class PlatformWorkerClient {
  private readonly config: WorkerPlatformConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlatformWorkerClientOptions) {
    this.config = {
      baseUrl: options.baseUrl.trim(),
      ownerPrincipalId: options.ownerPrincipalId.trim(),
      webAccessToken: options.webAccessToken.trim(),
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async registerNode(input: ManagedAgentPlatformWorkerNodeRegistrationInput): Promise<ManagedAgentPlatformWorkerNodeMutationResult> {
    return await this.requestJson(createRegisterNodeRequest(this.config, input));
  }

  async heartbeatNode(input: ManagedAgentPlatformWorkerNodeHeartbeatInput): Promise<ManagedAgentPlatformWorkerNodeMutationResult> {
    return await this.requestJson(createHeartbeatNodeRequest(this.config, input));
  }

  async listNodes(input: ManagedAgentPlatformWorkerNodeListInput = {}): Promise<ManagedAgentPlatformWorkerNodeRecord[]> {
    const payload = await this.requestJson<{ nodes?: ManagedAgentPlatformWorkerNodeRecord[] }>(
      createListNodesRequest(this.config, input),
    );
    return Array.isArray(payload.nodes) ? payload.nodes : [];
  }

  async pullAssignedRun(nodeId: string): Promise<ManagedAgentPlatformWorkerAssignedRunResult | null> {
    const payload = await this.requestJson<Partial<ManagedAgentPlatformWorkerAssignedRunResult>>(
      createPullAssignedRunRequest(this.config, { nodeId }),
    );

    return payload.organization && payload.node && payload.targetAgent && payload.workItem && payload.run
      && payload.executionLease && payload.executionContract
      ? payload as ManagedAgentPlatformWorkerAssignedRunResult
      : null;
  }

  async pullWorkerSecrets(nodeId: string): Promise<ManagedAgentPlatformWorkerSecretPullResult> {
    const payload = await this.requestJson<Partial<ManagedAgentPlatformWorkerSecretPullResult>>(
      createPullWorkerSecretsRequest(this.config, { nodeId }),
    );

    return {
      deliveries: Array.isArray(payload.deliveries) ? payload.deliveries : [],
    };
  }

  async ackWorkerSecrets(input: ManagedAgentPlatformWorkerSecretAckInput): Promise<ManagedAgentPlatformWorkerSecretAckResult> {
    const payload = await this.requestJson<Partial<ManagedAgentPlatformWorkerSecretAckResult>>(
      createAckWorkerSecretsRequest(this.config, input),
    );

    return {
      deliveries: Array.isArray(payload.deliveries) ? payload.deliveries : [],
      secretRefs: Array.isArray(payload.secretRefs) ? payload.secretRefs : [],
    };
  }

  async updateRunStatus(input: ManagedAgentPlatformWorkerRunStatusInput): Promise<ManagedAgentPlatformWorkerRunMutationResult> {
    return await this.requestJson(createUpdateRunStatusRequest(this.config, input));
  }

  async completeRun(input: ManagedAgentPlatformWorkerRunCompleteInput): Promise<ManagedAgentPlatformWorkerRunMutationResult> {
    return await this.requestJson(createCompleteRunRequest(this.config, input));
  }

  async probeAccess(input: ManagedAgentPlatformWorkerNodeListInput = {}): Promise<ManagedAgentPlatformWorkerProbeResult> {
    const nodes = await this.listNodes(input);
    return {
      nodeCount: nodes.length,
    };
  }

  private async requestJson<T>(request: WorkerPlatformRequest<object>): Promise<T> {
    const response = await this.fetchImpl(request.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
    });
    const text = await response.text();
    const payload = text.trim() ? parseJsonSafely(text) : {};

    if (!response.ok) {
      throw new Error(resolveHttpErrorMessage(payload, response.status));
    }

    return payload as T;
  }
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      raw: text,
    };
  }
}

function resolveHttpErrorMessage(payload: unknown, status: number) {
  if (
    typeof payload === "object"
    && payload !== null
    && "error" in payload
    && typeof payload.error === "object"
    && payload.error !== null
    && "message" in payload.error
    && typeof payload.error.message === "string"
    && payload.error.message.trim()
  ) {
    return payload.error.message.trim();
  }

  return `Platform worker request failed (HTTP ${status}).`;
}
