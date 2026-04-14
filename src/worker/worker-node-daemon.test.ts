import assert from "node:assert/strict";
import test from "node:test";
import { WorkerNodeDaemon, WorkerNodeExecutionError } from "./worker-node-daemon.js";

function createAssignedRun() {
  return {
    organization: {
      organizationId: "org-platform",
      ownerPrincipalId: "principal-owner",
      displayName: "Platform Team",
      slug: "platform-team",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    node: {
      nodeId: "node-alpha",
      organizationId: "org-platform",
      displayName: "Worker Alpha",
      status: "online",
      slotCapacity: 1,
      slotAvailable: 0,
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    targetAgent: {
      agentId: "agent-alpha",
      organizationId: "org-platform",
      displayName: "平台值班员",
      departmentRole: "Platform",
      status: "active",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    workItem: {
      workItemId: "work-item-alpha",
      organizationId: "org-platform",
      targetAgentId: "agent-alpha",
      sourceType: "human",
      goal: "验证 worker daemon 最小闭环",
      status: "queued",
      priority: "normal",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    run: {
      runId: "run-alpha",
      organizationId: "org-platform",
      workItemId: "work-item-alpha",
      nodeId: "node-alpha",
      status: "created",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    executionLease: {
      leaseId: "lease-alpha",
      runId: "run-alpha",
      nodeId: "node-alpha",
      workItemId: "work-item-alpha",
      leaseToken: "lease-token-alpha",
      status: "active",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    },
    executionContract: {
      workspacePath: "/srv/platform-alpha",
      credentialId: "default",
      provider: "openai",
    },
  };
}

test("WorkerNodeDaemon 会执行 register -> heartbeat -> pull -> complete 最小闭环", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    async registerNode(input: unknown) {
      calls.push(["registerNode", input]);
      return {
        node: {
          nodeId: "node-alpha",
        },
      };
    },
    async heartbeatNode(input: unknown) {
      calls.push(["heartbeatNode", input]);
      return {
        node: {
          nodeId: "node-alpha",
        },
      };
    },
    async pullAssignedRun(nodeId: unknown) {
      calls.push(["pullAssignedRun", nodeId]);
      return createAssignedRun();
    },
    async updateRunStatus(input: unknown) {
      calls.push(["updateRunStatus", input]);
      return {};
    },
    async completeRun(input: unknown) {
      calls.push(["completeRun", input]);
      return {};
    },
  };
  const daemon = new WorkerNodeDaemon({
    client: client as never,
    executor: {
      async execute() {
        return {
          kind: "completed",
          summary: "Worker Node 已完成任务。",
          touchedFiles: ["src/index.ts"],
        };
      },
    },
    node: {
      displayName: "Worker Alpha",
      slotCapacity: 1,
      slotAvailable: 1,
      heartbeatTtlSeconds: 30,
    },
  });

  const result = await daemon.runOnce();

  assert.deepEqual(result, {
    nodeId: "node-alpha",
    executedRunId: "run-alpha",
    result: "completed",
  });
  assert.equal(calls[0]?.[0], "registerNode");
  assert.equal(calls[1]?.[0], "heartbeatNode");
  assert.deepEqual(calls[3], ["heartbeatNode", {
    nodeId: "node-alpha",
    slotAvailable: 0,
  }]);
  assert.deepEqual(calls[4], ["updateRunStatus", {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "starting",
  }]);
  assert.deepEqual(calls[5], ["completeRun", {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    result: {
      summary: "Worker Node 已完成任务。",
      touchedFiles: ["src/index.ts"],
    },
  }]);
});

test("WorkerNodeDaemon 会把 waiting_human 回传给平台", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    async registerNode() {
      return { node: { nodeId: "node-alpha" } };
    },
    async heartbeatNode(input: unknown) {
      calls.push(["heartbeatNode", input]);
      return {};
    },
    async pullAssignedRun() {
      return createAssignedRun();
    },
    async updateRunStatus(input: unknown) {
      calls.push(["updateRunStatus", input]);
      return {};
    },
    async completeRun() {
      throw new Error("should not complete");
    },
  };
  const daemon = new WorkerNodeDaemon({
    client: client as never,
    executor: {
      async execute() {
        return {
          kind: "waiting_human",
          waitingAction: {
            message: "请确认是否继续发布。",
          },
        };
      },
    },
    node: {
      displayName: "Worker Alpha",
      slotCapacity: 1,
    },
  });

  const result = await daemon.runOnce();

  assert.equal(result.result, "waiting_action");
  assert.deepEqual(calls[2], ["updateRunStatus", {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "starting",
  }]);
  assert.deepEqual(calls[3], ["updateRunStatus", {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "waiting_human",
    waitingAction: {
      message: "请确认是否继续发布。",
    },
  }]);
});

test("WorkerNodeDaemon 会把执行失败回传给平台", async () => {
  const calls: unknown[] = [];
  const client = {
    async registerNode() {
      return { node: { nodeId: "node-alpha" } };
    },
    async heartbeatNode() {
      return {};
    },
    async pullAssignedRun() {
      return createAssignedRun();
    },
    async updateRunStatus(input: unknown) {
      calls.push(input);
      return {};
    },
    async completeRun() {
      throw new Error("should not complete");
    },
  };
  const daemon = new WorkerNodeDaemon({
    client: client as never,
    executor: {
      async execute() {
        throw new WorkerNodeExecutionError("workspace invalid", "WORKER_NODE_BOUNDARY_INVALID");
      },
    },
    node: {
      displayName: "Worker Alpha",
      slotCapacity: 1,
    },
  });

  const result = await daemon.runOnce();

  assert.equal(result.result, "failed");
  assert.deepEqual(calls.at(-1), {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "failed",
    failureCode: "WORKER_NODE_BOUNDARY_INVALID",
    failureMessage: "workspace invalid",
  });
});
