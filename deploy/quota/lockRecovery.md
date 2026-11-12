# 工作区容量锁的离线恢复

`<TOONFLOW_DATA_DIR>/multiTenant/workspaceQuotaLock` 是应用在写文件前创建的共享目录锁。当前版本**不记录可靠的持有者 PID 或实例租约**：不能通过目录时间、单个进程的 PID、容器重启或锁存在时间认定锁已失效。进程崩溃后目录会保留，后续写入返回 503。不得用定时任务自动删除，也不能用 `rm -rf`。

以下方法需要运维先完成**全量停写和防重启**。如果不能证明该文件系统只有已停机的 Toonflow 实例在写，或有其他主机可访问相同存储，不执行恢复。`fuser` 是额外证据，不能阻止一个进程在检查之后启动。

1. 根据部署清单核对真实数据目录、文件系统挂载点及设备；确认是需要维护的独立卷。停止所有使用该卷的 Toonflow 应用实例、worker、helper 及其他写入者，并暂停 Compose、systemd、外部调度器和多机自动恢复。检查 Docker/Kubernetes/其他宿主的挂载清单；若存在不明实例，停止并排查，不能继续。
2. 在目标宿主以 root 从**卷外目录**运行下面的检查，`data_dir`、`volume_mount` 和服务 UID 改成运维已核实的值。执行前核实 `fuser`、`findmnt` 可用，检查过程中保持所有写入者关闭。任何检查失败、诊断不明确或出现使用进程都应停止，不能清理。

   ```bash
   data_dir=/srv/toonflow-data
   volume_mount=/srv/toonflow-data
   service_uid=1000
   lock_dir="$data_dir/multiTenant/workspaceQuotaLock"

   test "$(id -u)" = 0 || exit 1
   command -v fuser >/dev/null && command -v findmnt >/dev/null || exit 1
   test "$(realpath -e -- "$data_dir")" = "$data_dir" || exit 1
   test "$(realpath -e -- "$volume_mount")" = "$volume_mount" || exit 1
   test "$(findmnt -n -o TARGET --target "$data_dir")" = "$volume_mount" || exit 1
   test -d "$lock_dir" && test ! -L "$lock_dir" || exit 1
   test "$(realpath -e -- "$lock_dir")" = "$lock_dir" || exit 1
   test "$(stat -c '%u' -- "$lock_dir")" = "$service_uid" || exit 1
   entries=$(find "$lock_dir" -mindepth 1 -maxdepth 1 -print -quit) || exit 1
   test -z "$entries" || exit 1
   fuser_status=0
   holders=$(fuser -m "$volume_mount" 2>&1) || fuser_status=$?
   if test "$fuser_status" != 1 || test -n "$holders"; then
     echo "文件系统有使用者或无法确认状态：$holders" >&2
     exit 1
   fi
   # 保持停写、防重启，手动再次核对进程、容器与目标后才执行。
   fuser_status=0
   holders=$(fuser -m "$volume_mount" 2>&1) || fuser_status=$?
   if test "$fuser_status" != 1 || test -n "$holders"; then
     echo "文件系统有使用者或无法确认状态：$holders" >&2; exit 1
   fi
   rmdir -- "$lock_dir"
   ```

3. `rmdir` 只移除空目录；若目录非空或操作失败，保留现场并调查，不改成递归删除。恢复启动 helper 和应用后，核验健康检查及一次新写入。不要删除工作区文件、数据库、媒体或其他锁。

## 隔离演练

在与生产无共享挂载的独立 Docker 临时文件系统中执行：

```bash
docker run --rm --tmpfs /mnt/quota postgres:16-alpine sh -ec '
  mkdir -p /mnt/quota/multiTenant/workspaceQuotaLock
  sh -c "cd /mnt/quota && exec sleep 30" &
  holder=$!
  fuser -s -m /mnt/quota || exit 10
  test -d /mnt/quota/multiTenant/workspaceQuotaLock
  kill "$holder"
  wait "$holder" 2>/dev/null || true
  if fuser -s -m /mnt/quota; then exit 11; fi
  test ! -L /mnt/quota/multiTenant/workspaceQuotaLock
  test -z "$(ls -A /mnt/quota/multiTenant/workspaceQuotaLock)"
  rmdir /mnt/quota/multiTenant/workspaceQuotaLock
  test ! -e /mnt/quota/multiTenant/workspaceQuotaLock
  echo "活持有者被发现；停机后空锁已恢复"
'
```

演练只验证进程持有时拒绝、停机后移除空锁的基本流程。生产环境的跨主机隔离、调度器停机和 `fuser` 可见性必须独立确认。
