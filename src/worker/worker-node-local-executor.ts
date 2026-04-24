import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { materializeWorkerNodeRuntimeContext } from "../runtime/worker-node-runtime-context.js";
import type { WorkerNodeExecutor } from "./worker-node-daemon.js";
import { WorkerNodeExecutionError } from "./worker-node-daemon.js";

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_EMBEDDED_ARTIFACT_MAX_BYTES = 128 * 1024;
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
  prompt: string;
  promptFile: string;
  outputFile: string;
  resultFile: string;
  deliverableFile: string;
  stdoutLogFile: string;
  stderrLogFile: string;
  resultJson: string;
  deliverableContent: string;
  rawResponse: string;
  stdout: string;
  stderr: string;
  resolvedArtifactPaths: string[];
  sandboxMode: WorkerNodeCodexSandboxMode;
  approvalPolicy: WorkerNodeCodexApprovalPolicy;
  bypassedApprovalsAndSandbox: boolean;
  model: string | null;
  reasoning: string | null;
  completedAt: string;
}

interface WorkerNodeEmbeddedArtifactSnapshot {
  label: string;
  filePath: string;
  mediaType: string;
  content: string;
  truncated: boolean;
  byteLength: number;
}

class WorkerNodeCommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    message: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) {
    super(input.message);
    this.name = "WorkerNodeCommandError";
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

type WorkerNodeCodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type WorkerNodeCodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

interface WorkerNodeCodexExecutionOptions {
  sandboxMode: WorkerNodeCodexSandboxMode;
  approvalPolicy: WorkerNodeCodexApprovalPolicy;
  bypassedApprovalsAndSandbox: boolean;
  model: string | null;
  reasoning: string | null;
}

const DEFAULT_CODEX_SANDBOX_MODE: WorkerNodeCodexSandboxMode = "workspace-write";
const DEFAULT_CODEX_APPROVAL_POLICY: WorkerNodeCodexApprovalPolicy = "never";
const CODEX_SANDBOX_MODES = new Set<WorkerNodeCodexSandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CODEX_APPROVAL_POLICIES = new Set<WorkerNodeCodexApprovalPolicy>([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);

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
        workingDirectory,
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
      const artifactContents = buildExecutionArtifactContents({
        codexExecution,
        reportFile,
        reportJson: readTextFileOrEmpty(reportFile),
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
          sandboxMode: codexExecution.sandboxMode,
          approvalPolicy: codexExecution.approvalPolicy,
          bypassedApprovalsAndSandbox: codexExecution.bypassedApprovalsAndSandbox,
          model: codexExecution.model,
          reasoning: codexExecution.reasoning,
          workspacePath,
          runtimeContext,
          workspaceEntryCount: workspace.entryCount,
          workspaceSampleEntries: workspace.sampleEntries,
          git,
          credentialId: assignedRun.executionContract.credentialId ?? null,
          provider: assignedRun.executionContract.provider ?? null,
          artifactContents,
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
  workingDirectory: string;
  workspacePath: string;
  runtimeContext: ReturnType<typeof materializeWorkerNodeRuntimeContext>;
  reportDirectory: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
  commandRunner: WorkerNodeLocalExecutorCommandRunner;
}): Promise<WorkerNodeCodexExecutionResult> {
  const executionOptions = resolveCodexExecutionOptions(input.assignedRun.executionContract);
  const prompt = buildCodexPrompt(input.assignedRun, input.workspacePath, executionOptions);
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
  const codexCommand = resolveCodexCommand(input.workingDirectory, input.env);
  const args = buildCodexExecArgs({
    workspacePath: input.workspacePath,
    outputFile,
    outputSchemaFile,
    prompt,
    providerConfig,
    executionOptions,
  });
  const commandResult = await runCodexCommandWithFailureArtifacts(
    input.commandRunner,
    codexCommand,
    args,
    {
      cwd: input.workspacePath,
      timeoutMs: resolveCodexCommandTimeoutMs(input.env),
      env: codexEnv,
      maxBufferBytes: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
    },
    {
      stdoutLogFile,
      stderrLogFile,
    },
  );

  writeFileSync(stdoutLogFile, commandResult.stdout, "utf8");
  writeFileSync(stderrLogFile, commandResult.stderr, "utf8");

  const rawResponse = readTextFileOrEmpty(outputFile);
  const structuredResult = parseCodexStructuredResult(rawResponse);
  const resolvedArtifactPaths = structuredResult.artifactPaths
    .map((artifactPath) => resolveArtifactPath(input.workspacePath, artifactPath))
    .filter((artifactPath): artifactPath is string => Boolean(artifactPath));
  const deliverableContent = buildDeliverableDocument(structuredResult);
  const resultJson = `${JSON.stringify({
    schemaVersion: COMPLETION_SCHEMA_VERSION,
    ...structuredResult,
    resolvedArtifactPaths,
  }, null, 2)}\n`;
  writeFileSync(deliverableFile, `${deliverableContent}\n`, "utf8");
  writeFileSync(resultFile, resultJson, "utf8");

  return {
    ...structuredResult,
    prompt,
    promptFile,
    outputFile,
    resultFile,
    deliverableFile,
    stdoutLogFile,
    stderrLogFile,
    resultJson,
    deliverableContent,
    rawResponse,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    resolvedArtifactPaths,
    sandboxMode: executionOptions.sandboxMode,
    approvalPolicy: executionOptions.approvalPolicy,
    bypassedApprovalsAndSandbox: executionOptions.bypassedApprovalsAndSandbox,
    model: executionOptions.model,
    reasoning: executionOptions.reasoning,
    completedAt: input.now(),
  };
}

async function runCodexCommandWithFailureArtifacts(
  commandRunner: WorkerNodeLocalExecutorCommandRunner,
  command: string,
  args: string[],
  input: WorkerNodeLocalExecutorCommandInput,
  artifacts: {
    stdoutLogFile: string;
    stderrLogFile: string;
  },
): Promise<WorkerNodeLocalExecutorCommandResult> {
  try {
    return await commandRunner(command, args, input);
  } catch (error) {
    if (error instanceof WorkerNodeCommandError) {
      writeFileSync(artifacts.stdoutLogFile, error.stdout, "utf8");
      writeFileSync(artifacts.stderrLogFile, error.stderr, "utf8");
      throw new WorkerNodeExecutionError(
        buildCodexCommandFailureMessage(error, artifacts.stderrLogFile),
        classifyCodexCommandFailure(error),
      );
    }

    throw error;
  }
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
      reasoning: input.assignedRun.executionContract.reasoning ?? null,
      sandboxMode: input.codexExecution.sandboxMode,
      approvalPolicy: input.codexExecution.approvalPolicy,
      networkAccessEnabled: input.assignedRun.executionContract.networkAccessEnabled ?? null,
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
      sandboxMode: input.codexExecution.sandboxMode,
      approvalPolicy: input.codexExecution.approvalPolicy,
      bypassedApprovalsAndSandbox: input.codexExecution.bypassedApprovalsAndSandbox,
      model: input.codexExecution.model,
      reasoning: input.codexExecution.reasoning,
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

function buildExecutionArtifactContents(input: {
  codexExecution: WorkerNodeCodexExecutionResult;
  reportFile: string;
  reportJson: string;
}): Record<string, WorkerNodeEmbeddedArtifactSnapshot> {
  return {
    prompt: createEmbeddedArtifactSnapshot({
      label: "执行 prompt",
      filePath: input.codexExecution.promptFile,
      mediaType: "text/plain",
      content: `${input.codexExecution.prompt}\n`,
    }),
    output: createEmbeddedArtifactSnapshot({
      label: "Codex 最后输出",
      filePath: input.codexExecution.outputFile,
      mediaType: "text/plain",
      content: input.codexExecution.rawResponse,
    }),
    result: createEmbeddedArtifactSnapshot({
      label: "结构化结果",
      filePath: input.codexExecution.resultFile,
      mediaType: "application/json",
      content: input.codexExecution.resultJson,
    }),
    deliverable: createEmbeddedArtifactSnapshot({
      label: "交付正文",
      filePath: input.codexExecution.deliverableFile,
      mediaType: "text/markdown",
      content: `${input.codexExecution.deliverableContent}\n`,
    }),
    report: createEmbeddedArtifactSnapshot({
      label: "执行报告",
      filePath: input.reportFile,
      mediaType: "application/json",
      content: input.reportJson,
    }),
    stdout: createEmbeddedArtifactSnapshot({
      label: "标准输出",
      filePath: input.codexExecution.stdoutLogFile,
      mediaType: "text/plain",
      content: input.codexExecution.stdout,
    }),
    stderr: createEmbeddedArtifactSnapshot({
      label: "标准错误",
      filePath: input.codexExecution.stderrLogFile,
      mediaType: "text/plain",
      content: input.codexExecution.stderr,
    }),
  };
}

function createEmbeddedArtifactSnapshot(input: {
  label: string;
  filePath: string;
  mediaType: string;
  content: string;
}): WorkerNodeEmbeddedArtifactSnapshot {
  const normalizedContent = typeof input.content === "string" ? input.content : "";
  const byteLength = Buffer.byteLength(normalizedContent, "utf8");
  const truncatedContent = truncateUtf8Text(normalizedContent, DEFAULT_EMBEDDED_ARTIFACT_MAX_BYTES);

  return {
    label: input.label,
    filePath: input.filePath,
    mediaType: input.mediaType,
    content: truncatedContent.content,
    truncated: truncatedContent.truncated,
    byteLength,
  };
}

function truncateUtf8Text(
  content: string,
  maxBytes: number,
): {
  content: string;
  truncated: boolean;
} {
  const buffer = Buffer.from(content, "utf8");

  if (buffer.length <= maxBytes) {
    return {
      content,
      truncated: false,
    };
  }

  let truncated = buffer.subarray(0, maxBytes).toString("utf8");

  while (truncated.endsWith("\uFFFD")) {
    truncated = truncated.slice(0, -1);
  }

  return {
    content: truncated,
    truncated: true,
  };
}

async function runLocalCommand(
  command: string,
  args: string[],
  input: WorkerNodeLocalExecutorCommandInput,
): Promise<WorkerNodeLocalExecutorCommandResult> {
  const maxBufferBytes = input.maxBufferBytes ?? DEFAULT_COMMAND_MAX_BUFFER_BYTES;

  return await new Promise<WorkerNodeLocalExecutorCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    const fail = (error: Error) => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      finalize(() => rejectPromise(error));
    };

    const timeoutHandle = setTimeout(() => {
      fail(new Error(`Command timed out after ${input.timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
        fail(new Error(`Command output exceeded ${maxBufferBytes} bytes: ${command} ${args.join(" ")}`));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
        fail(new Error(`Command output exceeded ${maxBufferBytes} bytes: ${command} ${args.join(" ")}`));
      }
    });

    child.on("error", (error) => {
      finalize(() => rejectPromise(error));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        finalize(() => resolvePromise({ stdout, stderr }));
        return;
      }

      const signalLabel = signal ? ` (signal ${signal})` : "";
      const detail = selectMeaningfulCommandFailureLine(stderr) ?? "Command failed.";
      finalize(() => rejectPromise(new WorkerNodeCommandError({
        message: `Command failed with exit code ${code ?? "unknown"}${signalLabel}: ${detail}`,
        exitCode: code,
        signal,
        stdout,
        stderr,
      })));
    });
  });
}

function buildCodexCommandFailureMessage(error: WorkerNodeCommandError, stderrLogFile: string) {
  const signalLabel = error.signal ? ` (signal ${error.signal})` : "";
  const detail = selectMeaningfulCommandFailureLine(error.stderr) ?? "Command failed.";
  return `Codex command failed with exit code ${error.exitCode ?? "unknown"}${signalLabel}: ${detail} (stderr: ${stderrLogFile})`;
}

function classifyCodexCommandFailure(error: WorkerNodeCommandError) {
  const stderr = error.stderr.toLowerCase();
  if (
    stderr.includes("flagged for potentially high-risk cyber activity")
    || stderr.includes("safety-checks/cybersecurity")
  ) {
    return "WORKER_NODE_CODEX_SAFETY_BLOCKED";
  }

  return "WORKER_NODE_CODEX_COMMAND_FAILED";
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildCodexPrompt(
  assignedRun: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"],
  workspacePath: string,
  executionOptions: WorkerNodeCodexExecutionOptions,
) {
  const readOnly = executionOptions.sandboxMode === "read-only";
  return [
    "你正在 Themis Worker Node 上执行一条真实工单。",
    "",
    "工单上下文：",
    `- runId: ${assignedRun.run.runId}`,
    `- workItemId: ${assignedRun.workItem.workItemId}`,
    `- targetAgent: ${assignedRun.targetAgent.displayName}`,
    `- priority: ${assignedRun.workItem.priority}`,
    `- workspacePath: ${workspacePath}`,
    `- sandboxMode: ${executionOptions.sandboxMode}`,
    `- approvalPolicy: ${executionOptions.approvalPolicy}`,
    "",
    "工单目标：",
    assignedRun.workItem.goal,
    "",
    "执行要求：",
    readOnly
      ? "1. 直接在当前工作区内完成任务；当前 sandbox 是 read-only，只能读取和分析，不要修改、新增或删除文件。"
      : "1. 直接在当前工作区内完成任务，必要时读取、修改或新增文件。",
    readOnly
      ? "2. 如果你发现需要写入文件才能完成，请在 deliverable 里说明需要后续补写，不要尝试绕过只读限制。"
      : "2. 如果你产出了值得交付的文件，请把相对当前工作区的路径写进 artifactPaths。",
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
  executionOptions: WorkerNodeCodexExecutionOptions;
}) {
  const model = input.executionOptions.model ?? input.providerConfig?.effectiveModel;
  return [
    "exec",
    ...WORKER_DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--ephemeral",
    "--skip-git-repo-check",
    ...(input.executionOptions.bypassedApprovalsAndSandbox ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    "--sandbox",
    input.executionOptions.sandboxMode,
    "--color",
    "never",
    "-C",
    input.workspacePath,
    "-o",
    input.outputFile,
    "--output-schema",
    input.outputSchemaFile,
    ...(model ? ["--model", model] : []),
    ...buildCodexRuntimeConfigArgs(input.executionOptions),
    ...buildCodexProviderConfigArgs(input.providerConfig),
    input.prompt,
  ];
}

function buildCodexRuntimeConfigArgs(options: WorkerNodeCodexExecutionOptions) {
  return buildConfigArgs({
    approval_policy: options.approvalPolicy,
    ...(options.reasoning ? { model_reasoning_effort: options.reasoning } : {}),
  });
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

function resolveCodexExecutionOptions(
  contract: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"]["executionContract"],
): WorkerNodeCodexExecutionOptions {
  const sandboxMode = normalizeCodexSandboxMode(contract.sandboxMode) ?? DEFAULT_CODEX_SANDBOX_MODE;
  const approvalPolicy = normalizeCodexApprovalPolicy(contract.approvalPolicy) ?? DEFAULT_CODEX_APPROVAL_POLICY;
  return {
    sandboxMode,
    approvalPolicy,
    bypassedApprovalsAndSandbox: sandboxMode === "danger-full-access",
    model: normalizeOptionalText(contract.model),
    reasoning: normalizeOptionalText(contract.reasoning),
  };
}

function normalizeCodexSandboxMode(value: unknown): WorkerNodeCodexSandboxMode | null {
  const normalized = normalizeOptionalText(value);
  return normalized && CODEX_SANDBOX_MODES.has(normalized as WorkerNodeCodexSandboxMode)
    ? normalized as WorkerNodeCodexSandboxMode
    : null;
}

function normalizeCodexApprovalPolicy(value: unknown): WorkerNodeCodexApprovalPolicy | null {
  const normalized = normalizeOptionalText(value);
  return normalized && CODEX_APPROVAL_POLICIES.has(normalized as WorkerNodeCodexApprovalPolicy)
    ? normalized as WorkerNodeCodexApprovalPolicy
    : null;
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

function selectMeaningfulCommandFailureLine(value: string) {
  const meaningful = value
    .split(/\r?\n/)
    .map((line) => normalizeOptionalText(line))
    .filter((line): line is string => Boolean(line))
    .find((line) => !isCommandFailureNoiseLine(line));
  return meaningful ?? firstNonEmptyLine(value);
}

function isCommandFailureNoiseLine(line: string) {
  if (line === "Reading additional input from stdin...") {
    return true;
  }

  if (line.startsWith("OpenAI Codex ")) {
    return true;
  }

  if (line === "--------") {
    return true;
  }

  return /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(line);
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCodexCommand(workingDirectory: string, env: NodeJS.ProcessEnv) {
  const explicitCommand = normalizeOptionalText(env.THEMIS_WORKER_CODEX_BIN);
  const candidates = [
    explicitCommand,
    resolve(workingDirectory, "node_modules/.bin/codex"),
    resolve(workingDirectory, "../themis-prod/node_modules/.bin/codex"),
    resolve(workingDirectory, "../themis/node_modules/.bin/codex"),
    resolve(workingDirectory, "../themis-main/node_modules/.bin/codex"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return explicitCommand ?? "codex";
}

function resolveCodexCommandTimeoutMs(env: NodeJS.ProcessEnv) {
  const raw = normalizeOptionalText(env.THEMIS_WORKER_CODEX_EXEC_TIMEOUT_MS);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CODEX_COMMAND_TIMEOUT_MS;
}
