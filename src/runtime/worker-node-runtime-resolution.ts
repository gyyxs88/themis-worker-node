import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkerNodeResolvedCredential {
  credentialId: string;
  status: "ok" | "missing";
  codexHome: string;
  authFilePath: string;
}

export interface WorkerNodeResolvedProvider {
  providerId: string;
  status: "ok" | "missing";
  source: "env" | null;
  baseUrl: string | null;
  apiKey: string | null;
  defaultModel: string | null;
  message: string | null;
}

export function resolveWorkerNodeCredential(
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
  credentialId: string,
): WorkerNodeResolvedCredential {
  const codexHome = credentialId === "default"
    ? resolveWorkerNodeDefaultCodexHome(env)
    : resolveWorkerNodeManagedCodexHome(workingDirectory, credentialId);
  const authFilePath = resolveWorkerNodeCodexAuthFilePath(codexHome);

  return {
    credentialId,
    status: existsSync(authFilePath) ? "ok" : "missing",
    codexHome,
    authFilePath,
  };
}

export function resolveWorkerNodeProvider(
  env: NodeJS.ProcessEnv,
  providerId: string,
): WorkerNodeResolvedProvider {
  const suffix = providerId.trim().replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  const baseUrl = normalizeOptionalText(env[`THEMIS_PROVIDER_${suffix}_BASE_URL`]);
  const apiKey = normalizeOptionalText(env[`THEMIS_PROVIDER_${suffix}_API_KEY`]);
  const defaultModel = normalizeOptionalText(env[`THEMIS_PROVIDER_${suffix}_MODEL`]);

  if (baseUrl || apiKey) {
    return {
      providerId,
      status: "ok",
      source: "env",
      baseUrl,
      apiKey,
      defaultModel,
      message: null,
    };
  }

  return {
    providerId,
    status: "missing",
    source: null,
    baseUrl: null,
    apiKey: null,
    defaultModel: null,
    message: "当前环境里没有这个 provider 的配置。",
  };
}

export function resolveWorkerNodeDefaultCodexHome(env: NodeJS.ProcessEnv) {
  return normalizeOptionalText(env.CODEX_HOME) ?? join(homedir(), ".codex");
}

export function resolveWorkerNodeManagedCodexHome(workingDirectory: string, credentialId: string) {
  return join(workingDirectory, "infra/local/codex-auth", credentialId);
}

export function resolveWorkerNodeCodexAuthFilePath(codexHome: string) {
  return join(codexHome, "auth.json");
}

export function resolveWorkerNodeCodexConfigFilePath(codexHome: string) {
  return join(codexHome, "config.toml");
}

export function normalizeOptionalText(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
