import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { materializeWorkerNodeRuntimeContext } from "../runtime/worker-node-runtime-context.js";
import type { WorkerNodeExecutor } from "./worker-node-daemon.js";
import { WorkerNodeExecutionError } from "./worker-node-daemon.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_SAMPLE_ENTRIES = 20;
const MAX_GIT_STATUS_LINES = 20;
const COMPLETION_SCHEMA_VERSION = 1;
const WORKER_DISABLED_CODEX_FEATURES = ["plugins", "memories", "general_analytics"] as const;
const DEFAULT_PROVIDER_ENV_KEY = "THEMIS_OPENAI_COMPAT_API_KEY";

export interface WorkerNodeLocalExecutorCommandInput {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxBufferBytes?: number;
}

export interface WorkerNodeLocalExecutorCommandResult {
  stdout: string;
  stderr: string;
}

export type WorkerNodeLocalExecutorCommandRunner = (
  command: string,
  args: string[],
  input: WorkerNodeLocalExecutorCommandInput,
) => Promise<WorkerNodeLocalExecutorCommandResult>;

export interface CreateLocalWorkerExecutorOptions {
  workingDirectory: string;
  reportRootDirectory?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  commandRunner?: WorkerNodeLocalExecutorCommandRunner;
}

interface WorkerNodeCodexStructuredResult {
  summary: string;
  deliverable: string;
  artifactPaths: string[];
  followUp: string[];
}

interface WorkerNodeProviderConfig {
  providerId: string;
  baseUrl: string | null;
  apiKey: string | null;
  effectiveModel: string | null;
}

interface WorkerNodeCodexExecutionResult extends WorkerNodeCodexStructuredResult {
  promptFile: string;
  outputFile: string;
  resultFile: string;
  deliverableFile: string;
  stdoutLogFile: string;
  stderrLogFile: string;
  rawResponse: string;
  stdout: string;
  stderr: string;
  resolvedArtifactPaths: string[];
  completedAt: string;
}

export function createLocalWorkerExecutor(options: CreateLocalWorkerExecutorOptions): WorkerNodeExecutor {
  const workingDirectory = resolve(options.workingDirectory);
  const reportRootDirectory = resolve(
    workingDirectory,
    options.reportRootDirectory ?? "infra/local/worker-runs",
  );
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const commandRunner = options.commandRunner ?? runLocalCommand;

  return {
    async execute({ assignedRun }) {
      const startedAt = now();
      const workspacePath = resolveWorkspacePath(
        assignedRun.executionContract.workspacePath ?? workingDirectory,
      );
      const reportDirectory = join(reportRootDirectory, assignedRun.run.runId);
      mkdirSync(reportDirectory, { recursive: true });
      const runtimeContext = materializeWorkerNodeRuntimeContext({
        workingDirectory,
        env,
        now,
      }, {
        runId: assignedRun.run.runId,
        workspacePath,
        credentialId: assignedRun.executionContract.credentialId ?? null,
        providerId: assignedRun.executionContract.provider ?? null,
        model: assignedRun.executionContract.model ?? null,
      });
      const workspace = readWorkspaceSummary(workspacePath);
      const git = await readWorkspaceGitSummary(commandRunner, workspacePath);
      const codexExecution = await runCodexExecution({
        assignedRun,
        workspacePath,
        runtimeContext,
        reportDirectory,
        env,
        now,
        commandRunner,
      });
      const completedAt = codexExecution.completedAt;
      const reportFile = writeExecutionReport({
        reportDirectory,
        assignedRun,
        workspacePath,
        workspaceEntryCount: workspace.entryCount,
        workspaceSampleEntries: workspace.sampleEntries,
        runtimeContext,
        git,
        codexExecution,
        startedAt,
        completedAt,
      });

      return {
        kind: "completed",
        summary: codexExecution.summary,
        output: {
          reportFile,
          workspacePath,
          deliverableFile: codexExecution.deliverableFile,
          resultFile: codexExecution.resultFile,
          runtimeContextFile: runtimeContext.contextFile,
          gitRepository: git.isRepository,
          gitBranch: git.branch,
          changedFileCount: git.changedFileCount,
        },
        structuredOutput: {
          schemaVersion: COMPLETION_SCHEMA_VERSION,
          summary: codexExecution.summary,
          deliverable: codexExecution.deliverable,
          artifactPaths: codexExecution.artifactPaths,
          resolvedArtifactPaths: codexExecution.resolvedArtifactPaths,
          followUp: codexExecution.followUp,
          reportFile,
          promptFile: codexExecution.promptFile,
          outputFile: codexExecution.outputFile,
          resultFile: codexExecution.resultFile,
          deliverableFile: codexExecution.deliverableFile,
          stdoutLogFile: codexExecution.stdoutLogFile,
          stderrLogFile: codexExecution.stderrLogFile,
          workspacePath,
          runtimeContext,
          workspaceEntryCount: workspace.entryCount,
          workspaceSampleEntries: workspace.sampleEntries,
          git,
          credentialId: assignedRun.executionContract.credentialId ?? null,
          provider: assignedRun.executionContract.provider ?? null,
          model: assignedRun.executionContract.model ?? null,
        },
        touchedFiles: [
          reportFile,
          runtimeContext.contextFile,
          codexExecution.promptFile,
          codexExecution.outputFile,
          codexExecution.resultFile,
          codexExecution.deliverableFile,
          codexExecution.stdoutLogFile,
          codexExecution.stderrLogFile,
          ...(runtimeContext.runtimeAuthFilePath ? [runtimeContext.runtimeAuthFilePath] : []),
          ...(runtimeContext.providerFile ? [runtimeContext.providerFile] : []),
        ],
        completedAt,
      };
    },
  };
}

function resolveWorkspacePath(workspacePath: string) {
  const normalized = workspacePath.trim();

  if (!normalized) {
    throw new WorkerNodeExecutionError(
      "Worker execution contract is missing workspacePath.",
      "WORKER_NODE_WORKSPACE_INVALID",
    );
  }

  if (!isAbsolute(normalized)) {
    throw new WorkerNodeExecutionError(
      `Workspace path must be absolute: ${normalized}`,
      "WORKER_NODE_WORKSPACE_INVALID",
    );
  }

  if (!existsSync(normalized)) {
    throw new WorkerNodeExecutionError(
      `Workspace path does not exist: ${normalized}`,
      "WORKER_NODE_WORKSPACE_INVALID",
    );
  }

  if (!lstatSync(normalized).isDirectory()) {
    throw new WorkerNodeExecutionError(
      `Workspace path is not a directory: ${normalized}`,
      "WORKER_NODE_WORKSPACE_INVALID",
    );
  }

  return normalized;
}

function readWorkspaceSummary(workspacePath: string) {
  const entries = readdirSync(workspacePath, { withFileTypes: true })
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((left, right) => left.localeCompare(right));

  return {
    entryCount: entries.length,
    sampleEntries: entries.slice(0, MAX_WORKSPACE_SAMPLE_ENTRIES),
  };
}

async function readWorkspaceGitSummary(
  commandRunner: WorkerNodeLocalExecutorCommandRunner,
  workspacePath: string,
) {
  try {
    const isInside = await commandRunner(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: workspacePath,
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      },
    );

    if (isInside.stdout.trim() !== "true") {
      return {
        isRepository: false,
        branch: null,
        changedFileCount: 0,
        statusLines: [] as string[],
        message: "当前工作区不是 Git 仓库。",
      };
    }

    const branch = await commandRunner(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: workspacePath,
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      },
    );
    const status = await commandRunner(
      "git",
      ["status", "--short"],
      {
        cwd: workspacePath,
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      },
    );
    const statusLines = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, MAX_GIT_STATUS_LINES);

    return {
      isRepository: true,
      branch: branch.stdout.trim() || null,
      changedFileCount: statusLines.length,
      statusLines,
      message: null,
    };
  } catch (error) {
    return {
      isRepository: false,
      branch: null,
      changedFileCount: 0,
      statusLines: [] as string[],
      message: toErrorMessage(error),
    };
  }
}

async function runCodexExecution(input: {
  assignedRun: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"];
  workspacePath: string;
  runtimeContext: ReturnType<typeof materializeWorkerNodeRuntimeContext>;
  reportDirectory: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
  commandRunner: WorkerNodeLocalExecutorCommandRunner;
}): Promise<WorkerNodeCodexExecutionResult> {
  const prompt = buildCodexPrompt(input.assignedRun, input.workspacePath);
  const promptFile = join(input.reportDirectory, "prompt.txt");
  const outputFile = join(input.reportDirectory, "last-message.txt");
  const resultFile = join(input.reportDirectory, "result.json");
  const deliverableFile = join(input.reportDirectory, "deliverable.md");
  const stdoutLogFile = join(input.reportDirectory, "stdout.log");
  const stderrLogFile = join(input.reportDirectory, "stderr.log");
  const outputSchemaFile = join(input.reportDirectory, "result-schema.json");
  writeFileSync(promptFile, `${prompt}\n`, "utf8");
  writeFileSync(outputSchemaFile, `${JSON.stringify(buildCompletionOutputSchema(), null, 2)}\n`, "utf8");

  const providerConfig = readProviderConfig(input.runtimeContext.providerFile);
  const codexEnv = buildCodexExecutionEnv(input.env, input.runtimeContext, providerConfig);
  const args = buildCodexExecArgs({
    workspacePath: input.workspacePath,
    outputFile,
    outputSchemaFile,
    prompt,
    providerConfig,
  });
  const commandResult = await input.commandRunner("codex", args, {
    cwd: input.workspacePath,
    timeoutMs: resolveCodexCommandTimeoutMs(input.env),
    env: codexEnv,
    maxBufferBytes: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
  });

  writeFileSync(stdoutLogFile, commandResult.stdout, "utf8");
  writeFileSync(stderrLogFile, commandResult.stderr, "utf8");

  const rawResponse = readTextFileOrEmpty(outputFile);
  const structuredResult = parseCodexStructuredResult(rawResponse);
  const resolvedArtifactPaths = structuredResult.artifactPaths
    .map((artifactPath) => resolveArtifactPath(input.workspacePath, artifactPath))
    .filter((artifactPath): artifactPath is string => Boolean(artifactPath));
  const deliverableContent = buildDeliverableDocument(structuredResult);
  writeFileSync(deliverableFile, `${deliverableContent}\n`, "utf8");
  writeFileSync(resultFile, `${JSON.stringify({
    schemaVersion: COMPLETION_SCHEMA_VERSION,
    ...structuredResult,
    resolvedArtifactPaths,
  }, null, 2)}\n`, "utf8");

  return {
    ...structuredResult,
    promptFile,
    outputFile,
    resultFile,
    deliverableFile,
    stdoutLogFile,
    stderrLogFile,
    rawResponse,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    resolvedArtifactPaths,
    completedAt: input.now(),
  };
}

function writeExecutionReport(input: {
  reportDirectory: string;
  assignedRun: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"];
  workspacePath: string;
  workspaceEntryCount: number;
  workspaceSampleEntries: string[];
  runtimeContext: ReturnType<typeof materializeWorkerNodeRuntimeContext>;
  git: {
    isRepository: boolean;
    branch: string | null;
    changedFileCount: number;
    statusLines: string[];
    message: string | null;
  };
  codexExecution: WorkerNodeCodexExecutionResult;
  startedAt: string;
  completedAt: string;
}) {
  const reportFile = join(input.reportDirectory, "report.json");
  mkdirSync(input.reportDirectory, { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify({
    generatedAt: input.completedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    run: {
      runId: input.assignedRun.run.runId,
      nodeId: input.assignedRun.run.nodeId,
      workItemId: input.assignedRun.run.workItemId,
    },
    workItem: {
      workItemId: input.assignedRun.workItem.workItemId,
      goal: input.assignedRun.workItem.goal,
      priority: input.assignedRun.workItem.priority,
      sourceType: input.assignedRun.workItem.sourceType,
    },
    executionContract: {
      workspacePath: input.workspacePath,
      credentialId: input.assignedRun.executionContract.credentialId ?? null,
      provider: input.assignedRun.executionContract.provider ?? null,
      model: input.assignedRun.executionContract.model ?? null,
    },
    result: {
      schemaVersion: COMPLETION_SCHEMA_VERSION,
      summary: input.codexExecution.summary,
      deliverable: input.codexExecution.deliverable,
      artifactPaths: input.codexExecution.artifactPaths,
      resolvedArtifactPaths: input.codexExecution.resolvedArtifactPaths,
      followUp: input.codexExecution.followUp,
    },
    workspace: {
      path: input.workspacePath,
      entryCount: input.workspaceEntryCount,
      sampleEntries: input.workspaceSampleEntries,
    },
    runtime: {
      contextFile: input.runtimeContext.contextFile,
      runtimeAuthFilePath: input.runtimeContext.runtimeAuthFilePath,
      providerFile: input.runtimeContext.providerFile,
      credential: input.runtimeContext.credential
        ? {
            credentialId: input.runtimeContext.credential.credentialId,
            codexHome: input.runtimeContext.credential.codexHome,
          }
        : null,
      provider: input.runtimeContext.provider,
    },
    codex: {
      disabledFeatures: [...WORKER_DISABLED_CODEX_FEATURES],
      promptFile: input.codexExecution.promptFile,
      outputFile: input.codexExecution.outputFile,
      resultFile: input.codexExecution.resultFile,
      deliverableFile: input.codexExecution.deliverableFile,
      stdoutLogFile: input.codexExecution.stdoutLogFile,
      stderrLogFile: input.codexExecution.stderrLogFile,
    },
    git: input.git,
  }, null, 2)}\n`, "utf8");
  return reportFile;
}

async function runLocalCommand(
  command: string,
  args: string[],
  input: WorkerNodeLocalExecutorCommandInput,
): Promise<WorkerNodeLocalExecutorCommandResult> {
  const result = await execFileAsync(command, args, {
    cwd: input.cwd,
    timeout: input.timeoutMs,
    env: input.env,
    maxBuffer: input.maxBufferBytes ?? DEFAULT_COMMAND_MAX_BUFFER_BYTES,
  });

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildCodexPrompt(
  assignedRun: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"],
  workspacePath: string,
) {
  return [
    "你正在 Themis Worker Node 上执行一条真实工单。",
    "",
    "工单上下文：",
    `- runId: ${assignedRun.run.runId}`,
    `- workItemId: ${assignedRun.workItem.workItemId}`,
    `- targetAgent: ${assignedRun.targetAgent.displayName}`,
    `- priority: ${assignedRun.workItem.priority}`,
    `- workspacePath: ${workspacePath}`,
    "",
    "工单目标：",
    assignedRun.workItem.goal,
    "",
    "执行要求：",
    "1. 直接在当前工作区内完成任务，必要时读取、修改或新增文件。",
    "2. 如果你产出了值得交付的文件，请把相对当前工作区的路径写进 artifactPaths。",
    "3. 不要向人追问额外输入；在现有上下文下尽最大努力完成，并明确写出不确定性。",
    "4. 最终输出必须符合 JSON schema：summary 用一句话概括结果，deliverable 写完整可读的交付正文，artifactPaths/followUp 用字符串数组。",
  ].join("\n");
}

function buildCompletionOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "deliverable", "artifactPaths", "followUp"],
    properties: {
      summary: {
        type: "string",
        minLength: 1,
      },
      deliverable: {
        type: "string",
        minLength: 1,
      },
      artifactPaths: {
        type: "array",
        items: {
          type: "string",
        },
      },
      followUp: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
  };
}

function readProviderConfig(providerFile: string | null): WorkerNodeProviderConfig | null {
  if (!providerFile || !existsSync(providerFile)) {
    return null;
  }

  const payload = JSON.parse(readFileSync(providerFile, "utf8")) as Record<string, unknown>;
  const providerId = normalizeOptionalText(payload.providerId);

  if (!providerId) {
    return null;
  }

  return {
    providerId,
    baseUrl: normalizeOptionalText(payload.baseUrl),
    apiKey: normalizeOptionalText(payload.apiKey),
    effectiveModel: normalizeOptionalText(payload.effectiveModel),
  };
}

function buildCodexExecutionEnv(
  env: NodeJS.ProcessEnv,
  runtimeContext: ReturnType<typeof materializeWorkerNodeRuntimeContext>,
  providerConfig: WorkerNodeProviderConfig | null,
) {
  const nextEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  nextEnv.HOME = runtimeContext.homeDirectory;
  nextEnv.CODEX_HOME = runtimeContext.codexHome;

  if (providerConfig?.apiKey) {
    nextEnv[DEFAULT_PROVIDER_ENV_KEY] = providerConfig.apiKey;
  }

  return nextEnv;
}

function buildCodexExecArgs(input: {
  workspacePath: string;
  outputFile: string;
  outputSchemaFile: string;
  prompt: string;
  providerConfig: WorkerNodeProviderConfig | null;
}) {
  return [
    "exec",
    ...WORKER_DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--sandbox",
    "danger-full-access",
    "--color",
    "never",
    "-C",
    input.workspacePath,
    "-o",
    input.outputFile,
    "--output-schema",
    input.outputSchemaFile,
    ...(input.providerConfig?.effectiveModel ? ["--model", input.providerConfig.effectiveModel] : []),
    ...buildCodexProviderConfigArgs(input.providerConfig),
    input.prompt,
  ];
}

function buildCodexProviderConfigArgs(providerConfig: WorkerNodeProviderConfig | null) {
  if (!providerConfig?.baseUrl) {
    return [];
  }

  return buildConfigArgs({
    model_provider: providerConfig.providerId,
    model_providers: {
      [providerConfig.providerId]: {
        name: providerConfig.providerId,
        base_url: providerConfig.baseUrl,
        wire_api: "responses",
        env_key: DEFAULT_PROVIDER_ENV_KEY,
        supports_websockets: true,
      },
    },
  });
}

function buildConfigArgs(configOverrides: Record<string, unknown>) {
  return Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${formatTomlLiteral(value)}`]);
}

function formatTomlLiteral(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatTomlLiteral(entry)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    return `{ ${
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => `${key} = ${formatTomlLiteral(entry)}`)
        .join(", ")
    } }`;
  }

  return "null";
}

function parseCodexStructuredResult(rawResponse: string): WorkerNodeCodexStructuredResult {
  const normalizedResponse = rawResponse.trim();

  if (!normalizedResponse) {
    throw new WorkerNodeExecutionError(
      "Codex exec finished without a final message.",
      "WORKER_NODE_EXECUTION_EMPTY_RESULT",
    );
  }

  try {
    const payload = JSON.parse(normalizedResponse) as Record<string, unknown>;
    const summary = normalizeOptionalText(payload.summary) ?? firstNonEmptyLine(normalizedResponse) ?? "Worker Node 已完成执行。";
    const deliverable = normalizeOptionalText(payload.deliverable) ?? summary;

    return {
      summary,
      deliverable,
      artifactPaths: normalizeStringArray(payload.artifactPaths),
      followUp: normalizeStringArray(payload.followUp),
    };
  } catch {
    const summary = firstNonEmptyLine(normalizedResponse) ?? "Worker Node 已完成执行。";
    return {
      summary,
      deliverable: normalizedResponse,
      artifactPaths: [],
      followUp: [],
    };
  }
}

function buildDeliverableDocument(result: WorkerNodeCodexStructuredResult) {
  const lines = [
    "# Worker Deliverable",
    "",
    "## 摘要",
    result.summary,
    "",
    "## 正文",
    result.deliverable,
  ];

  if (result.artifactPaths.length > 0) {
    lines.push("", "## 交付文件", ...result.artifactPaths.map((artifactPath) => `- ${artifactPath}`));
  }

  if (result.followUp.length > 0) {
    lines.push("", "## 后续建议", ...result.followUp.map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

function readTextFileOrEmpty(filePath: string) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function resolveArtifactPath(workspacePath: string, artifactPath: string) {
  const normalized = normalizeOptionalText(artifactPath);

  if (!normalized) {
    return null;
  }

  return isAbsolute(normalized)
    ? normalized
    : resolve(workspacePath, normalized);
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
      .map((entry) => normalizeOptionalText(entry))
      .filter((entry): entry is string => Boolean(entry))
    : [];
}

function firstNonEmptyLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeOptionalText(line))
    .find((line): line is string => Boolean(line))
    ?? null;
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCodexCommandTimeoutMs(env: NodeJS.ProcessEnv) {
  const raw = normalizeOptionalText(env.THEMIS_WORKER_CODEX_EXEC_TIMEOUT_MS);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CODEX_COMMAND_TIMEOUT_MS;
}
