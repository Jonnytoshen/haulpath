# 软件发布

重途通过本机 `pnpm` 入口调用 Nx Release，维护软件版本、`CHANGELOG.md`、发布提交和 `v` 前缀 tag，再推送到 GitHub 并创建 Release。根 `package.json` 的 `haulpath` 是唯一版本来源与发布对象，`apps/web` 和 `packages/domain` 均私有且无独立版本。沿用根日志与 `v{version}` tag，始终跳过 npm / registry 发布；本流程不生成安装包、不部署应用，也不接入自动发布 CI。

本文描述已实现的发布工作流；本机与隔离远端的历史验收见[验收记录](acceptance.md#2026-10-25-发布工作流验收)。真实 GitHub 发布与真实高德联调未执行。

## 环境与准备

使用 Node.js `>=22.12.0`、pnpm `12.10.1`（最低 `12.0.0`），在仓库根目录安装冻结依赖。完整测试还需要系统 `sqlite3` 和已安装的 Chrome，细节见 [README](../README.md) 与[运行维护](operations.md)。Node 22.12.0 已完成冻结安装、项目发现与发布入口烟测；完整应用回归使用 Node 24.21.0，详见文末。

实际发布从干净的 `main` 执行。发布入口固定使用 `origin`，其地址须指向目标 GitHub 仓库，支持 `https://github.com/<owner>/<repo>`、`git@github.com:<owner>/<repo>` 或 `ssh://git@github.com/<owner>/<repo>`，可带 `.git` 后缀，不允许内嵌凭证。若配置独立 `pushurl`，其文本必须与 fetch URL 完全相同。确保远端可访问、历史未分叉、Git 推送认证有效，并为 GitHub API 配置具有目标仓库 Release 写入权限的 token。允许本机有尚未推送的合法提交，无需提前单独推送所有代码。

API 优先读取进程环境中的 `GITHUB_TOKEN`，其次读取 `GH_TOKEN`。通过安全的本机凭证管理方式注入进程，不把真实值写入命令示例、源码、规格、可提交环境文件或日志。API token 与 Git SSH / HTTPS 推送认证分别检查；API 可用不能证明 Git 可推送。沿用用户的 Git 身份、hook、SSH 提交签名和 tag 签名策略；签名失败应修复环境，不能通过关闭签名绕过。

## 公开命令

```text
pnpm run release [patch|minor|major|X.Y.Z] [--channel stable|alpha|beta|rc] [--first-release] [--dry-run]
pnpm run release:resume <目标tag> [--dry-run]
pnpm run test:release
```

版本是可选的一个位置参数，`X.Y.Z` 为稳定 SemVer 精确版本，不含 `v`、预发布后缀或构建元数据；候选渠道单独使用 `--channel` 指定。默认渠道为 `stable`。只接受列出的参数，不把任意参数透传 Nx，不提供关闭质量门禁或开启 npm 发布的开关。无效或冲突参数在修改前失败。

| 命令 | 用途 |
| --- | --- |
| `pnpm run release --dry-run` | 根据提交预览下一正式版本。 |
| `pnpm run release` | 自动推导并发布；没有有效版本变化则跳过。 |
| `pnpm run release patch` | 显式要求 patch 递增。 |
| `pnpm run release minor` | 显式要求 minor 递增。 |
| `pnpm run release major` | 显式要求 major 递增。 |
| `pnpm run release 1.0.0 --dry-run` | 预览精确目标；实际执行时去掉预览选项。 |
| `pnpm run release --channel beta --dry-run` | 预览 beta 候选或渠道晋级。 |
| `pnpm run release:resume v0.1.1 --dry-run` | 核对指定 tag 的 Release 补建计划。 |
| `pnpm run test:release` | 在隔离夹具中验证公开发布命令。 |

命令会区分预览、无变化跳过、发布成功和失败，报告版本、tag、已完成阶段及需要的恢复步骤；失败返回非零退出码。

## 首次正式发布

仓库没有正式 tag 时，必须显式首发。首发沿用当前 `0.1.0`，允许清单版本不变，由首次日志形成发布内容；汇总此前开发历史，生成合规发布提交和 `v0.1.0` 正式基线，不按全部历史再次抬高版本。

```sh
pnpm run release --first-release --dry-run
pnpm run release --first-release
```

首次发布模式只用于建立 `0.1.0` 正式基线，不能重复覆盖，也不与候选渠道或手动版本混用。完成首个正式发布后，再开始 alpha / beta / rc 周期。

## 自动版本与手动覆盖

根产品在 Nx 中显式配置对 `@haulpath/web` 和 `@haulpath/domain` 的隐式依赖，应用另以 `workspace:*` 消费领域源码。仅修改任一子包的 feat、fix 或破坏性变更也参与根产品版本及日志分析，子包不独立生成版本、日志或 tag，取舍见 [ADR 0004](adr/0004-workspace-and-single-product.md)。

后续发布从最近正式 tag 分析累计 Conventional Commits；`route`、`planning` 等 scope 表示领域范围，不作为 Nx 项目筛选条件。软件版本是应用发行的 SemVer，独立于 SQLite 结构迁移版本和测算输入版本；发版不修改业务数据，也不使路线方案因软件版本号变化而失效。

| 提交变化 | 0.x 阶段 | 1.x 起 |
| --- | --- | --- |
| `feat` | patch | minor |
| `fix`、`perf` | patch | patch |
| 任意允许类型的破坏性变更 | minor | major |
| 其他普通允许类型 | 不自动递增 | 不自动递增 |

`perf` 触发 patch 是项目显式配置。破坏性变化仍须按[提交约定](agents/git-commits.md)填写精确的 `BREAKING CHANGE:` 页脚和迁移说明。维护提交默认不单独发版，但会进入下一次发布日志；显式位置参数可以主动要求发布。

手动目标不得低于累计自动最低版本或已有候选基版。允许主动预留更高版本，例如 `pnpm run release 1.0.0 --channel alpha`。同一发布区间内的原提交与 revert 沿用 Nx 原生语义：原提交仍可能触发版本变化，日志可能抵消配对条目，不能按最终代码净差异保证跳过发布。

日志由 Nx 默认渲染器生成，使用英文分类、原始提交摘要和可用引用，不自动翻译。全部允许类型都可展示，任意类型的破坏性变更及迁移说明均可展示；正式说明覆盖上一正式版本之后的整个候选周期。`BREAKING CHANGE:` 后的完整迁移步骤应使用普通段落或列表，写在 Markdown 标题或水平分隔线之前，遵循 Nx 原生提取边界。

“Thank You” 启用 Nx 原生 GitHub 作者用户名映射，显示为 `姓名 @用户名`。GitHub noreply 邮箱可直接解析，其他邮箱由 Nx 查询作者服务并按需回退到 `gh`；无法识别账号时按原生行为保留姓名。作者解析是只读元数据查询，`--dry-run` 生成日志时也可能执行。

## 候选基版与晋级

`0.1.1-beta.0` 的 `0.1.1` 称为候选基版。新基版或新渠道从编号 `0` 开始；同基版同渠道有有效新变化时递增编号，无有效新变化且无显式发布要求时跳过。同基版按 `alpha → beta → rc → stable` 前进，可以跳级，不能倒退；晋级与转正允许没有新提交。

以下为首发完成、提交足以推出 `0.1.1` 时的示例，先使用相同命令加 `--dry-run` 核对：

```sh
pnpm run release --channel alpha
pnpm run release --channel beta
pnpm run release --channel rc
pnpm run release --channel stable
```

对应首次渠道版本为 `v0.1.1-alpha.0`、`v0.1.1-beta.0`、`v0.1.1-rc.0`，最终正式版为 `v0.1.1`。GitHub 上前三者标记预发布，不能成为 Latest。

累计最低正式版本通过独立的 Nx 只读调用从最近正式 tag 推导，不从磁盘候选版本继续递增，也不只看最近候选后的提交。候选目标基版取已有候选基版、自动最低版本和合法手动目标的最大值；仅实际提高基版才开启新周期，避免对同一累计破坏性变更反复抬高 minor。

如果累计变化已超过当前候选基版，先发布满足下限的新候选，再转正；不能到转正时悄悄提高基版。若已预留更高候选基版，新增变化仍被它覆盖时保留基版。取舍见 [ADR 0003](adr/0003-prerelease-version-consistency.md)。

## 预览与质量门禁

`--dry-run` 展示版本依据、目标版本、渠道、日志和计划动作，不写软件版本、日志、锁文件、暂存区、提交或 tag，不推送或创建 / 更新 GitHub Release。没有远端或 token 也能本地预览；允许 Nx 写入已忽略缓存。预览不运行类型检查、构建或完整测试，也不是任意自定义脚本的写入沙箱。

实际发布固定目标版本与待发布 HEAD，先检查干净 `main`、目标 tag 未存在、远端与认证条件，再串行执行：

1. 提交历史校验：首发包含根提交的全部历史；后续校验最近正式 tag 之后到待发布 HEAD。
2. `pnpm run typecheck`。
3. `pnpm run build`，保留现有 `next build --webpack`。
4. `pnpm test`，串行执行全部测试文件，包含发布测试；不叠加重复运行分类入口。

这些根入口经 Nx 调度，覆盖应用和领域包；只有领域类型检查可使用无产物缓存，应用检查、webpack 构建与测试均实际执行。它们共用 `apps/web/.next` 与类型产物，独立进程之间也必须串行，不与当前工作副本的开发或生产服务并行。Docker 验收仍使用独立入口，不加入软件发布门禁。

全部通过后再次确认仍在 main、HEAD 和工作区未变，才由 Nx 写入精确版本及日志、创建发布提交和 tag。任何检查失败或输入变化都在发布写入前停止。门禁不放入 Nx 会在预览中执行的前置版本命令，也不依赖 pre-push hook；通过检查后直接执行，不增加第二次交互确认。

发布提交使用合规标题 `chore: release v<版本>`，不新增 `release` scope。只原子推送 `main` 和本次 tag，不推送其他 tag、不强推或覆盖历史。推送成功后通过 GitHub API 为该已存在 tag 创建已发布 Release，避免 GitHub 为其他提交隐式建立 tag。

## 失败状态与恢复

Git 与 GitHub API 不是跨系统原子事务。根据命令报告的阶段处理，不自动删除 tag、撤销发布提交或重写历史来伪装回滚，也不要在已有发布产物时盲目重跑普通发布。

| 已完成阶段 / 失败点 | 操作 |
| --- | --- |
| 质量门禁失败 | 修复问题，核对工作区后重新预览及发布。 |
| 本地写入、提交、签名或 tag 失败 | 检查命令报告、`git status`、提交及 tag，按实际遗留状态修复或继续；停止推送和 API 调用。 |
| 已有发布提交与 tag，推送失败 | 保留本地结果，修复 Git 认证或远端问题，仅补推该 `main` 与目标 tag；推送完成前不创建 Release。 |
| 推送成功，API 失败或结果不确定 | 使用该目标 tag 的恢复入口，核对或补建 Release。 |

推送失败时按命令给出的 tag 替换以下占位符，远端仍使用 `origin`；先确认 main 和目标 tag 仍指向该次发布结果：

```sh
git -c push.followTags=false push --atomic origin refs/heads/main:refs/heads/main refs/tags/<目标tag>:refs/tags/<目标tag>
pnpm run release:resume <目标tag> --dry-run
pnpm run release:resume <目标tag>
```

例如仅在 `v0.1.1` 已正确推送而 Release 缺失时执行 `pnpm run release:resume v0.1.1`。恢复只补远端 Release，不推送、不递增版本、不生成或修改本地日志、不创建提交或 tag，也不重跑完整门禁。

恢复要求本地目标 tag 存在、其中软件版本与 tag 一致、对应日志条目可读，且远端同名 tag 指向同一提交。远端 tag 未推送时先补推；tag 冲突、版本不一致或缺少日志时明确失败，不自动覆盖修复。

正常与恢复路径都读取目标 tag 已提交的日志正文和日期；main 前进、工作区内容改变或跨日重试不会重新生成说明。提取以真正版本标题为边界，保留迁移说明中的普通 Markdown 标题。目标 Release 已存在即幂等成功并返回信息，不覆盖人工编辑。旧正式版本的恢复不能取代更新正式版本的 Latest；候选始终不成为 Latest。恢复 `--dry-run` 只核对并展示计划，不修改远端。

## 验证记录边界

`pnpm run test:release` 从公开命令贯穿真实 Nx、临时 Git 仓库、hook、文件及隔离 bare remote；GitHub API、作者查询与夹具质量命令使用可控替身。作者用例使用可解析的 GitHub 远端身份，并仅将 Git 传输路由到本地 bare 仓库，核对文件、tag 与发布正文中的 `@用户名`。夹具呈现真实多包工作区并清理外层 Nx 任务、工作区与缓存上下文，在隔离仓库中验证；不会递归调用真实完整测试，也不会向真实仓库发布。

2026-10-25 的发布工作流验收覆盖 Node `24.21.0` 完整回归，以及最低 Node `22.12.0` 的安装、项目发现、首发预览与入口烟测；详细源码、命令、结果与复测边界统一见[发布验收记录](acceptance.md#2026-10-25-发布工作流验收)。这些是对应源码的历史结果，不能代表当前 HEAD 已通过；正式发布仍须执行上述完整质量门禁。

最低 Node 未运行完整应用或全部发布测试。真实 GitHub 发布与真实高德联调未执行；可控替身验证不能证明真实地图可用，也不提供重卡通行保证。未校验重卡限高、限重及货车限行。
