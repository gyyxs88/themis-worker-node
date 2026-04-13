# themis-worker-node

这是由 `scripts/bootstrap-split-repos.sh` 初始化出来的拆仓仓库。

负责 Worker Node 本机预检、常驻执行、工作区与 credential 能力声明。

- 当前入口：`src/cli/worker-node-main.ts`
- 当前状态：已落入最小 Worker bootstrap，并开始通过 `file:../themis-contracts` 依赖消费共享节点协议契约
- 迁移依据：请对照 `themis` 主仓里的 `docs/repository/themis-three-layer-split-migration-checklist.md`

当前最小能力：

- `src/platform/platform-worker-access.ts` 已按共享契约装配 `nodes/register|heartbeat` 平台请求
- `src/cli/worker-node-main.ts` 已明确当前 bootstrap 面向 `themis-contracts` 消费迁移

当前验证：

- `npm run test`
- `npm run typecheck`
- `npm run build`

下一步应优先迁入 worker-node daemon、`doctor worker-node` 与本机执行链。
