# Docker 部署与数据维护

Docker 是重途的可选本机部署方式。镜像由源码构建，应用和维护工具都在容器中运行；宿主机无需安装 Node.js、pnpm 或 SQLite。原有[本机 Node 启动](../README.md#本机启动)继续可用。

默认仅发布宿主机 `127.0.0.1` 端口，适用于个人使用；没有登录或多用户能力。同一数据库只能运行一个应用服务，包括不同端口、工作副本及 Node / Docker 两种运行方式。切换前先停止原服务。

**未校验重卡限高、限重及货车限行。** Docker 不改变普通驾车测算、完整路线方案或手动重试规则。

## 环境与首次启动

准备 Docker Engine **28 或更高版本**、Compose **2.30 或更高版本**，或具备相应能力的 Docker Desktop，并启用 Linux 容器。支持 `linux/amd64` 和 `linux/arm64`；日常部署默认使用 Docker 主机的原生架构。宿主维护命令使用 POSIX shell，以下命令均在仓库根目录执行。

先确认 Docker 服务可用，再创建独立配置：

```sh
docker version
docker compose version
test -e .env.docker || cp .env.docker.example .env.docker
```

在 `.env.docker` 填写自己的高德配置。此文件与 Node 启动使用的 `.env.local` 分开维护，不提交到 Git，也不进入镜像构建上下文。

| 变量 | 用途 |
| --- | --- |
| `AMAP_WEB_SERVICE_KEY` | 服务端普通驾车规划与 WGS84 坐标转换。 |
| `AMAP_JS_KEY` | 浏览器地图和地点搜索，浏览器可见。 |
| `AMAP_JS_SECURITY_CODE` | 与 JS Key 配套，留在服务端的同源安全代理使用。 |
| `HAULPATH_PORT` | 宿主回环端口，默认 `3000`。 |
| `HAULPATH_IMAGE` | 本地镜像标签，默认 `haulpath:local`；可用于保留和选择升级前版本。 |

Compose 固定设置容器内 `HAULPATH_DB_PATH=/app/data/haulpath.sqlite`。不要把宿主机的数据库路径填入容器配置；已有数据库按下文迁入。

已有本机资料时，先按[迁入原有本机资料](#迁入原有本机资料)执行，避免提前启动目标应用创建空库。全新部署可直接构建并启动：

```sh
docker compose --env-file .env.docker up --detach --build --wait app
docker compose --env-file .env.docker ps
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，自定义端口时使用实际值。首次构建需要下载基础镜像与锁定依赖；应用使用固定 pnpm 和 webpack 构建，运行容器为非 root 用户，并附带 SQLite 维护工具。

高德凭证在运行时注入，构建时不需要提供。未配置凭证也应正常启动并通过健康检查，可管理项目、GCJ-02 点位、线路草稿和导出；地图、规划和 WGS84 转换按现有规则提示缺少配置。真实地图仍需按高德控制台要求配置访问来源与服务权限。

## 配置修改、日志与停止

修改 `.env.docker` 的凭证或端口后，重新创建容器以载入新环境；无需重新构建镜像：

```sh
docker compose --env-file .env.docker up --detach --no-build --force-recreate --wait app
```

仅执行 `restart` 不会更新容器环境变量。容器内部监听 `0.0.0.0:3000`，宿主发布地址仍固定为 `127.0.0.1`；只修改 `HAULPATH_PORT` 即可避开端口占用。

常用检查与停止入口：

```sh
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 app
docker compose --env-file .env.docker stop app
```

健康检查读取项目列表，实际访问数据库，不依赖高德是否可用。`unhealthy` 表示需要检查日志与数据权限；健康状态本身不会自动杀进程或重试规划。

服务采用 `unless-stopped`：异常退出或 Docker 重启后按策略恢复，显式停止后保持停止。中断规划在应用首次打开数据库时标为失败，保留输入、进度与旧完整方案，由用户手动重试。

普通停止和重建保留数据。需要移除应用容器及其 Compose 网络时，可以使用不带删卷参数的命令：

```sh
docker compose --env-file .env.docker down
docker compose --env-file .env.docker up --detach --no-build --wait app
```

**不要在日常重建中使用 `down --volumes` / `down -v`，也不要删除数据卷。它们会删除项目资料。** 卷不是外部备份，仍需定期把一致备份另存到可靠位置。

## 数据卷与部署身份

默认 Compose 项目名为 `haulpath`，服务名为 `app`，数据卷逻辑名为 `data`，默认实际卷名为 `haulpath_data`。整个 `/app/data` 持久化，包含主库与运行中的 `-wal`、`-shm`；不要只挂载或复制主文件。

查看当前应用真正挂载的卷，而不是凭目录名猜测：

```sh
haulpath_container=$(docker compose --env-file .env.docker ps --all --quiet app)
test -n "$haulpath_container"
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$haulpath_container"
```

本文默认使用 `.env.docker` 与项目名 `haulpath`。若明确使用其他项目名或配置文件，每次部署、查看和维护都必须保持一致：Compose 使用 `--project-name` / `--env-file`，维护脚本也支持同名选项。更换 Compose 项目名会对应另一份数据卷，不能把新卷中的空项目误认为旧资料已删除。

维护脚本检查实际应用容器挂载的具名卷与镜像，不根据名称猜测。恢复和迁入期间不要另起使用该卷的应用；运行中的其他容器占用目标卷时，命令会拒绝继续。该检查不替代维护期间保持单实例的操作约定。

## 在线一致备份

维护命令使用镜像内工具，宿主无需 SQLite。先创建目标目录，选一个尚不存在的备份文件名：

```sh
mkdir -p backups
haulpath_backup="backups/haulpath-$(date +%Y%m%d-%H%M%S).sqlite"
./scripts/docker-data.sh backup "$haulpath_backup"
```

应用可以继续运行。命令通过 SQLite 一致备份纳入已提交 WAL 数据，校验独立备份的完整性后保存到宿主目标文件；同名目标被拒绝，失败不发布半份备份。文件路径可包含空格，请始终引用变量和参数。

备份包含项目及其偏好记忆、点库、线路和最近完整成功方案。成功提示不代表副本已离开当前设备；请再复制到可靠位置。不要在线直接复制主库，不对活跃源库使用忽略 WAL 的不可变读取。

自定义部署的维护示例：

```sh
./scripts/docker-data.sh --env-file .env.docker --project-name haulpath backup "$haulpath_backup"
```

## 停服恢复与回退数据

选择一个实际的一致备份文件，执行：

```sh
haulpath_backup='backups/haulpath-20261029-080000.sqlite'
./scripts/docker-data.sh restore "$haulpath_backup"
```

输入不存在或不可读时，在停服前失败，保持原运行状态。进入停服阶段后，后续成功或失败均保持目标应用停止。命令先检查备份格式和完整性，再把旧主库及其 sidecar 整体归档到同卷的唯一 `before-restore-*` 子目录，最后原子安装新主库；不会把新主库配上旧 sidecar。

成功后核对提示，再单独启动：

```sh
docker compose --env-file .env.docker up --detach --no-build --wait app
```

进入页面检查项目、点库、线路、偏好记忆和路线方案，再继续编辑。如果恢复失败，保留错误提示、原归档及准备文件，不要删卷或自动反复启动。归档位于同一卷中，仅用于本次回退排查，不能替代卷外备份。

当前 schema 为 2；新应用会按既有规则迁移旧库，并拒绝过新的数据库。回退应用时使用与旧版本兼容的升级前备份，不手动降低 schema 版本号。完整约束见[数据库版本与恢复说明](operations.md#数据库版本与偏好记忆)。

## 迁入原有本机资料

迁入仅允许写入尚无数据库或遗留 sidecar 的目标卷。**先停止原 Node 应用及其他使用源数据库的服务**；仅关闭浏览器不够。不要先启动目标应用，否则健康检查会创建数据库，目标将不再是空卷。

配置完成后先构建，再把原数据库的实际路径作为参数迁入：

```sh
docker compose --env-file .env.docker build app
./scripts/docker-data.sh migrate '/实际的原数据目录/haulpath.sqlite'
docker compose --env-file .env.docker up --detach --no-build --wait app
```

命令只读挂载原数据库所在目录，生成包含可能遗留 WAL 的一致快照，再由应用用户安装到具名卷；原主库与 sidecar 保持原样。它不会猜测或停止宿主机其他进程，因此执行前需要自己确认原服务已停。

迁入后在页面核对资料，并新增少量可辨认的测试内容确认可继续写入。原目录与新卷从此是两份独立资料，不能在两个应用中继续交替编辑并期待同步；原目录按自己的备份策略保留。

使用远程 Docker daemon 时，绑定挂载的源路径属于 daemon 所在主机。迁入命令应在拥有原目录的 Docker 主机上执行，不会把客户端同名路径自动上传到远端。

## 手动升级与应用回退

升级按“备份→保留旧镜像→构建→停旧启新”执行。先按上文保存一致备份，再保留当前运行镜像的明确标签：

```sh
haulpath_container=$(docker compose --env-file .env.docker ps --all --quiet app)
test -n "$haulpath_container"
haulpath_old_image=$(docker inspect --format '{{.Image}}' "$haulpath_container")
haulpath_saved_tag="haulpath:before-upgrade-$(date +%Y%m%d-%H%M%S)"
docker image tag "$haulpath_old_image" "$haulpath_saved_tag"
```

记下备份文件和保留标签。切换到准备升级的源码后：

```sh
docker compose --env-file .env.docker build app
docker compose --env-file .env.docker stop app
docker compose --env-file .env.docker up --detach --no-build --force-recreate --wait app
```

构建失败时旧服务和数据仍在，不必停服。新服务启动失败时检查日志、备份和数据库版本，不进行重叠部署。构建使用默认 `haulpath:local` 标签时，旧镜像必须提前另存标签，避免后续误删。

需要回退时，停止新服务，将 `.env.docker` 的 `HAULPATH_IMAGE` 改为此前保留的旧标签；必要时先通过维护命令恢复兼容备份，再以 `--no-build --force-recreate` 启动旧镜像。不要重新构建旧标签，否则会把它覆盖成当前源码。回退后继续核对页面资料。

本流程不发布或拉取应用版本镜像，不自动升级，不加入现有[软件发布](releasing.md)流程；基础镜像及构建依赖的下载仍需要网络。

## 私有服务器回环访问

服务器上的宿主端口同样只发布到回环。在自己的电脑建立 SSH 隧道，例如将本机 3001 转发到服务器 3000：

```sh
ssh -N -L 3001:127.0.0.1:3000 用户名@服务器
```

打开 [http://127.0.0.1:3001](http://127.0.0.1:3001)。这不增加局域网或公网访问能力，也不提供多用户服务；高德访问来源仍按实际浏览器来源与服务端出口配置。

## 开发验收与边界

维护者保留现有 Node、pnpm 和浏览器测试环境后，使用独立入口：

```sh
pnpm run test:docker
pnpm run test:docker --matrix
pnpm run test:docker --platform linux/amd64 --core
```

默认执行 Docker 主机原生架构的完整容器套件；`--matrix` 顺序执行 amd64、arm64 核心运行、HTTP、配置、导出与持久化验收，另一架构可以使用受支持的模拟器。`--platform` 可明确指定单一目标，`--core` 仅执行核心场景。测试使用独立配置、临时项目和数据卷，不读取真实 `.env.docker`。

Docker 不可用或目标架构不能运行时，命令明确失败，不把未执行的场景记为通过。Docker 用例位于独立子目录，不被普通 `pnpm test` 或软件发布强制运行。

具体版本、源码、架构、原生或模拟运行情况见[验收记录](acceptance.md)。只有高德 HTTP 与 SDK 使用替身；模拟通过不证明真实高德凭证、地图、搜索或重卡通行可用。

## 常见情况

| 现象 | 处理 |
| --- | --- |
| Docker 命令或 daemon 不可用 | 安装并启动符合版本要求的 Engine / Desktop，核对当前 Docker 连接。 |
| 构建下载失败 | 检查 Docker 主机和构建阶段网络；本地源码构建仍需基础镜像与锁定依赖，不填写真实凭证作为构建参数。 |
| 宿主端口占用 | 修改 `.env.docker` 的 `HAULPATH_PORT`，重新创建服务，保持回环绑定。 |
| 改配置后没有变化 | 使用 `up --no-build --force-recreate` 载入新环境，不能只执行 `restart`。 |
| 新项目为空 | 核对 Compose 项目名、实际挂载卷和迁入步骤，避免操作另一份数据。 |
| 数据库不可用或 unhealthy | 查看日志与实际卷；不要通过 root 递归改权限、改 schema 或删除卷来试错。 |
| 备份或迁入输入错误 | 核对实际路径、文件可读性、卷是否为空及源服务是否已停；保留原资料。 |
| 恢复提示卷被占用 | 停止所有使用该卷的其他应用容器，确认维护期间不会另起服务。 |
| 需要检查镜像内 SQLite | 镜像使用 `sqlite3 -init /dev/null` 屏蔽初始化配置；不要假设与宿主 SQLite 支持完全相同的命令行选项。 |
