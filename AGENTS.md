# 重途·HaulPath

面向个人规划者的本机中文网页工作台，用于重卡业务的行前路线与里程测算，按项目管理线路和点位库。

中文名称为“重途”，英文名称为“HaulPath”，仓库名称为 `haulpath`。

## 当前状态与技术栈

- 当前已有 Next.js 线路任务画布、项目线路总览表格与地图预览、独立点位库、SQLite schema 版本 2 迁移、项目/线路/点库接口、坐标与导入、相邻区间测算及双表导出；自动化从真实应用 HTTP 和浏览器入口验收。
- 使用 pnpm workspace、Nx、Next.js App Router、TypeScript；`apps/web`（`@haulpath/web`）仍由同一应用提供网页与本机服务端接口，开发与生产默认监听 `127.0.0.1`。
- `packages/domain`（`@haulpath/domain`）只包含平台无关领域类型与规则，应用通过 `workspace:*` 直接消费 TypeScript 源码；不预构建，不拆分额外服务或业务上下文。两个子包私有且无独立版本，根 `haulpath` 是唯一产品版本与发布对象，取舍见 [ADR 0004](docs/adr/0004-workspace-and-single-product.md)。
- 数据持久化使用 SQLite / `better-sqlite3`；Excel 读写使用 ExcelJS，CSV 解析使用 `csv-parse`，KML/KMZ 使用 XML 与 ZIP 解析。
- 地图使用高德 JS API 2.0 与官方 `@amap/amap-jsapi-loader`；驾车测算由服务端调用高德 Web 服务 v5。
- UI 使用 shadcn/ui 和 Tailwind CSS；功能图标统一使用 Lucide Icons（`lucide-react`），界面不使用 emoji 图标。品牌标志使用原创 HaulPath 资产，遵循[品牌标志规范](docs/brand.md)；不以品牌标志替换业务功能图标。

## 命令与验证

- 应用要求 Node `>=22.12.0`、pnpm `>=12.0.0`，仓库指定 pnpm `12.10.1`。依赖使用 `pnpm install --frozen-lockfile --ignore-scripts`，缓存齐全时可加 `--offline`；类型检查使用 `pnpm run typecheck`（先 `next typegen`），生产构建使用 `pnpm run build`（`next build --webpack`）。命令从仓库根目录经 Nx 调度，应用检查和构建先检查领域包；仅无产物的领域类型检查可缓存，应用检查、构建及所有测试不缓存。同次调度禁止共享应用产物的任务并行；独立命令仍须串行，避免争用 `apps/web/.next` 和类型产物。
- `pnpm run dev` 与 `pnpm run start` 均使用真实入口；生产启动须先构建，端口可通过 `--port` 指定。更换构建器后必须重新验证，不能沿用 webpack 的通过记录。
- `pnpm test` 串行运行全部 `tests/*.test.mjs`；`test:api` 覆盖所有公开接口与 SQLite 备份恢复，`test:browser` 覆盖工作台及完整闭环/代表规模，`test:commits` 验证提交约束，`test:release` 验证公开发布命令并纳入完整测试入口。生产中断恢复用例同时列入 API 与浏览器入口，先执行 webpack 构建；这些入口需要系统 `sqlite3` 和已安装的浏览器。默认系统 Chrome，可用 `PLAYWRIGHT_CHROMIUM_CHANNEL` 指定 channel；分类数量不可直接相加，完整测试按文件只运行一次。
- Docker 部署按[部署指南](docs/docker.md)：`docker compose --env-file .env.docker up --detach --build --wait app` 从源码构建启动，宿主仅发布回环端口；数据卷挂载整个 `/app/data`。更换环境变量须重新创建容器，保留数据卷；备份、恢复与迁入使用 `scripts/docker-data.sh`，部署与维护保持相同环境文件和 Compose 项目名。
- `pnpm run test:docker` 独立运行 `tests/docker/*.test.mjs`，`--matrix` 验收 amd64、arm64 核心流程，另一架构可使用受支持的模拟器；它们不纳入普通完整测试或软件发布门禁。Docker 缺失或目标架构不可用时明确失败，实际记录须区分原生、模拟及真实高德联调。
- 运行配置见 [.env.example](.env.example) 和 [README](README.md)；根 `.env*` 保持原 Next.js 优先级和变量展开，显式进程环境优先，无需移入应用目录；默认数据库为仓库根目录下 `data/haulpath.sqlite`，`HAULPATH_DB_PATH` 的相对值也按仓库根目录解析，绝对值保持原意。迁移不移动用户配置或资料。环境变量统一使用 `HAULPATH_DB_PATH`、`HAULPATH_TEST_MODE`。开发、生产及备份应核对同一数据库位置，不把测试临时库当作用户数据。
- `pnpm run prepare` 显式安装或修复 hook；独立 worktree 已启用 `extensions.worktreeConfig` 时，使用 `GIT_CONFIG="$(git rev-parse --git-path config.worktree)" pnpm run prepare`，仅修改当前 worktree 的 hook 配置。完整说明见[提交约定](docs/agents/git-commits.md)。
- 提交校验入口为 `printf '%s\n' 'docs(git): clarify commit checks' | pnpm run commitlint`、`pnpm run commitlint --edit <消息文件>`、`pnpm run commitlint --from <base> --to HEAD`；替换实际文件/基线，`--from` 不包含起始提交。
- 备份与恢复按[运行维护](docs/operations.md)：在线使用 SQLite `.backup`，恢复先停服务并整体隔离旧数据库与 sidecar。代表负载与实际验证记录见[验收记录](docs/acceptance.md)；缺少真实高德凭证时不得声称真实地图联调通过。
- 实现验收优先走浏览器完整用户流程，经过真实应用接口、SQLite 和实际下载的工作簿；仅在高德服务边界使用可控替身。
- `pnpm run test:workspace` 定向验证工作区根入口、环境优先级、数据库定位与缓存；这些用例已纳入 `pnpm test`，完整验收不重复叠加分类入口。
- 应用配置、shadcn `components.json`、`public` 与源码位于 `apps/web`；组件生成须使用应用目录配置。写应用代码前阅读 `apps/web/node_modules/next/dist/docs/` 中与任务相关的安装版本指南，保留根和应用内 Next.js 自动生成的代理规则。
- 浏览器自动化建议使用 Playwright。模拟高德响应与真实密钥联调分别验证；模拟测试不能证明真实地图可用。
- 纯文档改动核对链接、术语和 ADR 一致性，无需创建应用环境或测试框架。
- 软件发布按[发布指南](docs/releasing.md)与 [ADR 0003](docs/adr/0003-prerelease-version-consistency.md)：从干净 main 执行，首发显式 `--first-release`；支持位置参数 `patch` / `minor` / `major` / `X.Y.Z`、`--channel` 与 `--dry-run`，恢复使用 `release:resume <目标tag>`。完整门禁通过后才写版本和日志，只推送 main 与本次 tag，始终跳过 npm 发布，不关闭 hook 或用户签名。
- 候选转正保持同一基版；累计下限提高时先生成新候选。API 恢复从目标 tag 读取原始日志，只补 Release，不重做版本和 Git 操作，不覆盖人工说明或让旧版本抢占 Latest。API token 优先 `GITHUB_TOKEN`、其次 `GH_TOKEN`，与 Git 推送认证分开检查，禁止输出凭证。
- 变更日志采用 Nx 默认渲染器；`BREAKING CHANGE:` 的完整迁移说明使用普通段落或列表，写在 Markdown 标题或水平分隔线之前，遵循原生提取边界。历史 tag 的日志恢复仍按原文读取。
- 实际验证按日期、源码与覆盖范围记录在[验收记录](docs/acceptance.md)，历史结果不能代表当前 HEAD 已通过。最低 Node 未运行完整套件，真实 GitHub 与真实高德联调未执行；发布验证边界见[发布指南](docs/releasing.md#验证记录边界)。

## 开始任务前

- 阅读 [领域约定](docs/agents/domain.md)、[术语表](GLOSSARY.md) 和与任务相关的 [ADR](docs/adr/)。领域文档尚不存在时按领域约定继续，不为占位而创建。
- 需求与工单遵循 [本地 Markdown tracker 约定](docs/agents/issue-tracker.md)；当前首版需求基线为 `.scratch/haulpath-v1/spec.md`，规划偏好扩展见 `.scratch/haulpath-planning-preferences/spec.md`，线路总览见 `.scratch/haulpath-route-overview/spec.md`，任务画布与项目资源分层见 `.scratch/haulpath-ux-restructure/spec.md`（替代旧工作台的页面结构约定，既有数据与状态规则继续生效），KML/KMZ 导入扩展见 `.scratch/haulpath-kml-import/spec.md`，Docker 部署见 `.scratch/haulpath-docker-deployment/spec.md`。产品及仓库名称以 `.scratch/haulpath-name/spec.md` 的更名规格为准，规格目录与文内引用统一使用当前名称。
- `.scratch/` 被 Git 忽略，其他工作副本可能没有它；有相关 spec / issue 时先读，缺少任务必需的需求时明确指出缺口，不猜测细节。
- 工作区迁移需求基线为 `.scratch/haulpath-monorepo/spec.md`；根命令、环境文件、数据库位置、单一产品版本及 Docker 卷身份保持兼容。
- 线路总览地图预览的需求基线为 `.scratch/haulpath-route-overview-map/spec.md`，已实现项目内表格/地图切换；它扩展总览的地图展示范围，既有领域、结果有效性与导出规则继续生效。实际覆盖及限制以验收记录为准。
- 每个功能使用 `.scratch/<feature-slug>/spec.md`；实现工单分别放在 `issues/<NN>-<slug>.md`，从 `01` 编号，评论追加到文件末尾的 `## Comments`。
- 技能要求“发布到 issue tracker”时写入上述本地文件；按编号取工单时，在对应功能目录解析。

## Git 提交

- 严格遵循[项目 Angular 扩展版提交约定](docs/agents/git-commits.md)，使用允许的 type 与可选单一 scope；英文小写祈使句摘要，标题最多 100 字符。合并、撤销和临时消息没有默认豁免。
- 每次提交必须有独立目的并包含相关代码、必要测试及配置，能独立解释、验证和回退；不混入无关改动，不为增加次数拆散必要变更。提交前核对暂存内容，完成相关验证，按需在正文记录实际结果。
- 本机 hook 可绕过，直接 `git revert` 不保证触发；需要拦截时用 `git revert --no-commit` 后普通 `git commit`，正文记录完整 SHA 和撤销原因。交付前主动校验本轮全部新增提交区间，同时人工检查语义与提交完整性；保持用户签名设置，不重写无关历史。

## 领域与实现约束

- 命名遵循术语表。例如 A→B→C 是一条“线路”，A→B 是一个“区间”，一次完整成功的测算结果是“路线方案”；“途经点”不写成“途径点”，“线路名称”不等于“道路名称”。
- 点位库归属项目；选入线路时复制点位名称和坐标，之后独立维护。跨项目操作检查归属，对象用稳定标识关联，不能以名称代替身份。
- 线路草稿可以不足两个点；规划至少需要两个有效点。保留用户指定顺序，支持 A→B→A，阻止相邻点坐标完全相同的规划。
- 普通驾车规划偏好支持 `strategy` 数值 `0`、`1`、`2`、`32`–`45`；名称、说明、分组顺序和校验共用策略目录，一条线路的全部区间使用同一偏好，不任意组合或混用旧版及 JS API 编码。
- 项目在 SQLite 中记住最近成功显式保存的偏好；新建线路省略偏好时继承，更新线路省略偏好时保留原值且不更新记忆。同值显式保存也更新记忆，但不使线路结果失效或清除当前任务；记忆与线路保存必须事务原子。未显式保存偏好时，查看、改名、点位编辑、规划和导出不改记忆；删除线路或删空线路后仍保留，删除项目才移除。新项目和升级后的已有项目均从 `32` 开始记忆，不从线路更新时间推断历史。
- 按 [ADR 0001](docs/adr/0001-driving-v2-estimation-scope.md) 使用普通驾车测算；页面和导出均须明确写出“未校验重卡限高、限重及货车限行”。首版不接入货车专用 API，不提供实时导航或重卡通行保证。
- 按 [ADR 0002](docs/adr/0002-segment-planning-and-result-snapshots.md)，N 个点发起 N−1 次相邻点位请求，各区间使用第一条方案；地图、里程和导出共享同一份完整路线方案，前端不另行算路。
- 距离使用接口返回的整数米数；先求和再换算公里，显示三位小数，导出里程保持数值单元格。不要以折线长度替代距离或累加已舍入的公里数。
- 全部区间成功后才原子替换最近成功结果；任一区间失败保留原完整结果。用输入版本和任务标识防止旧请求覆盖新输入或新结果。
- 每个数据库只运行一个应用服务；进程首次打开数据库时将遗留规划中任务标为中断失败并保留输入、进度和成功方案，允许用户手动重试。正常读取与开发热更新不得取消当前任务。
- 点位、顺序或规划偏好变化后保留旧结果并标为“待重算”，旧折线退出当前预览、当前里程留空；仅重命名线路不使结果失效。打开线路和导出均不自动重算。
- 项目默认进入线路总览表格，表格与地图共用搜索、筛选和排序。地图绘制匹配线路的全部有效完整方案，按稳定标识分配 8 色；选中仅预览，显式打开才进入编排。无有效方案仅选中显示当前点位，不画旧折线或示意直线；预览选择独立于工作台当前线路。
- 返回总览保留同项目会话的视图、浏览条件、预览选择、地图中心缩放及各自滚动，切项目或刷新页面后重置。主动选线、改变搜索筛选或“查看全部”触发定位，零点选线保留视野；排序及数据刷新不移动视野。表格中改变条件后，返回地图优先适配新范围。总览与工作台共用线路数据，结果有效性与运行/失败提示分开判断；迟到响应不得覆盖新写入或其他项目会话。
- 打开或新建线路默认进入“编排点位”，通过“编排点位 / 测算线路 / 核对方案”切换任务，侧栏保留快速切线；重命名保留当前任务页，删除线路回到总览。点位库是独立项目资源，管理时不隐式选线或显示线路地图与方案；从线路选点时明确目标，支持连续选点后返回编排。项目导出位于项目层，当前线路导出位于核对页。
- 项目导出始终包含全部项目线路，不受网页搜索、筛选和排序影响。导出固定包含“线路总览”和“区间明细”；未规划、待重算线路保留总览状态，里程及有效结果时间留空，不生成区间明细。有效结果时间按 `Asia/Shanghai` 展示。
- 手动录入和表格坐标系由用户声明，默认 GCJ-02；标准 KML/KMZ 固定 WGS84。WGS84 经高德转换后再用于地图和规划，保留原始坐标与坐标系，不猜测或重复转换。导入先预览校验，经用户确认有效项且全部转换成功后原子追加，不自动去重。KML/KMZ 只读取所选文档中的 Point，不跟随外部链接；多文档 KMZ 由用户明确选择。地图文件及预览数据的资源限制见对应规格，超限时不得返回部分结果或写入数据。

## 边界与维护

- 项目数据由本机服务写入 SQLite，不以浏览器缓存代替持久化；首版范围不包含多用户、云同步、对外开放服务或自动优化点位顺序。
- Web 服务 Key 和 JS 安全密钥留在服务端，JS 安全密钥通过受控同源代理使用；浏览器仅使用 JS Key。不要将真实凭证写入文档、源码或可提交的环境文件。
- 遵循 `.gitignore`：本地凭证、SQLite 数据及备份、生成产物和 `.scratch/` 不纳入版本控制；环境变量示例只放占位值。
- 提案与既有 ADR 冲突时，指出具体决策和重新考虑的理由；需求或约定变更时同步更新相关规格、术语、ADR 及本文件。
- 本文件仅保留稳定、项目特有的操作约束；详细需求和流程放在对应文档中。代码与工具链建立后补充实际示例，删除过时说明，不套用尚未采用的代码风格或 Git 工作流。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
