# ZenithJoy Canvas 发布说明同步

每个产品版本在此目录维护 `vX.Y.Z.md`。CI 校验 `canvasRelease.ts` 中的版本有对应的说明。同步首次见到线上版本时建档，后续只更新环境状态、切换时间和发布运行链接。Notion 的人工正文保留。

Mac Studio 每五分钟运行 `syncCanvasRelease.py`。它以两站的线上身份和 Canvas delivery 主机回执为准。香港已切换但完整验收失败时写入「完整验收未通过」。杭州只有当前构建拿到匹配的完整回执时写入「已上线」。

运行时传入 `--repo`、`--data-source` 和 `--token-file`。凭据文件须仅供运行用户读取。主机连接复用已有的 `hk-vps`、`aliyun-cn-public` SSH 配置。Notion 凭据不参与 GitHub Actions 构建或应用发布。
