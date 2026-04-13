import assert from "node:assert/strict";
import test from "node:test";
import { createHeartbeatNodeRequest, createRegisterNodeRequest } from "./platform-worker-access.js";

test("themis-worker-node 会按 themis-contracts 契约构造 register 与 heartbeat 请求", () => {
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

  assert.equal(register.url, "https://platform.example.com/api/platform/nodes/register");
  assert.equal(heartbeat.url, "https://platform.example.com/api/platform/nodes/heartbeat");
  assert.equal(register.headers.Authorization, "Bearer worker-token");
  assert.equal(heartbeat.headers.Authorization, "Bearer worker-token");
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
});
