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
      reasoning: "high",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    },
  };
}

test("createLocalWorkerExecutor 会检查本地工作区并写出执行报告", async () => {
  const root = join(tmpdir(), `themis-worker-node-local-executor-${Date.now()}`);
  const workspacePath = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const codexBin = join(root, "bin", "codex");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(workspacePath, "README.md"), "# worker\n", "utf8");
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"default\"}\n", "utf8");
  writeFileSync(codexBin, "#!/bin/sh\n", "utf8");

  const commands: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const executor = createLocalWorkerExecutor({
    workingDirectory: root,
    env: {
      CODEX_HOME: codexHome,
      THEMIS_WORKER_CODEX_BIN: codexBin,
      THEMIS_PROVIDER_OPENAI_BASE_URL: "https://api.openai.example.com",
      THEMIS_PROVIDER_OPENAI_API_KEY: "provider-secret",
      THEMIS_PROVIDER_OPENAI_MODEL: "gpt-5.4",
    },
    now: () => "2026-04-14T12:30:00.000Z",
    commandRunner: async (command, args, input) => {
      commands.push({
        command,
        args,
        cwd: input.cwd,
        env: input.env,
      });

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

      if (command === codexBin && args[0] === "exec") {
        const outputFile = args[args.indexOf("-o") + 1];
        assert.ok(outputFile);
        writeFileSync(String(outputFile), JSON.stringify({
          summary: "已完成 worker 真实执行闭环。",
          deliverable: "这里是完整交付正文。",
          artifactPaths: ["reports/final.md"],
          followUp: ["继续观察线上回传是否稳定。"],
        }, null, 2), "utf8");
        assert.equal(input.cwd, workspacePath);
        assert.ok(input.env?.HOME?.endsWith("/infra/local/worker-runtime/run-alpha/home"));
        assert.ok(input.env?.CODEX_HOME?.endsWith("/infra/local/worker-runtime/run-alpha/codex-home"));
        assert.equal(input.env?.THEMIS_OPENAI_COMPAT_API_KEY, "provider-secret");
        return {
          stdout: "codex\nexecution complete\n",
          stderr: "model manager warmup warning\n",
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
    assert.equal(result.summary, "已完成 worker 真实执行闭环。");
    assert.equal(result.touchedFiles?.length, 10);
    const reportFile = result.touchedFiles?.[0];
    assert.ok(reportFile);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    assert.equal(report.run.runId, "run-alpha");
    assert.equal(report.result.summary, "已完成 worker 真实执行闭环。");
    assert.equal(report.result.deliverable, "这里是完整交付正文。");
    assert.deepEqual(report.result.artifactPaths, ["reports/final.md"]);
    assert.deepEqual(report.result.followUp, ["继续观察线上回传是否稳定。"]);
    assert.ok(report.codex.promptFile.endsWith("/prompt.txt"));
    assert.ok(report.codex.outputFile.endsWith("/last-message.txt"));
    assert.ok(report.codex.resultFile.endsWith("/result.json"));
    assert.ok(report.codex.deliverableFile.endsWith("/deliverable.md"));
    assert.equal(report.workspace.path, workspacePath);
    assert.equal(report.workspace.entryCount, 1);
    assert.equal(report.executionContract.credentialId, "default");
    assert.ok(report.runtime.contextFile.endsWith("/runtime-context.json"));
    assert.ok(report.runtime.runtimeAuthFilePath.endsWith("/codex-home/auth.json"));
    assert.ok(report.runtime.providerFile.endsWith("/provider.json"));
    assert.equal(report.git.isRepository, true);
    assert.equal(report.git.branch, "main");
    assert.equal(report.git.changedFileCount, 2);
    assert.equal(commands.length, 4);
    assert.deepEqual(commands.slice(0, 3).map((entry) => `${entry.command} ${entry.args.join(" ")} @ ${entry.cwd}`), [
      `git rev-parse --is-inside-work-tree @ ${workspacePath}`,
      `git rev-parse --abbrev-ref HEAD @ ${workspacePath}`,
      `git status --short @ ${workspacePath}`,
    ]);
    const codexArgs = commands[3]?.args ?? [];
    assert.equal(commands[3]?.command, codexBin);
    assert.ok(codexArgs.includes("--disable"));
    assert.ok(codexArgs.includes("--output-schema"));
    assert.ok(codexArgs.includes("--model"));
    assert.ok(codexArgs.includes("--sandbox"));
    assert.equal(codexArgs[codexArgs.indexOf("--sandbox") + 1], "read-only");
    assert.equal(codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.ok(codexArgs.includes("approval_policy=\"never\""));
    assert.ok(codexArgs.includes("model_reasoning_effort=\"high\""));
    const resultOutput = result.output as Record<string, unknown> | undefined;
    assert.equal(resultOutput?.reportFile, reportFile);
    assert.ok(String(resultOutput?.deliverableFile ?? "").endsWith("/deliverable.md"));
    const structuredOutput = result.structuredOutput as Record<string, unknown> | undefined;
    assert.equal(structuredOutput?.summary, "已完成 worker 真实执行闭环。");
    const artifactContents = structuredOutput?.artifactContents as Record<string, any> | undefined;
    assert.equal(artifactContents?.prompt?.label, "执行 prompt");
    assert.match(String(artifactContents?.prompt?.content ?? ""), /验证 worker 本机执行器会生成 report/);
    assert.match(String(artifactContents?.prompt?.content ?? ""), /sandboxMode: read-only/);
    assert.match(String(artifactContents?.prompt?.content ?? ""), /只能读取和分析/);
    assert.equal(artifactContents?.prompt?.truncated, false);
    assert.equal(artifactContents?.result?.mediaType, "application/json");
    assert.match(String(artifactContents?.result?.content ?? ""), /"deliverable": "这里是完整交付正文。"/);
    assert.equal(artifactContents?.deliverable?.mediaType, "text/markdown");
    assert.match(String(artifactContents?.deliverable?.content ?? ""), /这里是完整交付正文/);
    assert.equal(artifactContents?.report?.mediaType, "application/json");
    assert.match(String(artifactContents?.report?.content ?? ""), /"git":/);
    assert.equal(artifactContents?.stdout?.mediaType, "text/plain");
    assert.match(String(artifactContents?.stdout?.content ?? ""), /execution complete/);
    assert.equal(artifactContents?.stderr?.mediaType, "text/plain");
    assert.match(String(artifactContents?.stderr?.content ?? ""), /warmup warning/);
    assert.equal(report.executionContract.sandboxMode, "read-only");
    assert.equal(report.executionContract.approvalPolicy, "never");
    assert.equal(report.executionContract.networkAccessEnabled, false);
    assert.equal(report.codex.sandboxMode, "read-only");
    assert.equal(report.codex.approvalPolicy, "never");
    assert.equal(report.codex.bypassedApprovalsAndSandbox, false);
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
