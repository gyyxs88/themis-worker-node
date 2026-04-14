# themis-worker-node 常驻部署说明

## 目标

把 `themis-worker-node` 作为长期运行的局域网执行节点挂到 `systemd --user` 下常驻运行。

这条链路只负责：

- `register -> heartbeat -> pull -> execute -> report`
- 本机 `workspace / credential / provider` 预检
- 本地 `report.json`、`runtime-context.json` 产出与平台回传

## 模板位置

仓库内可直接修改的模板：

```text
infra/systemd/themis-worker-node.service.example
```

模板默认已经带上：

- 稳定 `node-id`
- 默认工作区
- 默认 `credential`
- `THEMIS_WORKER_REPORT_ROOT`

## 推荐顺序

1. 获取节点代码并安装依赖：

```bash
mkdir -p ~/services
git clone git@github.com:gyyxs88/themis-worker-node.git ~/services/themis-worker-node
cd ~/services/themis-worker-node
npm ci
npm run build
```

2. 先跑启动前预检：

```bash
./themis-worker-node doctor worker-node \
  --platform http://192.168.31.208:3100 \
  --owner-principal principal-owner \
  --token <platformToken> \
  --workspace /home/you/services/themis-worker-node \
  --credential default
```

3. 再跑一次单次执行，确认节点能注册、心跳并落本地 report：

```bash
./themis-worker-node worker-node run \
  --platform http://192.168.31.208:3100 \
  --owner-principal principal-owner \
  --token <platformToken> \
  --name worker-node-a \
  --node-id node-worker-a \
  --workspace /home/you/services/themis-worker-node \
  --credential default \
  --report-root /home/you/services/themis-worker-node/infra/local/worker-runs \
  --once
```

4. 安装并启用 `systemd --user`：

```bash
mkdir -p ~/.config/systemd/user
cp ~/services/themis-worker-node/infra/systemd/themis-worker-node.service.example \
  ~/.config/systemd/user/themis-worker-node.service
systemctl --user daemon-reload
systemctl --user enable --now themis-worker-node.service
```

5. 常驻后做两轮确认：

```bash
systemctl --user status themis-worker-node.service
journalctl --user -u themis-worker-node.service -f
./themis-platform doctor worker-fleet --platform http://192.168.31.208:3100 --owner-principal principal-owner --token <platformToken>
```

## 常见约束

- `--node-id` 最好固定；否则每次重启都会注册成新的 node 记录。
- `--credential` 不是纯标签，目标 `CODEX_HOME` 或 `infra/local/codex-auth/<id>` 下必须真的有 `auth.json`。
- `--report-root` 建议显式落到节点目录自己的 `infra/local/worker-runs`，不要散落到别的工作区里。
- 每个 run 还会在 `infra/local/worker-runtime/<runId>/` 下落一份 `runtime-context.json`，以及按需复制的 `codex-home/auth.json` / `provider.json`。
- 节点只负责本机执行和 report，不负责平台值班；`drain|offline|reclaim` 统一从 `themis-platform` 执行。
