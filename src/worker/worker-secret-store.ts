import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SECRET_STORE_FILE = "infra/local/worker-secrets.json";
const WORKER_SECRET_FILE_MODE = 0o600;

export interface WorkerNodeSecretStoreOptions {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}

export interface WorkerNodeSecretEntry {
  secretRef: string;
  value: string;
}

export function resolveWorkerNodeSecretStoreFilePath(options: WorkerNodeSecretStoreOptions): string {
  const configuredPath = normalizeOptionalText(options.filePath)
    ?? normalizeOptionalText(options.env?.THEMIS_WORKER_SECRET_STORE_FILE);

  return resolve(options.workingDirectory, configuredPath ?? DEFAULT_SECRET_STORE_FILE);
}

export function readWorkerNodeSecretStore(options: WorkerNodeSecretStoreOptions): Record<string, unknown> {
  const storeFile = resolveWorkerNodeSecretStoreFilePath(options);

  if (!existsSync(storeFile)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as unknown;
  return isRecord(parsed) ? { ...parsed } : {};
}

export function listWorkerNodeSecretRefs(options: WorkerNodeSecretStoreOptions): string[] {
  return Object.entries(readWorkerNodeSecretStore(options))
    .filter(([, value]) => normalizeSecretStoreEntry(value) !== null)
    .map(([secretRef]) => secretRef)
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function upsertWorkerNodeSecrets(
  options: WorkerNodeSecretStoreOptions,
  entries: WorkerNodeSecretEntry[],
): string[] {
  const storeFile = resolveWorkerNodeSecretStoreFilePath(options);
  const store = readWorkerNodeSecretStore(options);

  for (const entry of entries) {
    store[normalizeWorkerSecretRef(entry.secretRef)] = normalizeWorkerSecretValue(entry.value);
  }

  mkdirSync(dirname(storeFile), { recursive: true });
  const tempFile = `${storeFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempFile, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: WORKER_SECRET_FILE_MODE,
  });
  renameSync(tempFile, storeFile);
  chmodSync(storeFile, WORKER_SECRET_FILE_MODE);

  return listWorkerNodeSecretRefs(options);
}

function normalizeSecretStoreEntry(value: unknown): string | null {
  const directValue = normalizeOptionalText(value);

  if (directValue) {
    return directValue;
  }

  if (!isRecord(value)) {
    return null;
  }

  return normalizeOptionalText(value.value);
}

function normalizeWorkerSecretRef(value: string): string {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new Error("secretRef is required.");
  }

  if (/\s/.test(normalized)) {
    throw new Error("secretRef must not contain whitespace.");
  }

  if (normalized.length > 160) {
    throw new Error("secretRef is too long.");
  }

  return normalized;
}

function normalizeWorkerSecretValue(value: string): string {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new Error("secret value is required.");
  }

  return normalized;
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
