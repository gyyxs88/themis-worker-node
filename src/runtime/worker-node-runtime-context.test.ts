import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerNodeExecutionError } from "../worker/worker-node-daemon.js";
import { materializeWorkerNodeRuntimeContext } from "./worker-node-runtime-context.js";

test("materializeWorkerNodeRuntimeContext 会落本地 runtime context / auth / provider 文件", () => {
  const root = join(tmpdir(), `themis-worker-runtime-context-${Date.now()}`);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"default\"}\n", "utf8");
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.4\"\nmodel_reasoning_effort = \"xhigh\"\n", "utf8");

  try {
    const result = materializeWorkerNodeRuntimeContext({
      workingDirectory: root,
      env: {
        CODEX_HOME: codexHome,
        THEMIS_PROVIDER_OPENAI_BASE_URL: "https://api.openai.example.com",
        THEMIS_PROVIDER_OPENAI_API_KEY: "provider-secret",
        THEMIS_PROVIDER_OPENAI_MODEL: "gpt-5.4",
      },
      now: () => "2026-04-14T13:30:00.000Z",
    }, {
      runId: "run-alpha",
      workspacePath: "/srv/platform-alpha",
      credentialId: "default",
      providerId: "openai",
      model: "gpt-5.4-mini",
    });

    assert.ok(result.contextFile.endsWith("/runtime-context.json"));
    assert.ok(result.codexHome.endsWith("/codex-home"));
    assert.ok(result.homeDirectory.endsWith("/home"));
    assert.ok(result.runtimeAuthFilePath?.endsWith("/codex-home/auth.json"));
    assert.ok(result.runtimeConfigFilePath?.endsWith("/codex-home/config.toml"));
    assert.ok(result.providerFile?.endsWith("/provider.json"));

    const runtimeContext = JSON.parse(readFileSync(result.contextFile, "utf8")) as Record<string, any>;
    const provider = JSON.parse(readFileSync(result.providerFile ?? "", "utf8")) as Record<string, any>;
    assert.equal(runtimeContext.workspacePath, "/srv/platform-alpha");
    assert.equal(runtimeContext.codexHome, result.codexHome);
    assert.equal(runtimeContext.homeDirectory, result.homeDirectory);
    assert.equal(runtimeContext.credential.credentialId, "default");
    assert.equal(runtimeContext.runtimeConfigFilePath, result.runtimeConfigFilePath);
    assert.equal(runtimeContext.provider.providerId, "openai");
    assert.equal(provider.effectiveModel, "gpt-5.4-mini");
    assert.equal(readFileSync(result.runtimeAuthFilePath ?? "", "utf8"), "{\"token\":\"default\"}\n");
    assert.equal(
      readFileSync(result.runtimeConfigFilePath ?? "", "utf8"),
      "model = \"gpt-5.4\"\nmodel_reasoning_effort = \"xhigh\"\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeWorkerNodeRuntimeContext 会在 credential / provider 缺失时失败", () => {
  const root = join(tmpdir(), `themis-worker-runtime-context-missing-${Date.now()}`);
  mkdirSync(root, { recursive: true });

  try {
    assert.throws(() => materializeWorkerNodeRuntimeContext({
      workingDirectory: root,
      env: {
        CODEX_HOME: join(root, "missing-codex-home"),
      },
    }, {
      runId: "run-alpha",
      workspacePath: "/srv/platform-alpha",
      credentialId: "default",
    }), (error) =>
      error instanceof WorkerNodeExecutionError
      && error.failureCode === "WORKER_NODE_CREDENTIAL_MISSING");

    assert.throws(() => materializeWorkerNodeRuntimeContext({
      workingDirectory: root,
      env: {},
    }, {
      runId: "run-beta",
      workspacePath: "/srv/platform-beta",
      providerId: "openai",
    }), (error) =>
      error instanceof WorkerNodeExecutionError
      && error.failureCode === "WORKER_NODE_PROVIDER_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeWorkerNodeRuntimeContext 在未显式指定 credentialId 时会复用默认 auth", () => {
  const root = join(tmpdir(), `themis-worker-runtime-context-default-${Date.now()}`);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"default\"}\n", "utf8");
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.4\"\nmodel_reasoning_effort = \"xhigh\"\n", "utf8");

  try {
    const result = materializeWorkerNodeRuntimeContext({
      workingDirectory: root,
      env: {
        CODEX_HOME: codexHome,
      },
      now: () => "2026-04-14T13:31:00.000Z",
    }, {
      runId: "run-default",
      workspacePath: "/srv/platform-default",
    });

    assert.equal(result.credential?.credentialId, "default");
    assert.ok(result.runtimeAuthFilePath?.endsWith("/codex-home/auth.json"));
    assert.ok(result.runtimeConfigFilePath?.endsWith("/codex-home/config.toml"));
    assert.equal(readFileSync(result.runtimeAuthFilePath ?? "", "utf8"), "{\"token\":\"default\"}\n");
    assert.equal(
      readFileSync(result.runtimeConfigFilePath ?? "", "utf8"),
      "model = \"gpt-5.4\"\nmodel_reasoning_effort = \"xhigh\"\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
