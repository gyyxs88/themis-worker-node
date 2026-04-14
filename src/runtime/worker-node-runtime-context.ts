import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkerNodeExecutionError } from "../worker/worker-node-daemon.js";
import {
  normalizeOptionalText,
  resolveWorkerNodeCredential,
  resolveWorkerNodeProvider,
} from "./worker-node-runtime-resolution.js";

export interface WorkerNodeRuntimeContextOptions {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export interface MaterializeWorkerNodeRuntimeContextInput {
  runId: string;
  workspacePath: string;
  credentialId?: string | null;
  providerId?: string | null;
  model?: string | null;
}

export interface WorkerNodeMaterializedRuntimeContext {
  runtimeRoot: string;
  contextFile: string;
  runtimeAuthFilePath: string | null;
  providerFile: string | null;
  credential: {
    credentialId: string;
    codexHome: string;
    authFilePath: string;
  } | null;
  provider: {
    providerId: string;
    baseUrl: string | null;
    effectiveModel: string | null;
  } | null;
}

export function materializeWorkerNodeRuntimeContext(
  options: WorkerNodeRuntimeContextOptions,
  input: MaterializeWorkerNodeRuntimeContextInput,
): WorkerNodeMaterializedRuntimeContext {
  const workingDirectory = resolve(options.workingDirectory);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const runtimeRoot = join(workingDirectory, "infra/local/worker-runtime", input.runId);
  mkdirSync(runtimeRoot, { recursive: true });

  let runtimeAuthFilePath: string | null = null;
  let providerFile: string | null = null;
  let credential: WorkerNodeMaterializedRuntimeContext["credential"] = null;
  let provider: WorkerNodeMaterializedRuntimeContext["provider"] = null;

  const credentialId = normalizeOptionalText(input.credentialId);

  if (credentialId) {
    const resolved = resolveWorkerNodeCredential(workingDirectory, env, credentialId);

    if (resolved.status !== "ok") {
      throw new WorkerNodeExecutionError(
        `Credential auth.json is missing: ${resolved.authFilePath}`,
        "WORKER_NODE_CREDENTIAL_MISSING",
      );
    }

    const runtimeCodexHome = join(runtimeRoot, "codex-home");
    runtimeAuthFilePath = join(runtimeCodexHome, "auth.json");
    mkdirSync(runtimeCodexHome, { recursive: true });
    copyFileSync(resolved.authFilePath, runtimeAuthFilePath);
    credential = {
      credentialId,
      codexHome: resolved.codexHome,
      authFilePath: resolved.authFilePath,
    };
  }

  const providerId = normalizeOptionalText(input.providerId);

  if (providerId) {
    const resolved = resolveWorkerNodeProvider(env, providerId);

    if (resolved.status !== "ok") {
      throw new WorkerNodeExecutionError(
        `Provider config is missing: ${providerId}`,
        "WORKER_NODE_PROVIDER_MISSING",
      );
    }

    provider = {
      providerId,
      baseUrl: resolved.baseUrl,
      effectiveModel: normalizeOptionalText(input.model) ?? resolved.defaultModel ?? null,
    };
    providerFile = join(runtimeRoot, "provider.json");
    writeFileSync(providerFile, `${JSON.stringify({
      providerId,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      defaultModel: resolved.defaultModel,
      effectiveModel: provider.effectiveModel,
    }, null, 2)}\n`, "utf8");
  }

  const contextFile = join(runtimeRoot, "runtime-context.json");
  writeFileSync(contextFile, `${JSON.stringify({
    generatedAt: now(),
    runId: input.runId,
    workspacePath: input.workspacePath,
    runtimeAuthFilePath,
    providerFile,
    credential,
    provider,
  }, null, 2)}\n`, "utf8");

  return {
    runtimeRoot,
    contextFile,
    runtimeAuthFilePath,
    providerFile,
    credential,
    provider,
  };
}
