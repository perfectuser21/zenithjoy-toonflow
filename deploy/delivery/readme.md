# 画布发布链（接入中，尚未启用）

目标：Mac 研发 → PR CI → master 构建不可变镜像 → 香港唯一 staging → 同一镜像杭州唯一 production。

香港 staging 的唯一公网入口是 `https://aivideo-staging.zenjoymedia.media`。杭州 production 的公网入口是 `https://aivideo.zenithjoy.tech`。按 `releasePolicy.py` 设置主机和业务验收配置的 `publicOrigin`。真实验收会核对公网与回环是否连接同一候选进程。

两地各用独立数据和 ext4 项目配额卷。旧香港员工共享站的数据另行保留并核对迁移。旧共享目录备份独立于 Canvas 发布链。香港完成所需存储、账号、裁剪服务和公网配置并通过真实演练后，才能启用 `CANVAS_DELIVERY_ENABLED`。

## 已实现的仓库入口

- `serverBuild.yml`：画布网页、所有应用、插件、依赖锁、Dockerfile 和发布入口变更触发现有完整构建，包含前端；超时 30 分钟。
- `candidateImage.yml`：保留手动构建，同时允许 delivery 调用并返回 GHCR 不可变 digest。
- `canvasDelivery.yml`：master 自动触发；同一发布锁串行、进行中的发布不取消；staging 成功后 production 才能启动；生产不重新构建镜像。
- `remoteRelease.sh`：固定 SSH 主机密钥、专用 SSH 身份、请求经 stdin；校验 run/attempt、源码 SHA、固定镜像 digest、普通账号业务验收及配额卷备份恢复。缺项、SSH 断线、未知结果均失败。

镜像传输失败时保留本次已接收 OCI 和 root 私有阶段诊断；启动时遇到已有 `imageTransfer*` 临时目录即拒绝新传输，由运维先读回身份、空间和事务后处理，不能自动删除未知结果。启动时保留至少两个归档上限加 1 GiB 空间；最终归档与加载后读回归档各有独立上限。归档验证后通过 Docker Engine `image load` 加载，与此前人工 898 导入使用的入口一致，再完整导出读回验证；这不说明之前失败的根因已确定。本机缓存导出或校验失败只是缓存未命中，其不完整缓存文件会删除；随后从 COS 接收的归档失败时保留。香港见证只提供验收回执。

## 主机接入条件

安装固定发布入口 `/usr/local/sbin/aivideo-release`。专用 SSH key 的 forced-command 仅调用该入口，禁用任意 shell、端口转发和 PTY。执行器独立核对主机环境、源码标签、镜像 digest、香港回执和前驱镜像。

香港：将 CI staging 环境指向新公网入口对应的客户服务，验收使用同一实例和同一配额卷。设定固定容器启动方式，核对持久挂载、备份容量、配额 helper 和裁剪 worker、store。提供两个不同普通账号、专用画布和截取源，以及可实际生成视频的模型配置。

杭州：演练保留原容器配置与镜像的事务切换。停止写入后完整备份工作区、数据库、项目配额登记和扩展属性，在隔离环境验证恢复。切换后核验真实业务，失败时按事务记录判断候选是否已产生新写入。

## 主机执行器接入

将本目录的主机执行器及依赖（包括 `releasePolicy.py`）配套安装到 `/opt/aivideo/delivery/`。文件及父目录必须由 root 所有，发布账号不可写。`/usr/local/sbin/aivideo-release` 必须是固定 root wrapper，清空不必要环境后执行 `releaseHost.py`，不接受任意 shell 命令。

`/etc/aivideo/release.json` 的路径字段均为 root 维护的固定绝对路径：

| 字段 | 用途 |
| --- | --- |
| publicOrigin | `releasePolicy.py` 中环境对应的固定公网入口 |
| environment | staging 或 production，绑定本机 |
| dataMode | `quotaVolume`，缺省同值 |
| stateDirectory | root 私有事务目录，内有 identity.json 的 environment |
| container / service / quotaService | 当前应用容器、应用 unit、配额 helper unit |
| dataDirectory / volumeImage | 挂载点及其 loop ext4 原始镜像；备份时核对二者关系 |
| backupDirectory | root 私有备份目录，禁止发布账号写入 |
| backupCapsuleBytes | root显式配置的备份胶囊硬容量，256MiB至64GiB；实分配后仍留宿主1GiB |
| quotaHelper / quotaHelperSha256 | 固定配额 helper 及审定哈希 |
| trimRuntimeManifest / trimArtifactDirectory | 宿主裁剪运行组件及固定哈希清单，组件须与候选一致 |
| backupCommand / switchCommand | 审定安装的上述两个程序 |
| readinessCommand | 安装 releaseReadiness.py：只读核对服务、挂载、空间和所需验收入口 |
| restoreVerifier | 安装 restoreVolume.py：克隆卷配额与降权EDQUOT验收 |
| requiredBackupPaths / minimumBackupDatabases | 必需数据路径与最少数据库数；备份缺项拒绝 |
| businessVerifier | 使用 `verifyBusiness.py`，核对候选、隔离、保存读回、裁剪和生成 |
| businessConfig | root 私有配置，使用 `businessMode=tenant`。配置两个普通账号和有 `deliveryAcceptance=true` 标记的画布，以及真实裁剪和生成参数 |
| applicationDataDirectory / containerDataDirectory | 可选的卷内应用目录及容器挂载目标，迁移员工站时保留原绝对路径 |
| stagingWitness | 使用 `stagingWitness.py`，杭州独立读取香港的可信回执 |
| expectedQuotaKiB / expectedQuotaInodes | 本次配置的已审定限额，当前账号为5242880KiB与100000个inode |
| serviceUid / serviceGid | 恢复副本上非特权配额探针的UID/GID，必须大于零 |
| containerCreateArgs | root 固定的容器配置，不接受来自 CI 的挂载或权限参数 |

控制器支持请求附带 `operation=preflight`，仅验证配置与当前环境，不拉镜像、不停机、不切换；生产仍必须取回香港可信回执。`operation=deploy` 先拉固定镜像、核对源码标签并执行准入，再创建持久事务记录。出现任何未完成事务，后续请求拒绝自动重试；必须先读回事实处置。

若香港已经切换但原验收明确失败，受限发布身份仍无权核销。运维可在目标机安装已合并的执行器后，以 root 显式运行同版 `releaseHost.py --reject-staging-verification <run-attempt>`。它读取原失败记录、回滚备份、运行候选身份和两个原生成任务的只读终态。核销只追加绑定原始事务字节的失败记录，保留原日志和回滚。新编号须完整走发布验收，旧编号不能重放或晋级。杭州正式服不适用。

备份成功后保持原应用与配额 helper 停止，直到固定切换器启动新版，避免备份后出现遗漏新写入的窗口。失败先解冻并取消独立定时兜底，再恢复原服务；解冻失败保持服务停止。

备份采用root显式配置的 `backupCapsuleBytes` 硬容量胶囊：宿主ext4/4KiB块上先完整预分配，并在nodiscard格式化后再次预分配、fsync和核对；宿主保留至少1GiB。原始卷完整扫描只用于估算，最终冻结后重新扫描；稀疏快照保留全部非零块并完整cmp，实际可写配额恢复只在胶囊内部执行。胶囊满额即失败，不依赖压缩率或文件系统元数据常数推断空间安全。恢复结束后卸载胶囊，零洞压缩前后SHA相等，再持久化回执。备份目录必须与冻结数据卷处于不同文件系统。看门狗不依赖标记成功才解冻；手动解冻前保持兜底，解冻后撤销timer/service并核对触发标记，触发过一律不接受快照。此方案尚未实机演练，不代表现役备份通过。

应用 unit 使用 `docker start -a` 启动固定容器。按候选组件哈希单独管理宿主配额 helper 和裁剪组件，应用发布不覆盖主机组件。

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

GitHub 环境权限与发布者范围配置完成后才启用仓库变量 `CANVAS_DELIVERY_ENABLED=true`。

master 推送部署香港 staging。团队在 `https://aivideo-staging.zenjoymedia.media` 验收后，运行 Canvas delivery，填写 staging run ID 并勾选团队已验收。杭州使用该 run 的同一源码、镜像和 COS 对象，并从香港独立读取同一验收回执。

COS 中转由 CI 将固定 digest 的完整 OCI 归档上传至既有私有桶，不创建桶或自动删除对象。repository variables `CANVAS_COS_BUCKET`、`CANVAS_COS_REGION` 与 repository secrets `CANVAS_COS_SECRET_ID`、`CANVAS_COS_SECRET_KEY` 使用仅限 `aivideoReleases/` 的读写身份，不授予删除或分块清理权限。对象键绑定源码 SHA、run 和 attempt；已有对象仅在长度与 SHA 元数据相同才复用。两个 environment 各自生成短期 GET 签名，签名仅经受限 SSH stdin 提供，不写日志、输出或回执。

两地主机 root 固定配置 `cosBucket`、`cosRegion` 和 `cosPrefix`（必须为 `aivideoReleases`）。主机只接受对应 COS HTTPS 域名和本次确定的对象路径，拒绝重定向，限制下载长度和时限并核对归档 SHA；随后执行完整 OCI 验证、Docker 加载与完整导出读回。香港见证只返回小型验收回执，不再传输镜像。配置前须验证私有桶 ACL、权限范围及两地实际访问，不能仅凭构建成功晋级。

## 执行器请求与回执

请求：`environment/sourceSha/image/runId/runAttempt`；production 另带当前同一 run 的 `stagingReceipt`。所有字段按严格白名单验证，禁止将请求拼接成 shell 命令。

成功回执包含五个身份字段、固定 `publicOrigin`、`runningImage`、候选进程 `bootId`、`businessMode=tenant`、业务及跨账号隔离和裁剪证明、实际生成媒体类型、配额卷备份恢复证明、`predecessorImage`、`backupId` 和 COS 对象元数据。香港还须出具实际生成视频和逐帧拉片构建包的 SHA-256。旧共享站回执无法晋级。回执禁止包含令牌、密码、签名链接或用户内容。

回执的 `passedJourneys` 逐项记录已通过的发布验收。每次候选须重新跑齐 `releasePolicy.py` 中对应环境的旅程。现有 PR 回归对照本次 PR 的基线提交，检查两地已有旅程是否完整保留。逐帧拉片字段记录构建包 SHA-256。

业务验收通过普通账号保存并读回专用画布，检查其他账号的访问请求被拒绝，实际触发截取和生成并读回产物。香港生成配置用 `generationRequest.mediaType=video`，产物须通过 ffprobe 的格式与时长校验。杭州使用与香港相同的验收媒体类型、提供方和模型。

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

生产配置 `stagingWitnessHost`、`stagingWitnessUser`、`stagingWitnessKey`、`stagingWitnessKnownHosts`；后两个必须是root保护的文件。见证key与部署key分开，从1Password管理，不复用个人SSH身份。香港见证账号的authorized_keys强制命令只能调用受限sudo的readRelease.py包装器（安装为aivideo-read-release），禁PTY、转发和任意shell。包装器只接受operation=receipt且environment=staging，不得把见证账号直接绑定到可deploy的releaseHost.py。香港见证拒绝未完成事务。读回历史回执时重新核对公网和回环的候选源码、镜像与 bootId。同一镜像重启后，旧回执不可晋级。

## 本轮接入与验证现状

GitHub staging/production environments、仅master分支策略、各自专用SSH key和固定host key已配置。两地发布账号均只允许sudo固定发布器且禁止交互shell/转发；公网认证已实测，发布器尚未安装，因此认证成功后明确返回command not found。香港使用现有6443端口，不增加新监听；临时relay方案已撤销授权。

员工站Cloudflare Access增设独立机器验收策略，保留原人员登录策略。机器凭据仅在1Password及私有缓存；实际公网ffmpeg/status通过，媒体Range请求206且仅传回1024字节。员工数据在线兼容副本用现有c001镜像保留原路径启动，2秒截取耗时0.803秒、ffprobe读回2秒；兼容容器随后停止。在线副本不算一致性备份，未替换现役员工服务。

两地通过 `verifyBusiness.py` 验证两个普通账号的隔离，核对专用画布、候选身份、持久截取和生成产物。`verifyGeneration.py` 只提交一次带固定 taskId 的任务，随后只读轮询。候选在身份接口缺少只读轮询能力时拒绝提交。

网页媒体读取改为显式服务器能力开放时使用原受控接口的Range读取；桌面与旧服务器保留Blob读取。剪辑预览在metadata可用时初始化，避免必须等待整个视频下载。此优化尚未部署，不能据此宣称员工卡顿已修复。

### 2026-11-17 硬容量备份实机记录

新流程已在香港旧539专用卷运行：768MiB胶囊先完整预分配，原始卷3GiB；完整cmp、312个文件、8个SQLite数据库、两个项目配额和普通UID EDQUOT恢复通过。胶囊卸载后零洞压缩SHA不变，最终分配434925568字节，回执编号1794897703147183349。本次是隔离旧卷，未停员工站或杭州生产，也不代表它们已有本版本备份。Ubuntu2.37下losetup需同时指定-J与-l才输出JSON；临时systemd单元取消以LoadState和ActiveState读回，已自动卸载的inactive单元允许收尾。

### 杭州公网切换前验收

杭州正式发布配置必须设置 root 私有的 `productionCandidateConfig`，指向独立候选的发布配置。运维在批准晋级前，将该候选配置的容器启动为香港回执里的同一不可变镜像。候选应用端口 10888 只映射到一个 HTTP 回环端口，使用专用容器网络、独立配额卷、两个专用账号、单独的发布账本及裁剪配额和工作进程。候选的绑定路径必须位于其 `dataDirectory`、`stateDirectory` 或 `runtimeDirectory` 内，也不能与正式容器共享挂载。候选的业务配置沿用正式环境标识，实际业务请求通过该候选的 `localOrigin` 发出。

香港业务回执记录通用的验收媒体类型、提供方和模型 ID。杭州候选及正式验收配置必须与这组值一致。发布器在现有发布锁内检查候选实际 Docker 身份和回环响应，运行登录、画布保存读回、裁剪读回、实际生成及账号隔离验收。镜像、bootId、候选与前驱容器和通过的旅程记入此次正式发布事务。整个候选验收期间，杭州公网仍指向前驱。

GitHub 在正式晋级前还会通过只读 preflight 核对杭州主机已安装支持候选门禁的执行器。候选配置缺失、隔离条件不成立、证据不完整、模型不同或验收失败时，发布器在停止正式服务、备份和切换容器之前拒绝。公网切换之后仍执行原有的生产读回。接入时先在香港部署新版执行器并取得包含 `generationProfile` 的验收回执，再用杭州专用候选验证实际切换及失败路径。
