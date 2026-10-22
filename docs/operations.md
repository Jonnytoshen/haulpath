# 本机运行与数据维护

应用默认监听 `127.0.0.1`；开发使用 `pnpm run dev`，生产使用 `pnpm run build` 后 `pnpm run start`。在仓库根目录启动，默认数据库为 `data/zhongtu.sqlite`。启动时自动创建目录和当前 SQLite schema。

**同一数据库仅运行一个应用服务**，包括不同端口、开发与生产模式、不同工作副本。切换前先停止原服务；SQLite 在线备份不属于第二个应用服务。

服务重启后首次打开数据库，会把遗留的规划中任务标为中断失败，保留原点位、输入版本、区间进度和完整成功方案。恢复规划中的在线备份也执行相同处理；页面可手动重新规划，不会自动调用高德。正常服务运行期间的读取和刷新不会取消正在执行的任务。

## 配置与数据位置

复制 `.env.example` 为 `.env.local`，填写高德三项凭证；修改后重启服务。`ZHONGTU_DB_PATH` 可为相对路径或绝对路径，更换路径会打开另一份数据库。不要把“新路径中项目为空”误认为旧资料已被删除。

数据库使用 WAL 模式，运行时可能同时出现主文件、`-wal` 和 `-shm`。这些文件及 `.env.local`、备份均不进入 Git。保存环境文件与数据的操作权限应由本机用户控制；不要把真实密钥放进截图、工单或提交。

## 一致备份

需要系统 `sqlite3` 命令。以下命令针对默认 `data/zhongtu.sqlite`，可在服务仍运行时执行，使用 SQLite 的 `.backup` 纳入已提交 WAL 数据。若自定义了 `ZHONGTU_DB_PATH`，须先把命令中的源路径换成实际路径；`sqlite3` 不会读取 `.env.local`。

在仓库根目录执行：

```sh
(
  set -eu
  mkdir -p backups
  backup_path="backups/zhongtu-$(date +%Y%m%d-%H%M%S).sqlite"
  test ! -e "$backup_path"
  sqlite3 -noinit -readonly data/zhongtu.sqlite ".backup '$backup_path'"
  integrity=$(sqlite3 -noinit -readonly "file:$backup_path?immutable=1" 'PRAGMA integrity_check;')
  test "$integrity" = ok
  printf '备份完成：%s\n' "$backup_path"
)
```

目标同名时停止，不覆盖旧备份；源库不存在时只读打开失败，不创建空数据库。该不可变 URI 检查仅用于刚生成、没有其他进程写入的独立单文件备份。**不要对在线源库使用 `immutable=1`**，它会忽略活跃 WAL。

备份文件包括项目、点库、线路和最近完整成功方案。将完成的备份另存到可靠位置；Git 忽略规则不是数据备份。不要在线直接 `cp data/zhongtu.sqlite`，主文件可能尚未包含 WAL 中最新提交的内容。

## 恢复与回退

先在运行服务的终端按 Ctrl-C，确认**所有使用该数据库的服务进程已停止**；仅关闭浏览器不够。停止期间再执行恢复。

将下面 `backup_path` 替换为已生成的实际备份文件名。此例只处理应用默认的整个 `data/` 目录：

```sh
(
  set -eu
  backup_path='backups/zhongtu-20261022-080000.sqlite'
  test -f "$backup_path"
  integrity=$(sqlite3 -noinit -readonly "file:$backup_path?immutable=1" 'PRAGMA integrity_check;')
  test "$integrity" = ok
  archive_path="backups/before-restore-$(date +%Y%m%d-%H%M%S)"
  test ! -e "$archive_path"
  if test -d data; then mv data "$archive_path"; fi
  mkdir data
  cp "$backup_path" data/zhongtu.sqlite.restoring
  mv data/zhongtu.sqlite.restoring data/zhongtu.sqlite
)
```

确认上面的恢复命令成功完成后，再单独启动服务：

```sh
pnpm run dev
```

旧 `data/` 整体归档，因此旧主库、WAL 和 SHM 保持在一起；新数据库不会配上旧 sidecar。复制中途失败时，旧资料仍在 `backups/before-restore-*` 中。回退时再次停服务，把当前 `data/` 移到另一处保留，再将选定的旧归档目录完整移回 `data/`，不要混合不同批次的文件。

恢复后在页面核对项目、线路、点库和方案，再继续编辑。若数据库位于应用目录之外，应先整体归档**该主文件和同名 `-wal`、`-shm`**，再安装单文件备份；不要移动包含其他应用资料的整个外部父目录。数据库版本过新时应用会拒绝打开，应使用匹配的应用版本，不要手动修改 schema 版本绕过检查。

## 常见情况

| 现象 | 处理 |
| --- | --- |
| 本机端口占用 | 停止旧实例，或 `pnpm run dev --port 3001`；同一工作副本只运行一个开发服务 |
| 地图提示缺少配置 | 检查 `AMAP_JS_KEY`、配套的 `AMAP_JS_SECURITY_CODE`，重启服务；检查高德控制台的来源与权限 |
| 规划或 WGS84 转换缺 Key | 配置服务端 `AMAP_WEB_SERVICE_KEY` 后重启 |
| 权限、额度、超时、无路线 | 按错误提示检查高德服务权限、额度、网络及点位；失败区间可见，修正后手动重试 |
| 线路显示待重算 | 当前输入已变，旧完整方案仍保留；成功重算后才有当前有效里程 |
| 更换目录后数据为空 | 检查启动目录及 `ZHONGTU_DB_PATH`，确认打开的是原数据库 |
| 地图 SDK 加载失败 | 检查浏览器网络、高德配置和控制台；模拟验收不能排除真实服务限制 |

地图安全代理固定在 `/_AMapService`，仅允许输入提示、POI 文本搜索及详情三个路径。真实 SDK 若需要额外路径，先核实实际请求，再精确扩展；不能改成任意 URL 代理。测试专用的 `ZHONGTU_TEST_MODE=1` / `AMAP_API_BASE_URL` 只允许本机假服务，不应写入真实运行的环境配置。
