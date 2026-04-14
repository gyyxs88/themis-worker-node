# themis-worker-node

这是由 `scripts/bootstrap-split-repos.sh` 初始化出来的拆仓仓库。

负责 Worker Node 本机预检、常驻执行、工作区与 credential 能力声明。

- 当前入口：`src/cli/worker-node-main.ts`
- 当前状态：已落入最小 Worker daemon 骨架、平台 worker client、`worker-node run` CLI 与 `doctor worker-node` 预检，并开始通过 `file:../themis-contracts` 依赖消费共享节点协议契约
- 迁移依据：请对照 `themis` 主仓里的 `docs/repository/themis-three-layer-split-migration-checklist.md`

当前最小能力：

- `src/platform/platform-worker-access.ts` 已按共享契约装配 `nodes/register|heartbeat|list` 与 `worker/runs/pull|update|complete` 平台请求
- `src/platform/platform-worker-client.ts` 已提供最小平台 worker client
- `src/worker/worker-node-daemon.ts` 已提供 `register -> heartbeat -> pull -> execute -> report` 最小 daemon 闭环
- `src/diagnostics/worker-node-diagnostics.ts` 已提供本地 `workspace / credential / provider` 与平台可达性预检
- `src/cli/worker-node-main.ts` 已提供 `help`、`doctor worker-node` 与 `worker-node run --once` 最小 CLI

当前验证：

- `npm run test`
- `npm run typecheck`
- `npm run build`

当前下一顺序任务：

- 把当前 echo executor 继续换成真实本机执行链
- 细化 `execute -> report` 的本地产物与回传摘要
