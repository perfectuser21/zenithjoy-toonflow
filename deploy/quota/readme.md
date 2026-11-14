# 独立卷与用户配额（实验候选）

此配置尚须通过独立安全审计及目标主机验收，不能仅凭仓库配置上线。普通 `compose.yaml` 不创建卷和 helper；生产多租户缺配额时服务拒绝启用。

1. 运维预先准备固定容量的专用 ext4 文件系统，以 `prjquota` 挂载；确认项目配额的 accounting/enforcement 均开启。不得把现有用户目录或不明项目 ID 直接作为新卷使用。卷满只应影响 Toonflow，容量规划需为公共 SQLite、WAL、临时文件和系统维护保留空间；它们不计入单个用户的 5 GiB 项目配额。
2. 在卷内建立 `projectQuota`，由 root 持有、模式 0711；建立 `tmp` 和服务数据目录，由容器 UID/GID 1000:1000 持有且可写。检查卷路径及其父目录权限，确认服务账号不能替换 root helper 的控制目录。先固定独立测试卷与空的 SQLite 数据源，旧账号或历史媒体任务未归属时禁止启用。
3. 将同一候选版本的 `quotaHelper.py` 与 `trimQuota.py` 一起安装到 root 拥有且服务用户不可修改的版本目录；核对两文件后原子切换启动路径，不得只替换其中一个。裁剪未启用时旧版单文件安装仍可启动。将两个文件以 root 拥有且不可由服务用户修改的方式安装到 `/opt/toonflow/quota/`，将 `toonflowQuota.service` 安装到 systemd；配置 `/etc/toonflowQuota.env`（root 拥有、0600）：

   ```ini
   TOONFLOW_QUOTA_VOLUME=/srv/toonflow-data
   TOONFLOW_QUOTA_ROOT=/srv/toonflow-data/projectQuota
   TOONFLOW_QUOTA_SOCKET=/srv/toonflow-data/projectQuota/quotaHelper.sock
   TOONFLOW_SERVER_UID=1000
   TOONFLOW_SERVER_GID=1000
   TOONFLOW_AUTH_DB=/srv/toonflow-data/multiTenant/multiTenant.sqlite
   ```

   以上路径是配置示例，须替换成目标机器已核实的固定卷。启动 helper 前，必须在全新受控数据目录内初始化 SQLite；helper 将用数据库创建时间区分旧账号。systemd 不负责创建文件系统、格式化、挂载或清理客户数据。重启时 helper 自行对锁、socket 所有权、存活和 inode 进行核验，异常状态拒绝启动。
4. 显式执行 `TOONFLOW_QUOTA_VOLUME=/srv/toonflow-data docker compose -f deploy/quota/compose.yaml up -d`。容器以非 root、只读根文件系统运行，只将已准备的卷挂载为 `/app/data`；服务启用多租户时验证 helper、非 root 身份和数据/TMPDIR/配额目录同一设备。此检查不证明卷具有固定大小，仍须由部署人员核验。
5. 3000 和 10888 仅监听宿主回环地址；反向代理须接入 10888，配置域名、TLS 和访问控制。上线前须在隔离卷验证：两个用户注册和隔离、额度/inode 超限、子进程写入、跨项目硬链接、helper 崩溃重启、未配置/错误卷拒绝、TMPDIR/SQLite WAL 同卷及可用空间水位。卷上其他服务或进程的写入不能由应用层水位检查保证，需通过专用卷及监控保障。

6. 写入返回 503 且怀疑锁遗留时，按 [锁的离线恢复手册](lockRecovery.md) 停止全部写入并核验后恢复；不要自动删除锁。

7. 换背景使用 helper 在 `projectQuota/backgroundAdmission.flock` 建立的 root 持有进程锁；服务进程持锁，退出后由内核释放，锁文件不得删除或替换。数据目录及其直接子目录 `projectQuota` 均须作为独立 bind 挂载点，同处受支持的数据卷；服务的有效、许可、继承和环境权限均不得包含 `CAP_SYS_ADMIN`，并须启用 `no-new-privileges`。随附 Compose 配置建立这两个挂载点，缺失时换背景拒绝准入，以防整个锁目录被替换。部署前必须完全停止并禁止重启所有旧版应用和 worker，确保它们无法再访问该卷；旧版不识别进程锁，不能与新版并行。旧版的 `multiTenant/backgroundAdmission.lock` 如存在，新版始终拒绝启用：运维须在全量停写、防重启并核对挂载与全部实例后，离线将旧标记移交到卷外安全位置留存，不能根据 PID 或文件时间自动清理。之后启动新版 helper 和唯一应用实例并核验；回退旧版前同样须全量停机，不能混跑。云端已提交但结果未知的任务需按原有只读恢复规则处理，不能因重启重新提交。

## 隔离测试卷启用裁剪（实验配置）

### 旧安装的普通项目导出

关闭裁剪时，客户项目导出仍需读取该项目的裁剪账本：账本为空才可导出；账本不可读或有裁剪记录时拒绝导出。缺表或缺预算行可能是老安装未迁移，也可能是数据丢失，应用不能自动把它当成空账本。

对于经运维**独立证明从未启用过裁剪且没有历史裁剪素材**的旧安装，可使用已有 `migrateBackgroundJobs.js` 显式初始化账本：先阻断入口、停止所有应用和写入者及其自动重启，核对目标实例和数据路径；对数据库、工作区及相关卷做一致性备份并在隔离位置恢复核验。结合发布记录、备份和存储清单证明没有历史裁剪数据，核实 `projectQuota/privateTrim` 不存在且无其他私有裁剪存储；任何证据缺失、目录存在、账本损坏或数据可能丢失时停止，先恢复或人工调查，不能初始化空账本掩盖历史。

仅在以上事实均已记录并核实后，以应用 UID 对该安装的数据目录执行 `migrateBackgroundJobs.js <数据目录> --confirm-background-jobs-migration`，读取账本与服务日志核实成功，并在隔离恢复副本验证普通项目导出及账号隔离后才恢复入口。该命令只初始化后台账本，不能证明历史不存在、不能修复已丢失的账本，也不能代替备份；对于 SQLite 和 MySQL 均须核对实际数据库连接和目标，禁止根据异常信息自动重试迁移。若存在历史裁剪数据，必须恢复原账本和素材并核对一致性，不能用新空账本。

`toonflowTrimWorker.service`、`toonflowTrimStore.service` 和 `composeTrim.yaml` 是候选配置，不代表已经通过 staging 或生产验收。先完成上面的 ext4 项目配额前置条件；不得对已有客户卷执行身份、目录或配额的自动迁移。应用的数据卷通常由应用 UID 持有，不能直接作为 store 的安全路径祖先：必须由 root 在安全位置准备独立挂载点，并将现有配额根目录 bind 到 `/srv/toonflow-trim-quota`，供 store 和初始化工具使用。这个路径及其祖先须由 root 持有、不可由应用修改；应用继续使用原数据卷下的配额路径。挂载必须随系统启动恢复，并在每次启动前校验与应用路径指向同一设备和 inode。不得通过更改现有客户数据卷的所有权解决此问题。

2026-11-14 只读核对：香港隔离测试卷为 `/srv/aivideo-isolated-stage-539`，现有配额服务为 `aivideo-stage-quota-persistent-539.service`，不是本示例的 `toonflowQuota.service`。部署该测试环境时还须将 store 单元的 `After`/`Requires` 改为实际配额服务，并确保应用依赖该卷及两个裁剪服务；不得让现有 539 版与候选版同时访问同一卷。该测试卷可用空间约 2.9 GiB，接近 store 保留 2 GiB 的阈值，发送素材前须再次检查剩余空间。

1. 为 worker、store 和应用访问分别准备独立系统用户/组：`toonflow-trim-worker`、`toonflow-trim-store`（主组同名）、`toonflow-trim-access`。worker 的主组为访问组，store 的附加组为访问组；应用仍为 UID/GID 1000，但额外加入访问组。worker 另需加入 Docker socket 所属的 `docker` 组，具有宿主 Docker 管理权限，应视同宿主 root：不向应用或客户开放该账号、Docker socket 或它的凭据。明确记录各 UID/GID，确认与已有账号无冲突。
2. 安装来自同一固定候选版本的 Linux Bun 和构建产物 `trimWorker.js`、`trimStore.js`、`provisionTrimStore.js` 到 root 持有、仅 root 可写的版本目录；`/opt/toonflow-trim/current` 指向该版本。预先固定包含 ffmpeg、ffprobe、awk、timeout 的作业镜像本地 image ID，使用 `sha256:...` 格式且不得自动拉取。构建产物、镜像与目标架构需一致。
3. 由 root 预建 `/var/lib/toonflow-trim`，模式 0755；其 `worker` 子目录归 worker 用户、访问组，模式 0700。由 root 创建 `/run/toonflow-trim-worker` 和 `/run/toonflow-trim-store`，两者均为 root:访问组、0750；其祖先均由 root 持有且不可被其他账号写入。安装 `toonflowTrim.conf` 到 systemd-tmpfiles 配置目录并核实重建结果。`.socket` 单元由 systemd 创建 `worker.sock` 和 `store.sock`，分别归 worker 和 store 用户、访问组，模式 0660。应用和辅助服务无权写 socket 目录；持久锁与作业状态仍保存在数据目录，不随运行目录清除。迁移已有部署时须先停止并禁止旧服务启动、确认无活动或状态不明的作业、备份原配置，再由运维核实现有运行目录和 socket；不得直接覆盖仍有监听或状态不明的路径，不得删除锁或客户数据。
4. 在 root 持有且不可被其他账号写入的 `/etc/toonflow-trim` 保存环境文件。`worker.env` 至少包括 `TOONFLOW_TRIM_SOCKET=/run/toonflow-trim-worker/worker.sock`、`TOONFLOW_TRIM_STATE=/var/lib/toonflow-trim/worker`、`TOONFLOW_TRIM_DOCKER=/usr/bin/docker`、固定的 `TOONFLOW_TRIM_IMAGE` 和随机 64 位十六进制 `TOONFLOW_TRIM_TOKEN`；实际 Docker CLI 必须是 root 持有、非符号链接、不可被其他账号写入的绝对路径。`store.env` 至少包括 `TOONFLOW_TRIM_STORE_SOCKET=/run/toonflow-trim-store/store.sock`、`TOONFLOW_PROJECT_QUOTA_ROOT=/srv/toonflow-trim-quota`、store 主组数字 `TOONFLOW_TRIM_STORE_GID`、访问组数字 `TOONFLOW_TRIM_ACCESS_GID` 和独立随机的 64 位十六进制 `TOONFLOW_TRIM_STORE_TOKEN`。先按凭据规范将两个 token 存入 1Password，再写环境文件；两个文件 root:root、0600；密钥不得放进仓库、命令输出、命令参数或聊天。
5. 在 root 持有的 `/etc/toonflow-trim/secrets` 下建立 `worker` 和 `store` 文件，分别与对应环境文件中的 token 字节一致，64 字节且不带换行；每个文件 root:访问组、0640。不要把 token 放入应用环境变量。向配额 helper 的 root 环境文件添加 store UID、store 主组 GID 和访问组 GID（`TOONFLOW_TRIM_STORE_UID`、`TOONFLOW_TRIM_STORE_GID`、`TOONFLOW_TRIM_ACCESS_GID`），与服务身份一致。对隔离测试卷使用同候选版本的 `provisionTrimStore.js /srv/toonflow-trim-quota <访问组 GID> --confirm-trim-store-provision`，只准备锁文件；账号裁剪目录仍由配额 helper 校验后建立。
6. 新建隔离数据库须先完成多租户管理员初始化，再以应用 UID 运行同一候选的 `migrateBackgroundJobs.js <数据目录> --confirm-background-jobs-migration`，显式建立后台任务表和预算账本；普通裁剪请求不会自动迁移。现有数据库须先完成一致性备份和迁移风险审查，不得为了通过检查而覆盖或清空数据。应用和两个服务不能混用不同候选。安装并核对 `toonflowTrimWorker.socket`、`toonflowTrimStore.socket` 及相应 service 单元，先启用两个 socket，再启动配额 helper、worker、store；确认 socket 单元及服务 active、描述符名称和 owner/group/mode 正确。两个 socket 不由服务代码关闭或删除。再用 `compose.yaml` 和 `composeTrim.yaml` 组合启动单实例。设置 `TOONFLOW_QUOTA_VOLUME`、固定候选 `TOONFLOW_IMAGE`、`TOONFLOW_TRIM_ACCESS_GID`、`TOONFLOW_TRIM_HELPER_UID`、`TOONFLOW_TRIM_STORE_UID`；运行 Compose 时禁止现场重新构建或拉取不明镜像。补充域名、端口、注册、反向代理等环境既有配置；这些不由裁剪 overlay 决定。应用不能挂载 Docker socket。
7. 实测登录、上传、裁剪、节点预览和继续生成的业务链，以及另一账号无法访问、原素材不变、异常重启和磁盘水位；任何一个未通过都不得晋级。当前 Mac 隔离环境只验证了 worker 执行和 store 按项目配额保存/读取，尚未验证整套 systemd、画布或香港环境。

### 故障处理和回退

备份、迁移、切换或回退前，先阻断应用的裁剪请求和自动启动，再停止两个 `.socket` 单元及两个 service；仅停止 service 不够，因为 socket 仍可重新激活它。逐项核实 socket 和 service 已停止、没有排队请求或活动连接、worker 沙箱及作业均已达到可证明的终态，再停止其余写入并按一致性备份方案处理。状态无法确认时保持屏障并人工核对；不能为了恢复服务而清除锁或覆盖数据。恢复时先核验 socket 单元、服务依赖及身份，再逐项恢复入口。

出现错误时先保留原卷、数据库、锁及素材，禁止与旧应用并行；停止自动重试，确认 worker 不再有未知状态的沙箱。可将 `TOONFLOW_SECURE_TRIM_READ_ONLY=1` 并以**同一兼容镜像**重新创建应用容器，继续读取已有结果、禁止新裁剪；仍需原 store、配额 helper 和数据库可用。此设置不能恢复未知任务，也不能代替备份。

worker 和 store 收到停止信号时拒绝新请求并等待已受理的请求结束，达到上限后退出且保留持久锁和任务状态。socket 由 systemd 持有，服务退出不删除 socket；服务停止期间排队的请求可能超时，客户端将执行结果视为未知，不自动释放预留或重复提交。强杀、崩溃、连接中断或任务状态未知时，运维需核对进程、监听、文件身份和作业终态后再按恢复流程处理，不得自动删除未知 socket 或锁。

已有私有裁剪素材或新账本后，旧镜像不能识别这些数据，不得直接降级或用旧快照覆盖现有数据。隔离测试可在单独保留新数据的前提下切换到事先验证的独立旧版副本；真实客户环境需要先完成无损迁移工具、全量一致备份和独立恢复演练，当前均未验收。未知容器创建或状态不明时保持锁并人工核对，不得仅因 PID 消失而释放。
