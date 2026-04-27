import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runWorkerNodeCli } from "./worker-node-main.js";

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string) {
        buffer += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    read() {
      return buffer;
    },
  };
}

test("themis-worker-node help 会输出当前支持的最小命令", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();
  const exitCode = await runWorkerNodeCli(["help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Themis Worker Node CLI/);
  assert.match(stdout.read(), /doctor worker-node/);
  assert.match(stdout.read(), /worker-node run/);
});

test("themis-worker-node doctor worker-node 会输出本地预检摘要", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();
  const workspace = join(process.cwd(), "temp", `worker-node-doctor-${Date.now()}`);
  const codexHome = join(workspace, "codex-home");
  const oldCodexHome = process.env.CODEX_HOME;

  mkdirSync(workspace, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"default\"}", "utf8");
  process.env.CODEX_HOME = codexHome;

  try {
    const exitCode = await runWorkerNodeCli([
      "doctor",
      "worker-node",
      "--workspace",
      workspace,
      "--credential",
      "default",
    ], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 0);
    assert.match(stdout.read(), /Themis 诊断 - worker-node/);
    assert.match(stdout.read(), /主诊断：Worker Node 预检通过/);
  } finally {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("themis-worker-node worker-node run --once 会执行最小闭环", async () => {
  const stdout = createBufferStream();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const root = join(process.cwd(), "temp", `worker-node-run-${Date.now()}`);
  const workspace = join(root, "workspace");
  const reportRoot = join(root, "reports");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# worker\n", "utf8");

  try {
    const exitCode = await runWorkerNodeCli([
      "worker-node",
      "run",
      "--platform",
      "https://platform.example.com/",
      "--owner-principal",
      "principal-owner",
      "--token",
      "worker-token",
      "--name",
      "Worker Alpha",
      "--workspace",
      workspace,
      "--report-root",
      reportRoot,
      "--once",
    ], {
      stdout: stdout.stream,
      stderr: createBufferStream().stream,
      workingDirectory: root,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        requests.push({
          url: String(url),
          body,
        });

        if (String(url).endsWith("/api/platform/nodes/register")) {
          return createJsonResponse(200, {
            organization: {
              organizationId: "org-platform",
            },
            node: {
              nodeId: "node-alpha",
            },
          });
        }

        if (String(url).endsWith("/api/platform/nodes/heartbeat")) {
          return createJsonResponse(200, {
            node: {
              nodeId: "node-alpha",
            },
          });
        }

        if (String(url).endsWith("/api/platform/worker/secrets/pull")) {
          return createJsonResponse(200, {
            deliveries: [],
          });
        }

        if (String(url).endsWith("/api/platform/worker/secrets/ack")) {
          return createJsonResponse(200, {
            deliveries: [],
            secretRefs: [],
          });
        }

        if (String(url).endsWith("/api/platform/worker/runs/pull")) {
          return createJsonResponse(200, {
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
              goal: "验证 CLI 最小闭环",
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
              workspacePath: workspace,
            },
          });
        }

        if (String(url).endsWith("/api/platform/worker/runs/update")) {
          return createJsonResponse(200, {});
        }

        if (String(url).endsWith("/api/platform/worker/runs/complete")) {
          return createJsonResponse(200, {});
        }

        return createJsonResponse(404, {
          error: {
            message: "unexpected request",
          },
        });
      },
      executor: {
        async execute() {
          return {
            kind: "completed",
            summary: "CLI 测试执行完成。",
            output: {
              reportFile: join(reportRoot, "run-alpha", "report.json"),
            },
          };
        },
      },
    });

    assert.equal(exitCode, 0);
    assert.match(stdout.read(), /Worker Node：node-alpha/);
    assert.match(stdout.read(), /执行结果：completed/);
    assert.match(stdout.read(), /报告文件：/);
    assert.ok(requests.some((request) => request.url.endsWith("/api/platform/nodes/register")));
    const completeRequest = requests.find((request) => request.url.endsWith("/api/platform/worker/runs/complete"));
    assert.ok(completeRequest);
    assert.equal((completeRequest?.body.result as Record<string, unknown> | undefined)?.summary, "CLI 测试执行完成。");
    const reportFile = String(((completeRequest?.body.result as Record<string, unknown> | undefined)?.output as Record<string, unknown> | undefined)?.reportFile ?? "");
    assert.ok(reportFile.endsWith("/report.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createJsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  } as Response;
}
