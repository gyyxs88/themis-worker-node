#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { PlatformWorkerClient } from "../platform/platform-worker-client.js";
import { createEchoWorkerExecutor, WorkerNodeDaemon, type WorkerNodeExecutor } from "../worker/worker-node-daemon.js";

export interface RunWorkerNodeCliOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetchImpl?: typeof fetch;
  executor?: WorkerNodeExecutor;
  signal?: AbortSignal;
}

export async function runWorkerNodeCli(
  argv: string[],
  options: RunWorkerNodeCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseCliArgs(argv);
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1] ?? "";

  if (command === "help" || command === "--help" || command === "-h") {
    writeHelp(stdout);
    return 0;
  }

  if (command !== "worker-node" || subcommand !== "run") {
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
    executor: options.executor ?? createEchoWorkerExecutor(),
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
  output.write("  themis-worker-node worker-node run --platform <baseUrl> --owner-principal <principalId> --token <platformToken> --name <displayName> [--once]\n");
  output.write("当前这一刀已迁入最小 daemon 常驻闭环；doctor worker-node 将在下一顺序任务继续补入。\n");
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

if (isDirectExecution()) {
  void runWorkerNodeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
