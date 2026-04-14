import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkerNodeExecutor } from "./worker-node-daemon.js";
import { WorkerNodeExecutionError } from "./worker-node-daemon.js";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;
const MAX_WORKSPACE_SAMPLE_ENTRIES = 20;
const MAX_GIT_STATUS_LINES = 20;

export interface WorkerNodeLocalExecutorCommandInput {
  cwd: string;
  timeoutMs: number;
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
  now?: () => string;
  commandRunner?: WorkerNodeLocalExecutorCommandRunner;
}

export function createLocalWorkerExecutor(options: CreateLocalWorkerExecutorOptions): WorkerNodeExecutor {
  const workingDirectory = resolve(options.workingDirectory);
  const reportRootDirectory = resolve(
    workingDirectory,
    options.reportRootDirectory ?? "infra/local/worker-runs",
  );
  const now = options.now ?? (() => new Date().toISOString());
  const commandRunner = options.commandRunner ?? runLocalCommand;

  return {
    async execute({ assignedRun }) {
      const startedAt = now();
      const workspacePath = resolveWorkspacePath(
        assignedRun.executionContract.workspacePath ?? workingDirectory,
      );
      const workspace = readWorkspaceSummary(workspacePath);
      const git = await readWorkspaceGitSummary(commandRunner, workspacePath);
      const completedAt = now();
      const reportFile = writeExecutionReport({
        reportRootDirectory,
        assignedRun,
        workspacePath,
        workspaceEntryCount: workspace.entryCount,
        workspaceSampleEntries: workspace.sampleEntries,
        git,
        startedAt,
        completedAt,
      });

      return {
        kind: "completed",
        summary: `Worker Node 已在本机完成执行：${assignedRun.workItem.goal}`,
        output: {
          reportFile,
          workspacePath,
          gitRepository: git.isRepository,
          gitBranch: git.branch,
          changedFileCount: git.changedFileCount,
        },
        structuredOutput: {
          reportFile,
          workspacePath,
          workspaceEntryCount: workspace.entryCount,
          workspaceSampleEntries: workspace.sampleEntries,
          git,
          credentialId: assignedRun.executionContract.credentialId ?? null,
          provider: assignedRun.executionContract.provider ?? null,
          model: assignedRun.executionContract.model ?? null,
        },
        touchedFiles: [reportFile],
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
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
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
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      },
    );
    const status = await commandRunner(
      "git",
      ["status", "--short"],
      {
        cwd: workspacePath,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
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

function writeExecutionReport(input: {
  reportRootDirectory: string;
  assignedRun: Parameters<WorkerNodeExecutor["execute"]>[0]["assignedRun"];
  workspacePath: string;
  workspaceEntryCount: number;
  workspaceSampleEntries: string[];
  git: {
    isRepository: boolean;
    branch: string | null;
    changedFileCount: number;
    statusLines: string[];
    message: string | null;
  };
  startedAt: string;
  completedAt: string;
}) {
  const reportDirectory = join(input.reportRootDirectory, input.assignedRun.run.runId);
  const reportFile = join(reportDirectory, "report.json");
  mkdirSync(reportDirectory, { recursive: true });
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
    workspace: {
      path: input.workspacePath,
      entryCount: input.workspaceEntryCount,
      sampleEntries: input.workspaceSampleEntries,
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
  });

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
