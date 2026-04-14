import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ManagedAgentPlatformWorkerAssignedRunResult } from "themis-contracts";
import { WorkerNodeExecutionError } from "./worker-node-daemon.js";
import { createLocalWorkerExecutor } from "./worker-node-local-executor.js";

function createAssignedRun(workspacePath: string): ManagedAgentPlatformWorkerAssignedRunResult {
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
      goal: "验证 worker 本机执行器会生成 report",
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
      workspacePath,
      credentialId: "default",
      provider: "openai",
      model: "gpt-5.4-mini",
    },
  };
}

test("createLocalWorkerExecutor 会检查本地工作区并写出执行报告", async () => {
  const root = join(tmpdir(), `themis-worker-node-local-executor-${Date.now()}`);
  const workspacePath = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(workspacePath, "README.md"), "# worker\n", "utf8");
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"default\"}\n", "utf8");

  const commands: string[] = [];
  const executor = createLocalWorkerExecutor({
    workingDirectory: root,
    env: {
      CODEX_HOME: codexHome,
      THEMIS_PROVIDER_OPENAI_BASE_URL: "https://api.openai.example.com",
      THEMIS_PROVIDER_OPENAI_API_KEY: "provider-secret",
      THEMIS_PROVIDER_OPENAI_MODEL: "gpt-5.4",
    },
    now: () => "2026-04-14T12:30:00.000Z",
    commandRunner: async (command, args, input) => {
      commands.push(`${command} ${args.join(" ")} @ ${input.cwd}`);

      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { stdout: "true\n", stderr: "" };
      }

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "" };
      }

      if (args[0] === "status") {
        return {
          stdout: " M README.md\n?? temp/report.json\n",
          stderr: "",
        };
      }

      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  });

  try {
    const result = await executor.execute({
      assignedRun: createAssignedRun(workspacePath),
    });

    assert.equal(result.kind, "completed");
    assert.match(result.summary, /Worker Node 已在本机完成执行/);
    assert.equal(result.touchedFiles?.length, 4);
    const reportFile = result.touchedFiles?.[0];
    assert.ok(reportFile);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    assert.equal(report.run.runId, "run-alpha");
    assert.equal(report.workspace.path, workspacePath);
    assert.equal(report.workspace.entryCount, 1);
    assert.equal(report.executionContract.credentialId, "default");
    assert.ok(report.runtime.contextFile.endsWith("/runtime-context.json"));
    assert.ok(report.runtime.runtimeAuthFilePath.endsWith("/codex-home/auth.json"));
    assert.ok(report.runtime.providerFile.endsWith("/provider.json"));
    assert.equal(report.git.isRepository, true);
    assert.equal(report.git.branch, "main");
    assert.equal(report.git.changedFileCount, 2);
    assert.deepEqual(commands, [
      `git rev-parse --is-inside-work-tree @ ${workspacePath}`,
      `git rev-parse --abbrev-ref HEAD @ ${workspacePath}`,
      `git status --short @ ${workspacePath}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createLocalWorkerExecutor 会在工作区无效时抛出边界错误", async () => {
  const root = join(tmpdir(), `themis-worker-node-local-executor-invalid-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const executor = createLocalWorkerExecutor({
    workingDirectory: root,
  });

  try {
    await assert.rejects(
      executor.execute({
        assignedRun: createAssignedRun(join(root, "missing-workspace")),
      }),
      (error) =>
        error instanceof WorkerNodeExecutionError
        && error.failureCode === "WORKER_NODE_WORKSPACE_INVALID"
        && /missing/i.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
