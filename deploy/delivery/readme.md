# 画布发布链（接入中，尚未启用）

目标：Mac 研发 → PR CI → master 构建不可变镜像 → 香港唯一 staging → 同一镜像杭州唯一 production。

当前交付的是编排入口，**不是已经可运行的完整发布系统**。`CANVAS_DELIVERY_ENABLED` 默认不存在，因此自动发布不启动。只有下列主机接入及真实演练通过后才能设为 `true`。不能通过人工写入 passed 回执启用。

## 已实现的仓库入口

- `serverBuild.yml`：画布网页、所有应用、插件、依赖锁、Dockerfile 和发布入口变更触发现有完整构建，包含前端；超时 30 分钟。
- `candidateImage.yml`：保留手动构建，同时允许 delivery 调用并返回 GHCR 不可变 digest。
- `canvasDelivery.yml`：master 自动触发；同一发布锁串行、进行中的发布不取消；staging 成功后 production 才能启动；生产不重新构建镜像。
- `remoteRelease.sh`：固定 SSH 主机密钥、专用 SSH 身份、请求经 stdin；校验当前 run/attempt、源码 SHA、镜像 digest、实际运行镜像及业务验收回执；生产额外要求备份、恢复、前驱与备份编号。缺项、SSH 断线、未知结果均失败。

## 尚未实现、禁止假定存在的主机能力

两地主机目前均缺少 `/usr/local/sbin/aivideo-release`。本目录现在包含控制器 `releaseHost.py`、完整卷备份 `backupVolume.py`、容器切换 `switchContainer.py` 的待审实现，尚未安装或演练；语法检查不能代替运行验收。

该程序必须由 root 安装并保持不可被发布账号修改，专用 SSH key 通过 forced-command 仅调用它，禁止任意 shell、端口转发和 PTY。执行器须独立校验机器环境、源码标签、digest、香港验收来源与生产前驱。不能信任请求中的 passed 字段。

香港：只替换当前 staging 的镜像，保留独立配额卷、权限、端口与配额 helper。不得连接杭州生产凭据或启动未经核验的 worker 恢复逻辑。

杭州：目前 systemd 启动预建容器，必须先实现保留原容器配置与镜像的事务切换；停止写入后完整备份工作区、数据库及项目配额登记和扩展属性，在隔离环境完成恢复验证；切换后做真实业务读回。失败须区分尚未切换与已产生新写入，禁止盲目还原覆盖用户新数据。镜像已拉取不等于发布成功。

## 主机执行器接入

由运维在独立审查和香港演练通过后安装到 `/opt/aivideo/delivery/`，文件及父目录 root 所有、不可由发布账号写入。`/usr/local/sbin/aivideo-release` 必须是固定 root wrapper，清空不必要环境后执行 `releaseHost.py`，不接受任意 shell 命令。

`/etc/aivideo/release.json` 的路径字段均为 root 维护的固定绝对路径：

| 字段 | 用途 |
| --- | --- |
| environment | staging 或 production，绑定本机 |
| stateDirectory | root 私有事务目录，内有 identity.json 的 environment |
| container / service / quotaService | 当前应用容器、应用 unit、配额 helper unit |
| dataDirectory / volumeImage | 挂载点及其 loop ext4 原始镜像；备份时核对二者关系 |
| backupDirectory | root 私有备份目录，禁止发布账号写入 |
| quotaHelper / quotaHelperSha256 | 固定配额 helper 及审定哈希 |
| backupCommand / switchCommand | 审定安装的上述两个程序 |
| readinessCommand | 发布前实际检查程序；尚待实现 |
| restoreVerifier | 完整卷的独立可写副本配额恢复验收程序；尚待实现 |
| requiredBackupPaths / minimumBackupDatabases | 必需数据路径与最少数据库数；备份缺项拒绝 |
| businessVerifier | 固定真实业务验收程序；尚待实现 |
| stagingWitness | 生产独立取回香港可信验收的程序；尚待实现 |
| containerCreateArgs | root 固定的容器配置，不接受来自 CI 的挂载或权限参数 |

控制器支持请求附带 `operation=preflight`，仅验证配置与当前环境，不拉镜像、不停机、不切换；生产仍必须取回香港可信回执。`operation=deploy` 先拉固定镜像、核对源码标签并执行准入，再创建持久事务记录。出现任何未完成事务，后续请求拒绝自动重试；必须先读回事实处置。

备份成功后保持原应用与配额 helper 停止，直到固定切换器启动新版，避免备份后出现遗漏新写入的窗口。失败先解冻并取消独立定时兜底，再恢复原服务；解冻失败保持服务停止。

备份程序在停写前要求足够的完整逻辑卷空间：源卷大小 + 1GiB 余量。当前香港根分区剩余约3.6GiB，3GiB staging 卷不满足此条件，必须先确定独立备份落点或可核对的空间方案；不能跳过空间检查。杭州 8GiB 卷剩余约15GiB，容量初步足够，尚未实际停写备份。

当前香港 systemd 使用 `docker run --rm`，容器切换器会拒绝；需先演练转成 `docker start -a` 的固定容器管理方式。杭州已使用后一种方式。两地配额 helper 哈希不同，不得用同镜像发布暗中覆盖 helper。

程序未包含自动数据回滚。切换后应用可能已迁移数据库或产生新写入，失败保留事务、前驱容器和完整备份，不盲目用旧镜像或备份覆盖。

## GitHub 接入

创建 `staging` 与 `production` environments，每个分别配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| variable | CANVAS_RELEASE_HOST | 对应环境可由 GitHub runner 访问的 SSH 域名/IP |
| variable | CANVAS_RELEASE_USER | 仅能调用执行器的专用发布账号 |
| secret | CANVAS_RELEASE_SSH_KEY | 从 1Password 管理的专用私钥 |
| secret | CANVAS_RELEASE_KNOWN_HOSTS | 独立核实的 SSH host key；禁止运行时 ssh-keyscan 信任 |

主机拉取私有 GHCR 镜像使用其独立最小读取权限凭据，不接收工作流命令行传入的仓库 token。GitHub 环境权限与发布者范围配置完成后才启用仓库变量 `CANVAS_DELIVERY_ENABLED=true`。

## 执行器请求与回执

请求：`environment/sourceSha/image/runId/runAttempt`；production 另带当前同一 run 的 `stagingReceipt`。所有字段按严格白名单验证，禁止将请求拼接成 shell 命令。

成功回执必须返回匹配的上述五个身份字段，及 `result="passed"`、`businessVerified=true`、`runningImage`（完整 digest）。生产额外返回 `backupVerified=true`、`restoreVerified=true`、`predecessorImage`、`backupId`。不得包含令牌、密码、供应商签名链接或用户内容。SSH 控制器只把该 JSON 写入 stdout，诊断输出放 stderr 且脱敏。

真实验收至少包括普通账号登录、保存画布、刷新后读回、跨账号隔离、视频截取结果的时长与持久化，以及本次改动影响的生成任务。HTTP 200 或容器健康不能取代业务验收。目前香港普通账号画布刷新通过，但安全截取能力仍返回 403，所以目前不具备生产晋级条件。

## 收口条件

1. 两地主机执行器及专用 SSH 身份已实现并独立审查。
2. 私有镜像传输在实际链路通过。
3. 香港完成本候选的业务验收。
4. 杭州真实数据完整备份、隔离恢复、切换与回退演练有可核验回执。
5. workflow 真实跑通，读回两地同一 digest。
6. 旧香港用户数据核对迁移完成后另行关闭旧站；发布 workflow 不删除旧站或用户内容。
