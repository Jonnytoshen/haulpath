# 重途（zhongtu）

面向个人规划者的本机中文网页工作台，用于重卡业务的行前路线与里程测算，按项目管理线路和点位库。

## 当前状态与技术栈

- 当前已有需求、领域和代理约定文档、应用依赖清单，以及已验证的本机提交消息约束；尚无应用代码或数据库迁移。
- 已确认、待实现：pnpm、Next.js App Router、TypeScript；同一应用提供网页与本机服务端接口，默认监听 `127.0.0.1`。
- 数据持久化使用 SQLite / `better-sqlite3`；Excel 读写使用 ExcelJS，CSV 解析使用 `csv-parse`。
- 地图使用高德 JS API 2.0 与官方 `@amap/amap-jsapi-loader`；驾车测算由服务端调用高德 Web 服务 v5。

## 命令与验证

- `package.json` 已预置 `dev`、`build` 和 `start` 脚本，开发与生产启动均绑定 `127.0.0.1`；尚无应用入口，应用依赖安装、启动与构建仍未验证，不要把预置脚本写成已经可用。
- 提交工具使用 Node `>=22.0.0`、pnpm `12.10.1`（最低 `12.0.0`）；实际通过 `pnpm install --dev --ignore-scripts --frozen-lockfile --offline`、`pnpm run test:commits`（22 项真实 CLI / 隔离 Git 测试），以及 `printf '%s\n' 'docs(git): clarify commit checks' | pnpm run commitlint`、`pnpm run commitlint --edit <消息文件>`、`pnpm run commitlint --from <base> --to HEAD`。占位参数须替换为实际文件或基线；`--from` 不包含起始提交。
- `pnpm run prepare` 显式安装或修复 hook；本轮独立 worktree 已启用 `extensions.worktreeConfig`，实际使用 `GIT_CONFIG="$(git rev-parse --git-path config.worktree)" pnpm run prepare`，仅修改当前 worktree 的 hook 配置。完整安装和校验说明见[提交约定](docs/agents/git-commits.md)。
- 初始化应用后，在此补充从项目根目录实际验证过的准确命令、必要环境变量，以及实际采用的自动化检查及测试运行方式。
- 实现验收优先走浏览器完整用户流程，经过真实应用接口、SQLite 和实际下载的工作簿；仅在高德服务边界使用可控替身。
- 浏览器自动化建议使用 Playwright。模拟高德响应与真实密钥联调分别验证；模拟测试不能证明真实地图可用。
- 纯文档改动核对链接、术语和 ADR 一致性，无需创建应用环境或测试框架。

## 开始任务前

- 阅读 [领域约定](docs/agents/domain.md)、[术语表](GLOSSARY.md) 和与任务相关的 [ADR](docs/adr/)。领域文档尚不存在时按领域约定继续，不为占位而创建。
- 需求与工单遵循 [本地 Markdown tracker 约定](docs/agents/issue-tracker.md)；当前首版需求基线为 `.scratch/zhongtu-v1/spec.md`。
- `.scratch/` 被 Git 忽略，其他工作副本可能没有它；有相关 spec / issue 时先读，缺少任务必需的需求时明确指出缺口，不猜测细节。
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
- 按 [ADR 0001](docs/adr/0001-driving-v2-estimation-scope.md) 使用普通驾车测算；页面和导出均须明确写出“未校验重卡限高、限重及货车限行”。首版不接入货车专用 API，不提供实时导航或重卡通行保证。
- 按 [ADR 0002](docs/adr/0002-segment-planning-and-result-snapshots.md)，N 个点发起 N−1 次相邻点位请求，各区间使用第一条方案；地图、里程和导出共享同一份完整路线方案，前端不另行算路。
- 距离使用接口返回的整数米数；先求和再换算公里，显示三位小数，导出里程保持数值单元格。不要以折线长度替代距离或累加已舍入的公里数。
- 全部区间成功后才原子替换最近成功结果；任一区间失败保留原完整结果。用输入版本和任务标识防止旧请求覆盖新输入或新结果。
- 点位、顺序或规划偏好变化后保留旧结果并标为“待重算”，旧折线退出当前预览、当前里程留空；仅重命名线路不使结果失效。打开线路和导出均不自动重算。
- 导出固定包含“线路总览”和“区间明细”；未规划、待重算线路保留总览状态，里程及有效结果时间留空，不生成区间明细。有效结果时间按 `Asia/Shanghai` 展示。
- 坐标系由用户声明，默认 GCJ-02；WGS84 经高德转换后再用于地图和规划，保留原始坐标与坐标系，不猜测或重复转换。导入先预览校验，经用户确认有效行后写入。

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
