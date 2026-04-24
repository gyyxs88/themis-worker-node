import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { PlatformWorkerClient } from "../platform/platform-worker-client.js";
import {
  normalizeOptionalText,
  resolveWorkerNodeCredential,
  resolveWorkerNodeProvider,
} from "../runtime/worker-node-runtime-resolution.js";

export interface WorkerNodeDiagnosticsWorkspaceSummary {
  inputPath: string;
  resolvedPath: string;
  status: "ok" | "relative" | "missing" | "not_directory";
}

export interface WorkerNodeDiagnosticsCredentialSummary {
  credentialId: string;
  status: "ok" | "missing";
  codexHome: string;
}

export interface WorkerNodeDiagnosticsProviderSummary {
  providerId: string;
  status: "ok" | "missing";
  source: "env" | null;
  defaultModel: string | null;
  message: string | null;
}

export interface WorkerNodeDiagnosticsPlatformSummary {
  status: "skipped" | "config_incomplete" | "ok" | "failed";
  baseUrl: string | null;
  nodeCount: number | null;
  message: string | null;
}

export interface WorkerNodeDiagnosticsCodexSummary {
  status: "ok" | "missing";
  command: string;
  source: "explicit" | "local" | "sibling" | "path" | "fallback";
  message: string | null;
}

export interface WorkerNodeDiagnosticsSummary {
  generatedAt: string;
  workingDirectory: string;
  workspaces: WorkerNodeDiagnosticsWorkspaceSummary[];
  credentials: WorkerNodeDiagnosticsCredentialSummary[];
  providers: WorkerNodeDiagnosticsProviderSummary[];
  codex: WorkerNodeDiagnosticsCodexSummary;
  platform: WorkerNodeDiagnosticsPlatformSummary;
  primaryDiagnosis: {
    id: string;
    severity: "error" | "warning" | "info";
    title: string;
    summary: string;
  };
  recommendedNextSteps: string[];
}

export interface ReadWorkerNodeDiagnosticsInput {
  workspaceCapabilities: string[];
  credentialCapabilities: string[];
  providerCapabilities: string[];
  platformBaseUrl?: string | null;
  ownerPrincipalId?: string | null;
  webAccessToken?: string | null;
}

export interface WorkerNodeDiagnosticsServiceOptions {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export class WorkerNodeDiagnosticsService {
  private readonly workingDirectory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;

  constructor(options: WorkerNodeDiagnosticsServiceOptions) {
    this.workingDirectory = options.workingDirectory;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async readSummary(input: ReadWorkerNodeDiagnosticsInput): Promise<WorkerNodeDiagnosticsSummary> {
    const workspaces = dedupeStrings(input.workspaceCapabilities).map((workspacePath) =>
      summarizeWorkspacePath(this.workingDirectory, workspacePath)
    );
    const credentials = dedupeStrings(input.credentialCapabilities).map((credentialId) =>
      summarizeCredential(this.workingDirectory, this.env, credentialId)
    );
    const providers = dedupeStrings(input.providerCapabilities).map((providerId) =>
      summarizeProvider(this.env, providerId)
    );
    const codex = summarizeCodexCommand(this.workingDirectory, this.env);
    const platform = await this.probePlatform(input);
    const diagnosis = summarizeDiagnosis({
      workspaces,
      credentials,
      providers,
      codex,
      platform,
    });

    return {
      generatedAt: this.now(),
      workingDirectory: this.workingDirectory,
      workspaces,
      credentials,
      providers,
      codex,
      platform,
      primaryDiagnosis: diagnosis.primaryDiagnosis,
      recommendedNextSteps: diagnosis.recommendedNextSteps,
    };
  }

  private async probePlatform(input: ReadWorkerNodeDiagnosticsInput): Promise<WorkerNodeDiagnosticsPlatformSummary> {
    const platformBaseUrl = normalizeOptionalText(input.platformBaseUrl);
    const ownerPrincipalId = normalizeOptionalText(input.ownerPrincipalId);
    const webAccessToken = normalizeOptionalText(input.webAccessToken);

    if (!platformBaseUrl && !ownerPrincipalId && !webAccessToken) {
      return {
        status: "skipped",
        baseUrl: null,
        nodeCount: null,
        message: "未提供平台连接参数，已跳过平台探测。",
      };
    }

    if (!platformBaseUrl || !ownerPrincipalId || !webAccessToken) {
      return {
        status: "config_incomplete",
        baseUrl: platformBaseUrl,
        nodeCount: null,
        message: "平台探测需要同时提供 --platform / --owner-principal / --token。",
      };
    }

    try {
      const client = new PlatformWorkerClient({
        baseUrl: platformBaseUrl,
        ownerPrincipalId,
        webAccessToken,
        fetchImpl: this.fetchImpl,
      });
      const result = await client.probeAccess();
      return {
        status: "ok",
        baseUrl: platformBaseUrl,
        nodeCount: result.nodeCount,
        message: "平台登录与节点列表读取成功。",
      };
    } catch (error) {
      return {
        status: "failed",
        baseUrl: platformBaseUrl,
        nodeCount: null,
        message: toErrorMessage(error),
      };
    }
  }
}

function summarizeWorkspacePath(
  workingDirectory: string,
  inputPath: string,
): WorkerNodeDiagnosticsWorkspaceSummary {
  const trimmedInput = inputPath.trim();
  const resolvedPath = resolve(workingDirectory, trimmedInput);

  if (!trimmedInput) {
    return {
      inputPath,
      resolvedPath,
      status: "missing",
    };
  }

  if (!isAbsolute(trimmedInput)) {
    return {
      inputPath,
      resolvedPath,
      status: "relative",
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      inputPath,
      resolvedPath,
      status: "missing",
    };
  }

  if (!lstatSync(resolvedPath).isDirectory()) {
    return {
      inputPath,
      resolvedPath,
      status: "not_directory",
    };
  }

  return {
    inputPath,
    resolvedPath,
    status: "ok",
  };
}

function summarizeCredential(
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
  credentialId: string,
): WorkerNodeDiagnosticsCredentialSummary {
  const resolved = resolveWorkerNodeCredential(workingDirectory, env, credentialId);

  return {
    credentialId,
    status: resolved.status,
    codexHome: resolved.codexHome,
  };
}

function summarizeProvider(env: NodeJS.ProcessEnv, providerId: string): WorkerNodeDiagnosticsProviderSummary {
  const resolved = resolveWorkerNodeProvider(env, providerId);
  return {
    providerId,
    status: resolved.status,
    source: resolved.source,
    defaultModel: resolved.defaultModel,
    message: resolved.message,
  };
}

function summarizeCodexCommand(workingDirectory: string, env: NodeJS.ProcessEnv): WorkerNodeDiagnosticsCodexSummary {
  const explicitCommand = normalizeOptionalText(env.THEMIS_WORKER_CODEX_BIN);
  const candidates: Array<{ command: string; source: WorkerNodeDiagnosticsCodexSummary["source"] }> = [
    ...(explicitCommand ? [{ command: explicitCommand, source: "explicit" as const }] : []),
    { command: resolve(workingDirectory, "node_modules/.bin/codex"), source: "local" as const },
    { command: resolve(workingDirectory, "../themis-prod/node_modules/.bin/codex"), source: "sibling" as const },
    { command: resolve(workingDirectory, "../themis/node_modules/.bin/codex"), source: "sibling" as const },
    { command: resolve(workingDirectory, "../themis-main/node_modules/.bin/codex"), source: "sibling" as const },
  ];

  for (const candidate of candidates) {
    const resolvedCommand = resolveCommandCandidate(candidate.command, env);
    if (resolvedCommand) {
      return {
        status: "ok",
        command: resolvedCommand,
        source: candidate.source,
        message: null,
      };
    }
  }

  const pathCommand = findCommandOnPath("codex", env);
  if (pathCommand) {
    return {
      status: "ok",
      command: pathCommand,
      source: "path",
      message: "通过 PATH 找到 codex；常驻 systemd 环境不一定继承交互 shell 的 PATH，生产节点建议使用本仓 node_modules/.bin/codex 或显式 THEMIS_WORKER_CODEX_BIN。",
    };
  }

  return {
    status: "missing",
    command: explicitCommand ?? "codex",
    source: explicitCommand ? "explicit" : "fallback",
    message: "未找到可执行 codex；真实执行 run 时会失败为 spawn codex ENOENT。",
  };
}

function summarizeDiagnosis(input: {
  workspaces: WorkerNodeDiagnosticsWorkspaceSummary[];
  credentials: WorkerNodeDiagnosticsCredentialSummary[];
  providers: WorkerNodeDiagnosticsProviderSummary[];
  codex: WorkerNodeDiagnosticsCodexSummary;
  platform: WorkerNodeDiagnosticsPlatformSummary;
}) {
  const recommendedNextSteps = new Set<string>();
  const invalidWorkspaces = input.workspaces.filter((item) => item.status !== "ok");
  const missingCredentials = input.credentials.filter((item) => item.status === "missing");
  const missingProviders = input.providers.filter((item) => item.status === "missing");

  if (input.platform.status === "config_incomplete") {
    recommendedNextSteps.add("补齐 --platform / --owner-principal / --token 后重跑 themis-worker-node doctor worker-node。");
    return {
      primaryDiagnosis: {
        id: "platform_probe_config_incomplete",
        severity: "warning" as const,
        title: "Worker Node 平台探测参数不完整",
        summary: "已提供部分平台连接参数，但不足以完成节点列表探测。",
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (input.platform.status === "failed") {
    recommendedNextSteps.add("先确认平台 URL、owner principal 与 token 是否正确。");
    recommendedNextSteps.add("确认平台服务可达后，再重跑 themis-worker-node doctor worker-node。");
    return {
      primaryDiagnosis: {
        id: "platform_probe_failed",
        severity: "error" as const,
        title: "Worker Node 无法连通平台",
        summary: input.platform.message ?? "平台探测失败。",
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (invalidWorkspaces.length > 0) {
    recommendedNextSteps.add("把 --workspace 改成 Worker 本机真实存在的绝对目录。");
    return {
      primaryDiagnosis: {
        id: "workspace_capability_invalid",
        severity: "error" as const,
        title: "Worker Node 工作区能力声明无效",
        summary: `当前有 ${invalidWorkspaces.length} 个工作区路径不是可用的绝对目录。`,
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (input.codex.status === "missing") {
    recommendedNextSteps.add("在 Worker Node 仓执行 npm install，确保 node_modules/.bin/codex 存在；或显式配置 THEMIS_WORKER_CODEX_BIN。");
    return {
      primaryDiagnosis: {
        id: "codex_command_missing",
        severity: "error" as const,
        title: "Worker Node 找不到 Codex 可执行文件",
        summary: input.codex.message ?? "未找到可执行 codex。",
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (missingCredentials.length > 0) {
    recommendedNextSteps.add("先准备对应 credential 的 auth.json，再重跑 doctor worker-node。");
    return {
      primaryDiagnosis: {
        id: "credential_missing",
        severity: "warning" as const,
        title: "Worker Node 缺少可用 credential",
        summary: `当前有 ${missingCredentials.length} 个 credential 还没有本机 auth.json。`,
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (missingProviders.length > 0) {
    recommendedNextSteps.add("如果这台 Worker 需要声明 provider capability，请先补齐对应 THEMIS_PROVIDER_<ID>_* 环境变量。");
    return {
      primaryDiagnosis: {
        id: "provider_missing",
        severity: "warning" as const,
        title: "Worker Node provider 配置缺失",
        summary: `当前有 ${missingProviders.length} 个 provider capability 在本机环境里没有找到对应配置。`,
      },
      recommendedNextSteps: [...recommendedNextSteps],
    };
  }

  if (input.platform.status === "ok") {
    recommendedNextSteps.add("当前可继续执行 themis-worker-node worker-node run --once 验证首个 run 闭环。");
  } else {
    recommendedNextSteps.add("如果只做本机预检，当前可先跳过平台参数；真正接平台前再补齐。");
  }

  return {
    primaryDiagnosis: {
      id: "healthy",
      severity: "info" as const,
      title: "Worker Node 预检通过",
      summary: "本地工作区、credential、provider 与平台探测都处于可解释状态。",
    },
    recommendedNextSteps: [...recommendedNextSteps],
  };
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolveCommandCandidate(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command)) {
    return isExecutableFile(command) ? command : null;
  }

  return findCommandOnPath(command, env);
}

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = normalizeOptionalText(env.PATH);
  if (!pathValue || command.includes("/")) {
    return null;
  }

  for (const entry of pathValue.split(delimiter)) {
    const directory = normalizeOptionalText(entry);
    if (!directory) {
      continue;
    }

    const candidate = resolve(directory, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
