#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { WorkerNodeDiagnosticsService } from "../diagnostics/worker-node-diagnostics.js";
import { PlatformWorkerClient } from "../platform/platform-worker-client.js";
import { WorkerNodeDaemon, type WorkerNodeExecutor } from "../worker/worker-node-daemon.js";
import { createLocalWorkerExecutor } from "../worker/worker-node-local-executor.js";

export interface RunWorkerNodeCliOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetchImpl?: typeof fetch;
  executor?: WorkerNodeExecutor;
  signal?: AbortSignal;
  workingDirectory?: string;
  reportRootDirectory?: string;
}

export async function runWorkerNodeCli(
  argv: string[],
  options: RunWorkerNodeCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const parsed = parseCliArgs(argv);
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1] ?? "";

  if (command === "help" || command === "--help" || command === "-h") {
    writeHelp(stdout);
    return 0;
  }

  if (command !== "worker-node" || subcommand !== "run") {
    if (command === "doctor" && subcommand === "worker-node") {
      await handleDoctorWorkerNode(parsed, stdout, workingDirectory);
      return 0;
    }

    stderr.write(`不支持的命令：${argv.join(" ") || "(empty)"}\n`);
    writeHelp(stderr);
    return 1;
  }

  const platform = readRequiredOption(parsed.options, "--platform");
  const ownerPrincipalId = readRequiredOption(parsed.options, "--owner-principal");
  const token = readRequiredOption(parsed.options, "--token");
  const displayName = readRequiredOption(parsed.options, "--name");
  const slotCapacity = readPositiveIntegerOption(parsed.options, "--slot-capacity") ?? 1;
  const slotAvailable = readPositiveIntegerOption(parsed.options, "--slot-available") ?? slotCapacity;
  const client = new PlatformWorkerClient({
    baseUrl: platform,
    ownerPrincipalId,
    webAccessToken: token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const daemon = new WorkerNodeDaemon({
    client,
    executor: options.executor ?? createLocalWorkerExecutor({
      workingDirectory,
      reportRootDirectory: readOptionalText(parsed.options, "--report-root") ?? options.reportRootDirectory ?? undefined,
    }),
    node: {
      ...(readOptionalText(parsed.options, "--node-id") ? { nodeId: readOptionalText(parsed.options, "--node-id") ?? undefined } : {}),
      ...(readOptionalText(parsed.options, "--organization") ? { organizationId: readOptionalText(parsed.options, "--organization") ?? undefined } : {}),
      displayName,
      slotCapacity,
      slotAvailable,
      ...(readOptionalList(parsed.options, "--label").length > 0 ? { labels: readOptionalList(parsed.options, "--label") } : {}),
      ...(readOptionalList(parsed.options, "--workspace").length > 0 ? { workspaceCapabilities: readOptionalList(parsed.options, "--workspace") } : {}),
      ...(readOptionalList(parsed.options, "--credential").length > 0 ? { credentialCapabilities: readOptionalList(parsed.options, "--credential") } : {}),
      ...(readOptionalList(parsed.options, "--provider").length > 0 ? { providerCapabilities: readOptionalList(parsed.options, "--provider") } : {}),
      ...(readPositiveIntegerOption(parsed.options, "--heartbeat-ttl-seconds")
        ? { heartbeatTtlSeconds: readPositiveIntegerOption(parsed.options, "--heartbeat-ttl-seconds") ?? undefined }
        : {}),
    },
    ...(readPositiveIntegerOption(parsed.options, "--poll-interval-ms")
      ? { pollIntervalMs: readPositiveIntegerOption(parsed.options, "--poll-interval-ms") ?? undefined }
      : {}),
    log: (message) => {
      stdout.write(`${message}\n`);
    },
  });

  if (parsed.flags.has("--once")) {
    const result = await daemon.runOnce();
    stdout.write(`Worker Node：${result.nodeId}\n`);
    stdout.write(`执行结果：${result.result}\n`);
    if (result.summary) {
      stdout.write(`执行摘要：${result.summary}\n`);
    }
    if (result.reportFile) {
      stdout.write(`报告文件：${result.reportFile}\n`);
    }
    return 0;
  }

  stdout.write(`Worker Node 常驻启动：${displayName}\n`);
  await daemon.runLoop(options.signal);
  stdout.write("Worker Node 已停止。\n");
  return 0;
}

function writeHelp(output: NodeJS.WriteStream) {
  output.write("Themis Worker Node CLI\n");
  output.write("用法：\n");
  output.write("  themis-worker-node help\n");
  output.write("  themis-worker-node doctor worker-node --platform <baseUrl> --owner-principal <principalId> --token <platformToken> --workspace <absolutePath>\n");
  output.write("  themis-worker-node worker-node run --platform <baseUrl> --owner-principal <principalId> --token <platformToken> --name <displayName> [--report-root <path>] [--once]\n");
  output.write("当前已迁入最小 daemon 闭环、doctor worker-node 预检，以及会生成本地 report 的执行器；更完整 runtime 执行链会在后续顺序任务继续补入。\n");
}

function parseCliArgs(argv: string[]) {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      flags.add(token);
      continue;
    }

    const existing = options.get(token) ?? [];
    existing.push(next);
    options.set(token, existing);
    index += 1;
  }

  return {
    positionals,
    options,
    flags,
  };
}

function readRequiredOption(options: Map<string, string[]>, name: string) {
  const value = readOptionalText(options, name);

  if (!value) {
    throw new Error(`缺少必填参数：${name}`);
  }

  return value;
}

function readOptionalText(options: Map<string, string[]>, name: string) {
  const value = options.get(name)?.at(-1);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptionalList(options: Map<string, string[]>, name: string) {
  return (options.get(name) ?? [])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveIntegerOption(options: Map<string, string[]>, name: string) {
  const value = readOptionalText(options, name);

  if (!value) {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isDirectExecution() {
  return typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function handleDoctorWorkerNode(
  parsed: ReturnType<typeof parseCliArgs>,
  stdout: NodeJS.WriteStream,
  workingDirectory: string,
) {
  const workspaceCapabilities = readOptionalList(parsed.options, "--workspace");
  const credentialCapabilities = readOptionalList(parsed.options, "--credential");
  const providerCapabilities = readOptionalList(parsed.options, "--provider");
  const diagnostics = new WorkerNodeDiagnosticsService({
    workingDirectory,
  });
  const summary = await diagnostics.readSummary({
    workspaceCapabilities: workspaceCapabilities.length > 0 ? workspaceCapabilities : [workingDirectory],
    credentialCapabilities,
    providerCapabilities,
    platformBaseUrl: readOptionalText(parsed.options, "--platform"),
    ownerPrincipalId: readOptionalText(parsed.options, "--owner-principal"),
    webAccessToken: readOptionalText(parsed.options, "--token"),
  });

  stdout.write("Themis 诊断 - worker-node\n");
  stdout.write(`workspaceCount：${summary.workspaces.length}\n`);
  for (const workspace of summary.workspaces) {
    stdout.write(`workspace[${workspace.inputPath}]：${workspace.status}\n`);
    if (workspace.inputPath !== workspace.resolvedPath) {
      stdout.write(`  resolvedPath：${workspace.resolvedPath}\n`);
    }
  }
  stdout.write(`credentialCount：${summary.credentials.length}\n`);
  if (summary.credentials.length === 0) {
    stdout.write("credential：<none>\n");
  } else {
    for (const credential of summary.credentials) {
      stdout.write(`credential[${credential.credentialId}]：${credential.status} (codexHome=${credential.codexHome})\n`);
    }
  }
  stdout.write(`providerCount：${summary.providers.length}\n`);
  if (summary.providers.length === 0) {
    stdout.write("provider：<none>\n");
  } else {
    for (const provider of summary.providers) {
      stdout.write(`provider[${provider.providerId}]：${provider.status}${provider.source ? ` (source=${provider.source}, defaultModel=${provider.defaultModel ?? "<none>"})` : ""}\n`);
      if (provider.message) {
        stdout.write(`  message：${provider.message}\n`);
      }
    }
  }
  stdout.write(`codex.status：${summary.codex.status}\n`);
  stdout.write(`codex.command：${summary.codex.command}\n`);
  stdout.write(`codex.source：${summary.codex.source}\n`);
  stdout.write(`codex.message：${summary.codex.message ?? "<none>"}\n`);
  stdout.write(`platform.status：${summary.platform.status}\n`);
  stdout.write(`platform.baseUrl：${summary.platform.baseUrl ?? "<none>"}\n`);
  stdout.write(`platform.nodeCount：${summary.platform.nodeCount ?? "<none>"}\n`);
  stdout.write(`platform.message：${summary.platform.message ?? "<none>"}\n`);
  stdout.write("问题判断\n");
  stdout.write(`主诊断：${summary.primaryDiagnosis.title}\n`);
  stdout.write(`诊断摘要：${summary.primaryDiagnosis.summary}\n`);
  stdout.write("建议动作：\n");
  for (const [index, step] of summary.recommendedNextSteps.entries()) {
    stdout.write(`${index + 1}. ${step}\n`);
  }
}

if (isDirectExecution()) {
  void runWorkerNodeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
