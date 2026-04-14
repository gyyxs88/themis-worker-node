import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompleteRunRequest,
  createHeartbeatNodeRequest,
  createListNodesRequest,
  createPullAssignedRunRequest,
  createRegisterNodeRequest,
  createUpdateRunStatusRequest,
} from "./platform-worker-access.js";

test("themis-worker-node 会按 themis-contracts 契约构造节点与 run 请求", () => {
  const config = {
    baseUrl: "https://platform.example.com/",
    ownerPrincipalId: "principal-owner",
    webAccessToken: "worker-token",
  };

  const register = createRegisterNodeRequest(config, {
    displayName: "Worker A",
    slotCapacity: 2,
    workspaceCapabilities: ["/srv/workspace"],
  });
  const heartbeat = createHeartbeatNodeRequest(config, {
    nodeId: "node-alpha",
    status: "online",
    slotAvailable: 1,
  });
  const listNodes = createListNodesRequest(config, {
    organizationId: "org-platform",
  });
  const pullRun = createPullAssignedRunRequest(config, {
    nodeId: "node-alpha",
  });
  const updateRun = createUpdateRunStatusRequest(config, {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "waiting_human",
    waitingAction: {
      message: "等待人工确认继续发布。",
    },
  });
  const completeRun = createCompleteRunRequest(config, {
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    result: {
      summary: "Worker Node 已完成任务。",
      touchedFiles: ["src/index.ts"],
    },
  });

  assert.equal(register.url, "https://platform.example.com/api/platform/nodes/register");
  assert.equal(heartbeat.url, "https://platform.example.com/api/platform/nodes/heartbeat");
  assert.equal(listNodes.url, "https://platform.example.com/api/platform/nodes/list");
  assert.equal(pullRun.url, "https://platform.example.com/api/platform/worker/runs/pull");
  assert.equal(updateRun.url, "https://platform.example.com/api/platform/worker/runs/update");
  assert.equal(completeRun.url, "https://platform.example.com/api/platform/worker/runs/complete");
  assert.equal(register.headers.Authorization, "Bearer worker-token");
  assert.equal(heartbeat.headers.Authorization, "Bearer worker-token");
  assert.equal(pullRun.headers.Authorization, "Bearer worker-token");
  assert.deepEqual(register.body, {
    ownerPrincipalId: "principal-owner",
    node: {
      displayName: "Worker A",
      slotCapacity: 2,
      workspaceCapabilities: ["/srv/workspace"],
    },
  });
  assert.deepEqual(heartbeat.body, {
    ownerPrincipalId: "principal-owner",
    node: {
      nodeId: "node-alpha",
      status: "online",
      slotAvailable: 1,
    },
  });
  assert.deepEqual(listNodes.body, {
    ownerPrincipalId: "principal-owner",
    organizationId: "org-platform",
  });
  assert.deepEqual(pullRun.body, {
    ownerPrincipalId: "principal-owner",
    nodeId: "node-alpha",
  });
  assert.deepEqual(updateRun.body, {
    ownerPrincipalId: "principal-owner",
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    status: "waiting_human",
    waitingAction: {
      message: "等待人工确认继续发布。",
    },
  });
  assert.deepEqual(completeRun.body, {
    ownerPrincipalId: "principal-owner",
    nodeId: "node-alpha",
    runId: "run-alpha",
    leaseToken: "lease-token-alpha",
    result: {
      summary: "Worker Node 已完成任务。",
      touchedFiles: ["src/index.ts"],
    },
  });
});
