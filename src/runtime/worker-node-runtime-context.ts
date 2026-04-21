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
  codexHome: string;
  homeDirectory: string;
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
  const runtimeCodexHome = join(runtimeRoot, "codex-home");
  const homeDirectory = join(runtimeRoot, "home");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(runtimeCodexHome, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });

  let runtimeAuthFilePath: string | null = null;
  let providerFile: string | null = null;
  let credential: WorkerNodeMaterializedRuntimeContext["credential"] = null;
  let provider: WorkerNodeMaterializedRuntimeContext["provider"] = null;

  const requestedCredentialId = normalizeOptionalText(input.credentialId);
  const effectiveCredentialId = requestedCredentialId ?? "default";

  if (requestedCredentialId) {
    const resolved = resolveWorkerNodeCredential(workingDirectory, env, effectiveCredentialId);

    if (resolved.status !== "ok") {
      throw new WorkerNodeExecutionError(
        `Credential auth.json is missing: ${resolved.authFilePath}`,
        "WORKER_NODE_CREDENTIAL_MISSING",
      );
    }

    runtimeAuthFilePath = join(runtimeCodexHome, "auth.json");
    copyFileSync(resolved.authFilePath, runtimeAuthFilePath);
    credential = {
      credentialId: effectiveCredentialId,
      codexHome: resolved.codexHome,
      authFilePath: resolved.authFilePath,
    };
  } else {
    const resolvedDefaultCredential = resolveWorkerNodeCredential(workingDirectory, env, effectiveCredentialId);

    if (resolvedDefaultCredential.status === "ok") {
      runtimeAuthFilePath = join(runtimeCodexHome, "auth.json");
      copyFileSync(resolvedDefaultCredential.authFilePath, runtimeAuthFilePath);
      credential = {
        credentialId: effectiveCredentialId,
        codexHome: resolvedDefaultCredential.codexHome,
        authFilePath: resolvedDefaultCredential.authFilePath,
      };
    }
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
    codexHome: runtimeCodexHome,
    homeDirectory,
    runtimeAuthFilePath,
    providerFile,
    credential,
    provider,
  }, null, 2)}\n`, "utf8");

  return {
    runtimeRoot,
    codexHome: runtimeCodexHome,
    homeDirectory,
    contextFile,
    runtimeAuthFilePath,
    providerFile,
    credential,
    provider,
  };
}
