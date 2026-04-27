import type {
  ManagedAgentPlatformWorkerAssignedRunResult,
  ManagedAgentPlatformWorkerCompletionResult,
  ManagedAgentPlatformWorkerRunStatus,
  ManagedAgentPlatformWorkerWaitingActionPayload,
} from "themis-contracts";
import { PlatformWorkerClient } from "../platform/platform-worker-client.js";
import {
  listWorkerNodeSecretRefs,
  upsertWorkerNodeSecrets,
  type WorkerNodeSecretStoreOptions,
} from "./worker-secret-store.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface WorkerNodeDaemonNodeOptions {
  nodeId?: string;
  organizationId?: string;
  displayName: string;
  slotCapacity: number;
  slotAvailable?: number;
  labels?: string[];
  workspaceCapabilities?: string[];
  credentialCapabilities?: string[];
  providerCapabilities?: string[];
  heartbeatTtlSeconds?: number;
}

export interface WorkerNodeExecutorInput {
  assignedRun: ManagedAgentPlatformWorkerAssignedRunResult;
}

export interface WorkerNodeExecutorCompletedResult extends ManagedAgentPlatformWorkerCompletionResult {
  kind: "completed";
}

export interface WorkerNodeExecutorWaitingResult {
  kind: "waiting_human" | "waiting_agent";
  waitingAction?: ManagedAgentPlatformWorkerWaitingActionPayload;
  summary?: string;
}

export interface WorkerNodeExecutorCancelledResult {
  kind: "cancelled";
  summary?: string;
}

export type WorkerNodeExecutorResult =
  | WorkerNodeExecutorCompletedResult
  | WorkerNodeExecutorWaitingResult
  | WorkerNodeExecutorCancelledResult;

export interface WorkerNodeExecutor {
  execute(input: WorkerNodeExecutorInput): Promise<WorkerNodeExecutorResult>;
}

export interface WorkerNodeDaemonOptions {
  client: PlatformWorkerClient;
  executor: WorkerNodeExecutor;
  node: WorkerNodeDaemonNodeOptions;
  pollIntervalMs?: number;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface WorkerNodeDaemonRunResult {
  nodeId: string;
  executedRunId: string | null;
  result: "idle" | "completed" | "waiting_action" | "failed" | "cancelled";
  summary?: string;
  reportFile?: string | null;
}

export class WorkerNodeExecutionError extends Error {
  readonly failureCode: string;

  constructor(message: string, failureCode = "WORKER_NODE_EXECUTION_FAILED") {
    super(message);
    this.name = "WorkerNodeExecutionError";
    this.failureCode = failureCode;
  }
}

export class WorkerNodeDaemon {
  private readonly client: PlatformWorkerClient;
  private readonly executor: WorkerNodeExecutor;
  private readonly node: WorkerNodeDaemonNodeOptions;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly secretStoreOptions: WorkerNodeSecretStoreOptions;
  private currentNodeId: string | null;

  constructor(options: WorkerNodeDaemonOptions) {
    this.client = options.client;
    this.executor = options.executor;
    this.node = {
      ...options.node,
      slotAvailable: normalizePositiveInteger(options.node.slotAvailable) ?? normalizePositiveInteger(options.node.slotCapacity) ?? 1,
    };
    this.pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS;
    this.log = options.log ?? (() => {});
    this.secretStoreOptions = {
      workingDirectory: options.workingDirectory ?? process.cwd(),
      env: options.env ?? process.env,
    };
    this.currentNodeId = normalizeOptionalText(options.node.nodeId);
  }

  async runOnce(): Promise<WorkerNodeDaemonRunResult> {
    const nodeId = await this.ensureNodeRegistered(this.idleSlotAvailable());
    await this.syncWorkerSecrets(nodeId);
    await this.client.heartbeatNode({
      nodeId,
      slotAvailable: this.idleSlotAvailable(),
      ...this.buildNodeCapabilities(),
    });

    const assignedRun = await this.client.pullAssignedRun(nodeId);

    if (!assignedRun) {
      return {
        nodeId,
        executedRunId: null,
        result: "idle",
      };
    }

    return await this.executeAssignedRun(nodeId, assignedRun);
  }

  async runLoop(signal?: AbortSignal): Promise<void> {
    try {
      while (!signal?.aborted) {
        await this.runOnce();
        await sleep(this.pollIntervalMs, signal);
      }
    } finally {
      await this.markNodeOffline().catch(() => {});
    }
  }

  async markNodeOffline(): Promise<void> {
    const nodeId = this.currentNodeId;

    if (!nodeId) {
      return;
    }

    await this.client.heartbeatNode({
      nodeId,
      status: "offline",
      slotAvailable: 0,
    });
  }

  private async ensureNodeRegistered(slotAvailable: number): Promise<string> {
    const result = await this.client.registerNode({
      ...(this.currentNodeId ? { nodeId: this.currentNodeId } : {}),
      ...(this.node.organizationId ? { organizationId: this.node.organizationId } : {}),
      displayName: this.node.displayName,
      slotCapacity: this.node.slotCapacity,
      slotAvailable,
      ...this.buildNodeCapabilities(),
    });
    this.currentNodeId = result.node.nodeId;
    return result.node.nodeId;
  }

  private async syncWorkerSecrets(nodeId: string): Promise<void> {
    const result = await this.client.pullWorkerSecrets(nodeId);

    if (result.deliveries.length === 0) {
      return;
    }

    const secretRefs = upsertWorkerNodeSecrets(
      this.secretStoreOptions,
      result.deliveries.map((delivery) => ({
        secretRef: delivery.secretRef,
        value: delivery.value,
      })),
    );
    await this.client.ackWorkerSecrets({
      nodeId,
      deliveryIds: result.deliveries.map((delivery) => delivery.deliveryId),
      secretRefs,
    });
    this.log(`Worker Node 已同步 ${result.deliveries.length} 个 secret。`);
  }

  private async executeAssignedRun(
    nodeId: string,
    assignedRun: ManagedAgentPlatformWorkerAssignedRunResult,
  ): Promise<WorkerNodeDaemonRunResult> {
    const busySlotAvailable = Math.max(0, this.idleSlotAvailable() - 1);

    await this.client.heartbeatNode({
      nodeId,
      slotAvailable: busySlotAvailable,
    });
    await this.client.updateRunStatus({
      nodeId,
      runId: assignedRun.run.runId,
      leaseToken: normalizeRequiredText(assignedRun.executionLease.leaseToken, "leaseToken is required."),
      status: "starting",
    });
    this.log(`Worker Node 开始执行 run ${assignedRun.run.runId}`);

    try {
      const executionResult = await this.executor.execute({
        assignedRun,
      });

      if (executionResult.kind === "completed") {
        await this.client.completeRun({
          nodeId,
          runId: assignedRun.run.runId,
          leaseToken: normalizeRequiredText(assignedRun.executionLease.leaseToken, "leaseToken is required."),
          result: {
            summary: executionResult.summary,
            ...(executionResult.output !== undefined ? { output: executionResult.output } : {}),
            ...(executionResult.touchedFiles ? { touchedFiles: executionResult.touchedFiles } : {}),
            ...(executionResult.structuredOutput !== undefined ? { structuredOutput: executionResult.structuredOutput } : {}),
            ...(executionResult.completedAt ? { completedAt: executionResult.completedAt } : {}),
          },
        });
        return {
          nodeId,
          executedRunId: assignedRun.run.runId,
          result: "completed",
          summary: executionResult.summary,
          reportFile: resolveReportFile(executionResult),
        };
      }

      if (executionResult.kind === "cancelled") {
        await this.client.updateRunStatus({
          nodeId,
          runId: assignedRun.run.runId,
          leaseToken: normalizeRequiredText(assignedRun.executionLease.leaseToken, "leaseToken is required."),
          status: "cancelled",
          failureCode: "WORKER_NODE_CANCELLED",
          failureMessage: executionResult.summary ?? "Worker execution cancelled.",
        });
        return {
          nodeId,
          executedRunId: assignedRun.run.runId,
          result: "cancelled",
          summary: executionResult.summary,
        };
      }

      await this.client.updateRunStatus({
        nodeId,
        runId: assignedRun.run.runId,
        leaseToken: normalizeRequiredText(assignedRun.executionLease.leaseToken, "leaseToken is required."),
        status: executionResult.kind satisfies ManagedAgentPlatformWorkerRunStatus,
        ...(executionResult.waitingAction ? { waitingAction: executionResult.waitingAction } : {}),
      });
      return {
        nodeId,
        executedRunId: assignedRun.run.runId,
        result: "waiting_action",
        summary: executionResult.summary,
      };
    } catch (error) {
      const failureMessage = toErrorMessage(error);
      await this.client.updateRunStatus({
        nodeId,
        runId: assignedRun.run.runId,
        leaseToken: normalizeRequiredText(assignedRun.executionLease.leaseToken, "leaseToken is required."),
        status: "failed",
        failureCode: error instanceof WorkerNodeExecutionError
          ? error.failureCode
          : "WORKER_NODE_EXECUTION_FAILED",
        failureMessage,
      });
      return {
        nodeId,
        executedRunId: assignedRun.run.runId,
        result: "failed",
        summary: failureMessage,
      };
    } finally {
      await this.client.heartbeatNode({
        nodeId,
        slotAvailable: this.idleSlotAvailable(),
        ...this.buildNodeCapabilities(),
      }).catch(() => {});
    }
  }

  private idleSlotAvailable() {
    return normalizePositiveInteger(this.node.slotAvailable) ?? normalizePositiveInteger(this.node.slotCapacity) ?? 1;
  }

  private buildNodeCapabilities() {
    return {
      ...(Array.isArray(this.node.labels) && this.node.labels.length > 0 ? { labels: this.node.labels } : {}),
      ...(Array.isArray(this.node.workspaceCapabilities) && this.node.workspaceCapabilities.length > 0
        ? { workspaceCapabilities: this.node.workspaceCapabilities }
        : {}),
      ...(Array.isArray(this.node.credentialCapabilities) && this.node.credentialCapabilities.length > 0
        ? { credentialCapabilities: this.node.credentialCapabilities }
        : {}),
      ...(Array.isArray(this.node.providerCapabilities) && this.node.providerCapabilities.length > 0
        ? { providerCapabilities: this.node.providerCapabilities }
        : {}),
      secretCapabilities: listWorkerNodeSecretRefs(this.secretStoreOptions),
      ...(normalizePositiveInteger(this.node.heartbeatTtlSeconds)
        ? { heartbeatTtlSeconds: normalizePositiveInteger(this.node.heartbeatTtlSeconds) ?? undefined }
        : {}),
    };
  }
}

export function createEchoWorkerExecutor(): WorkerNodeExecutor {
  return {
    async execute({ assignedRun }) {
      return {
        kind: "completed",
        summary: `Worker Node 已完成：${assignedRun.workItem.goal}`,
        output: {
          workItemId: assignedRun.workItem.workItemId,
          workspacePath: assignedRun.executionContract.workspacePath ?? null,
        },
      };
    },
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeRequiredText(value: string | null | undefined, message: string) {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new Error(message);
  }

  return normalized;
}

function normalizePositiveInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveReportFile(result: WorkerNodeExecutorCompletedResult) {
  const outputReportFile = readReportFileField(result.output);

  if (outputReportFile) {
    return outputReportFile;
  }

  return readReportFileField(result.structuredOutput);
}

function readReportFileField(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (!("reportFile" in value) || typeof value.reportFile !== "string" || !value.reportFile.trim()) {
    return null;
  }

  return value.reportFile.trim();
}
