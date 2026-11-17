# 画布发布链（接入中，尚未启用）

目标：Mac 研发 → PR CI → master 构建不可变镜像 → 香港唯一 staging → 同一镜像杭州唯一 production。

固定员工入口为香港 `https://toonflow.zenjoymedia.media`，正式入口为杭州 `https://aivideo.zenithjoy.tech`。隔离的c001回环实例不代表员工入口验收通过。配置及发布回执必须包含匹配的publicOrigin；真实业务验收器须验证该公网入口对应本候选。

同一发布版本不意味着两个环境共享数据库或素材。staging和production数据保持隔离；员工在旧香港站积累的业务内容需要单独核对迁移，发布流程不默认复制、覆盖或删除它们。员工香港站目前是systemd直接启动Bun，且数据仍是普通目录；本目录当前的容器/独立ext4配额卷执行器不能直接部署到员工站。要先完成保留数据的迁移演练及入口切换，再接入CD。

当前交付包括编排和主机执行器代码，**尚未完成员工入口切换及真实发布验收**。仓库变量 `CANVAS_DELIVERY_ENABLED=false`，因此自动发布不启动。只有下列主机接入及真实演练通过后才能设为 `true`。不能通过人工写入 passed 回执启用。

## 已实现的仓库入口

- `serverBuild.yml`：画布网页、所有应用、插件、依赖锁、Dockerfile 和发布入口变更触发现有完整构建，包含前端；超时 30 分钟。
- `candidateImage.yml`：保留手动构建，同时允许 delivery 调用并返回 GHCR 不可变 digest。
- `canvasDelivery.yml`：master 自动触发；同一发布锁串行、进行中的发布不取消；staging 成功后 production 才能启动；生产不重新构建镜像。
- `remoteRelease.sh`：固定 SSH 主机密钥、专用 SSH 身份、请求经 stdin；校验当前 run/attempt、源码 SHA、镜像 digest、实际运行镜像及业务验收回执；生产额外要求备份、恢复、前驱与备份编号。缺项、SSH 断线、未知结果均失败。

镜像传输失败时保留本次已接收 OCI 和 root 私有阶段诊断；启动时遇到已有 `imageTransfer*` 临时目录即拒绝新传输，由运维先读回身份、空间和事务后处理，不能自动删除未知结果。启动时保留至少两个归档上限加 1 GiB 空间；最终归档与加载后读回归档各有独立上限。归档验证后通过 Docker Engine `image load` 加载，与此前人工 898 导入使用的入口一致，再完整导出读回验证；这不说明之前失败的根因已确定。本机缓存导出或校验失败只是缓存未命中，其不完整缓存文件会删除；随后从香港接收的归档失败时保留。短期 registry 凭据单独放 `/run` 的 root 私有 tmpfs，异常终止可能残留至重启，不放入保留诊断目录。香港见证 stdout 保持原 OCI 直通，源端日志不推测字节数。

## 尚未实现、禁止假定存在的主机能力

两地主机目前均缺少 `/usr/local/sbin/aivideo-release`。本目录现在包含控制器 `releaseHost.py`、完整卷备份 `backupVolume.py`、容器切换 `switchContainer.py`、配额恢复 `restoreVolume.py` 和准入检查 `releaseReadiness.py` 的实现，尚未安装或演练；语法检查不能代替运行验收。

该程序必须由 root 安装并保持不可被发布账号修改，专用 SSH key 通过 forced-command 仅调用它，禁止任意 shell、端口转发和 PTY。执行器须独立校验机器环境、源码标签、digest、香港验收来源与生产前驱。不能信任请求中的 passed 字段。

香港：只替换当前 staging 的镜像，保留独立配额卷、权限、端口与配额 helper。不得连接杭州生产凭据或启动未经核验的 worker 恢复逻辑。

杭州：目前 systemd 启动预建容器，必须先实现保留原容器配置与镜像的事务切换；停止写入后完整备份工作区、数据库及项目配额登记和扩展属性，在隔离环境完成恢复验证；切换后做真实业务读回。失败须区分尚未切换与已产生新写入，禁止盲目还原覆盖用户新数据。镜像已拉取不等于发布成功。

## 主机执行器接入

由运维在独立审查和香港演练通过后安装到 `/opt/aivideo/delivery/`，文件及父目录 root 所有、不可由发布账号写入。`/usr/local/sbin/aivideo-release` 必须是固定 root wrapper，清空不必要环境后执行 `releaseHost.py`，不接受任意 shell 命令。

`/etc/aivideo/release.json` 的路径字段均为 root 维护的固定绝对路径：

| 字段 | 用途 |
| --- | --- |
| publicOrigin | 员工staging或production的固定公网入口 |
| environment | staging 或 production，绑定本机 |
| stateDirectory | root 私有事务目录，内有 identity.json 的 environment |
| container / service / quotaService | 当前应用容器、应用 unit、配额 helper unit |
| dataDirectory / volumeImage | 挂载点及其 loop ext4 原始镜像；备份时核对二者关系 |
| backupDirectory | root 私有备份目录，禁止发布账号写入 |
| backupCapsuleBytes | root显式配置的备份胶囊硬容量，256MiB至64GiB；实分配后仍留宿主1GiB |
| quotaHelper / quotaHelperSha256 | 固定配额 helper 及审定哈希 |
| backupCommand / switchCommand | 审定安装的上述两个程序 |
| readinessCommand | 安装 releaseReadiness.py：只读核对服务、挂载、空间和所需验收入口 |
| restoreVerifier | 安装 restoreVolume.py：克隆卷配额与降权EDQUOT验收 |
| requiredBackupPaths / minimumBackupDatabases | 必需数据路径与最少数据库数；备份缺项拒绝 |
| businessVerifier | verifyBusiness.py：真实公网与本机版本一致、保存读回、截取、生成；尚未安装运行 |
| businessConfig | root 私有业务验收配置；专用验收画布需 deliveryAcceptance 标记 |
| applicationDataDirectory / containerDataDirectory | 可选的卷内应用目录及容器挂载目标，迁移员工站时保留原绝对路径 |
| stagingWitness | 安装 stagingWitness.py，生产独立取回香港可信验收；主机尚未配置 |
| expectedQuotaKiB / expectedQuotaInodes | 本次配置的已审定限额，当前账号为5242880KiB与100000个inode |
| serviceUid / serviceGid | 恢复副本上非特权配额探针的UID/GID，必须大于零 |
| containerCreateArgs | root 固定的容器配置，不接受来自 CI 的挂载或权限参数 |

控制器支持请求附带 `operation=preflight`，仅验证配置与当前环境，不拉镜像、不停机、不切换；生产仍必须取回香港可信回执。`operation=deploy` 先拉固定镜像、核对源码标签并执行准入，再创建持久事务记录。出现任何未完成事务，后续请求拒绝自动重试；必须先读回事实处置。

备份成功后保持原应用与配额 helper 停止，直到固定切换器启动新版，避免备份后出现遗漏新写入的窗口。失败先解冻并取消独立定时兜底，再恢复原服务；解冻失败保持服务停止。

备份采用root显式配置的 `backupCapsuleBytes` 硬容量胶囊：宿主ext4/4KiB块上先完整预分配，并在nodiscard格式化后再次预分配、fsync和核对；宿主保留至少1GiB。原始卷完整扫描只用于估算，最终冻结后重新扫描；稀疏快照保留全部非零块并完整cmp，实际可写配额恢复只在胶囊内部执行。胶囊满额即失败，不依赖压缩率或文件系统元数据常数推断空间安全。恢复结束后卸载胶囊，零洞压缩前后SHA相等，再持久化回执。备份目录必须与冻结数据卷处于不同文件系统。看门狗不依赖标记成功才解冻；手动解冻前保持兜底，解冻后撤销timer/service并核对触发标记，触发过一律不接受快照。此方案尚未实机演练，不代表现役备份通过。

香港隔离c001实例的systemd使用 `docker run --rm`；员工站则是直接启动Bun。两者均不满足容器切换器要求，不能混作同一staging。需先完成员工站的数据保留和固定容器启动演练。杭州已使用 `docker start -a`。两地配额 helper 哈希不同，不得用同镜像发布暗中覆盖 helper。

程序未包含自动数据回滚。切换后应用可能已迁移数据库或产生新写入，失败保留事务、前驱容器和完整备份，不盲目用旧镜像或备份覆盖。

## GitHub 接入

创建 `staging` 与 `production` environments，每个分别配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| variable | CANVAS_RELEASE_HOST | 对应环境可由 GitHub runner 访问的 SSH 域名/IP |
| variable | CANVAS_RELEASE_PORT | 香港现有公网6443，杭州22 |
| variable | CANVAS_RELEASE_USER | 仅能调用执行器的专用发布账号 |
| secret | CANVAS_RELEASE_SSH_KEY | 从 1Password 管理的专用私钥 |
| secret | CANVAS_RELEASE_KNOWN_HOSTS | 独立核实的 SSH host key；禁止运行时 ssh-keyscan 信任 |

生产可选经香港跳板连接杭州：仅在 `production` environment 同时配置 variable `CANVAS_RELEASE_JUMP_HOST`、`CANVAS_RELEASE_JUMP_PORT`、`CANVAS_RELEASE_JUMP_USER`，以及 secret `CANVAS_RELEASE_JUMP_KEY`、`CANVAS_RELEASE_JUMP_KNOWN_HOSTS`；全部不配置时沿用直连，缺一项即失败。两个主机各自使用独立密钥和预先核实的 host key，非标准端口按 SSH known_hosts 的 `[主机]:端口` 格式登记。staging 不使用跳板。

跳板应使用独立账号及密钥，仅允许到固定杭州地址和端口的 SSH TCP 转发，禁止 shell、PTY、agent 转发及其他目标；杭州 SSH 防火墙只放行香港固定出口 IP。CI 不接受来自发布请求的跳板命令或目标，也不进行 agent 转发。网络规则、跳板与身份须由运维先行配置并验证，本文不代替实际部署验收。

主机拉取私有 GHCR 镜像使用当前 job 的短期 GITHUB_TOKEN（packages:read），经 SSH stdin 传入，仅用于私有临时 Docker 配置；不写事务日志，不保留长期 GitHub PAT。GitHub 环境权限与发布者范围配置完成后才启用仓库变量 `CANVAS_DELIVERY_ENABLED=true`。

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

## 2026-11-17 隔离恢复验收证据

在香港私有 mount namespace 中，对旧539测试环境已有的离线完整备份执行了 restoreVolume.py，不停止现役服务，不覆盖主机 /etc 配置。两个账号项目的project ID、继承属性及块/inode限额核对通过，新建独立project后普通UID写入超过1MiB被EDQUOT拒绝。源gzip解压流与验收快照SHA256一致。此次证明配额恢复环节，未证明现役c001完整备份、生产恢复或整个CD通过。具体命令及哈希记录在Brain任务a802fa98-e2a0-4169-9db6-a878e3474509。

### 只读香港见证的权限合同

生产配置 `stagingWitnessHost`、`stagingWitnessUser`、`stagingWitnessKey`、`stagingWitnessKnownHosts`；后两个必须是root保护的文件。见证key与部署key分开，从1Password管理，不复用个人SSH身份。香港见证账号的authorized_keys强制命令只能调用受限sudo的readRelease.py包装器（安装为aivideo-read-release），禁PTY、转发和任意shell。包装器只接受operation=receipt且environment=staging，不得把见证账号直接绑定到可deploy的releaseHost.py。控制器在任何回执输出前都会拒绝尚未完成的事务，即使旧回执镜像恰好仍在运行。当前只完成代码，尚未安装账号、密钥或wrapper。

## 本轮接入与验证现状

GitHub staging/production environments、仅master分支策略、各自专用SSH key和固定host key已配置。两地发布账号均只允许sudo固定发布器且禁止交互shell/转发；公网认证已实测，发布器尚未安装，因此认证成功后明确返回command not found。香港使用现有6443端口，不增加新监听；临时relay方案已撤销授权。

员工站Cloudflare Access增设独立机器验收策略，保留原人员登录策略。机器凭据仅在1Password及私有缓存；实际公网ffmpeg/status通过，媒体Range请求206且仅传回1024字节。员工数据在线兼容副本用现有c001镜像保留原路径启动，2秒截取耗时0.803秒、ffprobe读回2秒；兼容容器随后停止。在线副本不算一致性备份，未替换现役员工服务。

verifyBusiness.py在staging保留shared工作区模式，production必须验证两个普通账号隔离；均要求专用画布标记、版本/bootId一致、实际截取与生成结果。verifyGeneration.py只提交一次带固定taskId任务，后续只读轮询，未知结果不重发。新identity API声明候选版本和只读能力；旧版缺此接口时不允许付费验收。

网页媒体读取改为显式服务器能力开放时使用原受控接口的Range读取；桌面与旧服务器保留Blob读取。剪辑预览在metadata可用时初始化，避免必须等待整个视频下载。此优化尚未部署，不能据此宣称员工卡顿已修复。

### 2026-11-17 硬容量备份实机记录

新流程已在香港旧539专用卷运行：768MiB胶囊先完整预分配，原始卷3GiB；完整cmp、312个文件、8个SQLite数据库、两个项目配额和普通UID EDQUOT恢复通过。胶囊卸载后零洞压缩SHA不变，最终分配434925568字节，回执编号1794897703147183349。本次是隔离旧卷，未停员工站或杭州生产，也不代表它们已有本版本备份。Ubuntu2.37下losetup需同时指定-J与-l才输出JSON；临时systemd单元取消以LoadState和ActiveState读回，已自动卸载的inactive单元允许收尾。
