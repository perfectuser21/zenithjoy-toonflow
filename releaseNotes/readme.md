# ZenithJoy Canvas 发布说明

每个产品版本在这里维护 `vX.Y.Z.md`。CI 校验 `canvasRelease.ts` 里的版本有对应说明。

在 GitHub Actions 的 `Canvas delivery` 运行里查看 `Sync Notion release notes`。香港验收或杭州发布结束后，它读取该站结果及回执，按产品和版本建档。已有条目更新该站状态和运行链接，正文保留。失去验收回执、同步错误和应用发布结果各自显示在原运行记录里。杭州晋级继续以香港部署任务和通过验收的回执为准。

仅补同步时，运行 `Canvas delivery`，在 `notes_run` 填原运行编号。这个入口跳过镜像构建、发布和验收。补同步读取原运行的保留凭证，已被较新发布运行更新过的记录沿用较新结果。

GitHub 的 `release-notes` 环境只允许受保护的 `master` 分支使用专用 SSH 密钥。香港主机上的 `canvas-notes` 用户仅可通过该密钥运行固定同步命令。Notion 的凭据和库配置保存在该主机受限配置里。脚本更新时，由运维把已合并的 `syncCanvasRelease.py` 安装到 `/opt/aivideo/release-notes/`。
