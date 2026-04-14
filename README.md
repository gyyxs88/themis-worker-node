# themis-worker-node

这是由 `scripts/bootstrap-split-repos.sh` 初始化出来的拆仓仓库。

负责 Worker Node 本机预检、常驻执行、工作区与 credential 能力声明。

- 当前入口：`src/cli/worker-node-main.ts`
- 当前状态：已落入最小 Worker daemon 骨架、平台 worker client、`worker-node run` CLI 与 `doctor worker-node` 预检，并开始通过 `file:../themis-contracts` 依赖消费共享节点协议契约
- 当前状态：已落入最小 Worker daemon、平台 worker client、`doctor worker-node` 预检、会生成本地 report 的 `worker-node run` 执行器，以及每个 run 的本地 runtime / credential / provider 装配层，并开始通过 `file:../themis-contracts` 依赖消费共享节点协议契约
- 迁移依据：请对照 `themis` 主仓里的 `docs/repository/themis-three-layer-split-migration-checklist.md`

当前最小能力：

- `src/platform/platform-worker-access.ts` 已按共享契约装配 `nodes/register|heartbeat|list` 与 `worker/runs/pull|update|complete` 平台请求
- `src/platform/platform-worker-client.ts` 已提供最小平台 worker client
- `src/worker/worker-node-daemon.ts` 已提供 `register -> heartbeat -> pull -> execute -> report` 最小 daemon 闭环
- `src/worker/worker-node-local-executor.ts` 已提供真实本机工作区检查、Git 摘要采集与 `report.json` 产出
- `src/runtime/worker-node-runtime-context.ts` 已提供每个 run 的 `runtime-context.json`、credential auth 复制与 provider 装配
- `src/diagnostics/worker-node-diagnostics.ts` 已提供本地 `workspace / credential / provider` 与平台可达性预检
- `src/cli/worker-node-main.ts` 已提供 `help`、`doctor worker-node`、`worker-node run --once` 与 `--report-root` 最小 CLI
- `infra/systemd/themis-worker-node.service.example` 与 `docs/worker-node-systemd-service.md` 已随仓提供节点常驻模板和部署说明

当前验证：

- `npm run test`
- `npm run typecheck`
- `npm run build`

当前这条拆仓顺序线已收口；后续如果继续往前推，优先补真正的 runtime 执行链，而不是再回头把 Worker 职责塞回主仓。
