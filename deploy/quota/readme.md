# 独立卷与用户配额（实验候选）

此配置尚须通过独立安全审计及目标主机验收，不能仅凭仓库配置上线。普通 `compose.yaml` 不创建卷和 helper；生产多租户缺配额时服务拒绝启用。

1. 运维预先准备固定容量的专用 ext4 文件系统，以 `prjquota` 挂载；确认项目配额的 accounting/enforcement 均开启。不得把现有用户目录或不明项目 ID 直接作为新卷使用。卷满只应影响 Toonflow，容量规划需为公共 SQLite、WAL、临时文件和系统维护保留空间；它们不计入单个用户的 5 GiB 项目配额。
2. 在卷内建立 `projectQuota`，由 root 持有、模式 0711；建立 `tmp` 和服务数据目录，由容器 UID/GID 1000:1000 持有且可写。检查卷路径及其父目录权限，确认服务账号不能替换 root helper 的控制目录。先固定独立测试卷与空的 SQLite 数据源，旧账号或历史媒体任务未归属时禁止启用。
3. 将 `quotaHelper.py` 以 root 拥有且不可由服务用户修改的方式安装到 `/opt/toonflow/quota/`，将 `toonflowQuota.service` 安装到 systemd；配置 `/etc/toonflowQuota.env`（root 拥有、0600）：

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
