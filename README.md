# themis-worker-node

`themis-worker-node` 负责 Worker Node 本机预检、常驻执行、工作区与 credential 能力声明。

- 当前入口：`src/cli/worker-node-main.ts`
- 独立 CLI：仓库根目录 `./themis-worker-node`
- 当前状态：已具备 Worker daemon、平台 worker client、`doctor worker-node` 预检、真实 `codex exec` 驱动的 `worker-node run` 执行器，以及每个 run 的本地 runtime / credential / provider 装配层。

当前最小能力：

- `src/platform/platform-worker-access.ts` 已按共享契约装配 `nodes/register|heartbeat|list` 与 `worker/runs/pull|update|complete` 平台请求
- `src/platform/platform-worker-client.ts` 已提供最小平台 worker client
- `src/worker/worker-node-daemon.ts` 已提供 `register -> heartbeat -> pull -> execute -> report` 最小 daemon 闭环
- `src/worker/worker-node-local-executor.ts` 已通过真实 `codex exec` 执行任务，并产出 `prompt.txt`、`last-message.txt`、`result.json`、`deliverable.md`、`stdout.log`、`stderr.log`、`report.json`
- `src/runtime/worker-node-runtime-context.ts` 已提供每个 run 的 `runtime-context.json`、credential auth/config 复制与 provider 装配
- `src/diagnostics/worker-node-diagnostics.ts` 已提供本地 `workspace / credential / provider` 与平台可达性预检
- `src/cli/worker-node-main.ts` 已提供 `help`、`doctor worker-node`、`worker-node run --once` 与 `--report-root` 最小 CLI
- `infra/systemd/themis-worker-node.service.example` 与 `docs/worker-node-systemd-service.md` 已随仓提供节点常驻模板和部署说明

## 部署前提

- 当前仓仍通过 `file:../themis-contracts` 依赖共享契约；真实部署时需要把 `themis-contracts` 放到同级目录，再执行 `npm ci`。
- 节点常驻入口应直接使用仓库根目录 `./themis-worker-node`，不要继续借主仓 `./themis` 的兼容 Worker 命令。
- 本机运行态会写入 `infra/local/worker-runs` 与 `infra/local/worker-runtime`，这两类目录已经加入 `.gitignore`。

## 部署文档

- `docs/worker-node-systemd-service.md`
- `infra/systemd/themis-worker-node.service.example`

当前验证：

- `npm run test`
- `npm run typecheck`
- `npm run build`

当前执行与回传闭环已经具备；worker 完成时会把关键执行快照一并回传到平台 completion payload，便于管理面直接查看交付正文、结构化结果和 stdout/stderr，不再只剩远端文件路径。
