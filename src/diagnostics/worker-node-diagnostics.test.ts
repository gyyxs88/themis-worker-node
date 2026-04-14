import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerNodeDiagnosticsService } from "./worker-node-diagnostics.js";

test("WorkerNodeDiagnosticsService 会识别本地缺失的 workspace / credential / provider 能力", async () => {
  const root = join(tmpdir(), `themis-worker-node-diagnostics-missing-${Date.now()}`);
  mkdirSync(root, { recursive: true });

  try {
    const service = new WorkerNodeDiagnosticsService({
      workingDirectory: root,
      env: {
        CODEX_HOME: join(root, "missing-codex-home"),
      },
    });
    const summary = await service.readSummary({
      workspaceCapabilities: ["workspace/relative", join(root, "missing-workspace")],
      credentialCapabilities: ["default"],
      providerCapabilities: ["provider-missing"],
    });

    assert.equal(summary.workspaces[0]?.status, "relative");
    assert.equal(summary.workspaces[1]?.status, "missing");
    assert.equal(summary.credentials[0]?.status, "missing");
    assert.equal(summary.providers[0]?.status, "missing");
    assert.equal(summary.platform.status, "skipped");
    assert.equal(summary.primaryDiagnosis.id, "workspace_capability_invalid");
    assert.ok(summary.recommendedNextSteps.some((step) => step.includes("--workspace")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkerNodeDiagnosticsService 会探测平台可达性并汇总本地 ok 状态", async () => {
  const root = join(tmpdir(), `themis-worker-node-diagnostics-platform-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const workspacePath = join(root, "workspace/worker-a");
  const defaultCodexHome = join(root, "codex-home-default");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(defaultCodexHome, { recursive: true });
  writeFileSync(join(defaultCodexHome, "auth.json"), "{\"token\":\"default\"}", "utf8");

  let server: ReturnType<typeof createServer> | null = null;

  try {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "POST" && url.pathname === "/api/platform/nodes/list") {
        assert.equal(request.headers.authorization, "Bearer secret-token");
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({
          nodes: [{ nodeId: "node-worker-a" }],
        }));
        return;
      }

      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");

    const service = new WorkerNodeDiagnosticsService({
      workingDirectory: root,
      env: {
        CODEX_HOME: defaultCodexHome,
      },
    });
    const summary = await service.readSummary({
      workspaceCapabilities: [workspacePath],
      credentialCapabilities: ["default"],
      providerCapabilities: [],
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
      ownerPrincipalId: "principal-owner",
      webAccessToken: "secret-token",
    });

    assert.equal(summary.workspaces[0]?.status, "ok");
    assert.equal(summary.credentials[0]?.status, "ok");
    assert.equal(summary.platform.status, "ok");
    assert.equal(summary.platform.nodeCount, 1);
    assert.equal(summary.primaryDiagnosis.id, "healthy");
  } finally {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
