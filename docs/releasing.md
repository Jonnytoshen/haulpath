# 软件发布

根命令 `pnpm run release` 直接执行 `nx release --skip-publish`，使用已锁定的 Nx 24 原生版本推导、CHANGELOG、Git 提交、tag、推送及 GitHub Release。根 `haulpath` 是唯一版本与发布对象；`apps/web`、`packages/domain` 私有且无独立版本。日志位于根 `CHANGELOG.md`，tag 为 `v{version}`，跳过 npm / registry 发布。本流程不生成安装包或部署应用。

## 发布前准备

使用 Node.js `>=22.12.0`、pnpm `12.10.1`（最低 `12.0.0`），安装冻结依赖。完整应用测试需要系统 `sqlite3` 与 Chrome，见 [README](../README.md)。维护者应在干净的 `main` 上执行发布，确认待发布提交、`origin`、远端分支及现有 tag 正确，修复分叉或未完成的发布后再继续。

发布入口不再自动执行原脚本中的质量门禁、固定 HEAD 或检查 main。发布前显式串行执行以下检查，不与当前工作副本的开发、生产服务或其他构建并行；应用产物共享 `apps/web/.next`。

```sh
# base 为本轮提交校验起点，例如上一发布 tag；首次历史检查省略 --from
pnpm run commitlint --from "$base" --to HEAD
pnpm run typecheck
pnpm run build
pnpm test
```

全部通过且工作区与待发布 HEAD 未变后，再预览和发布。Docker 验收保持独立入口。保留 Git 身份、`commit-msg` hook 及用户签名设置，签名失败时修复环境。

GitHub API 认证按 Nx 原生顺序使用 `GITHUB_TOKEN`、`GH_TOKEN`，也可回退到已认证的 `gh` CLI；Git 推送另需有效的 SSH / HTTPS 认证。不要输出 token 或提交真实凭证。Nx CLI 原生加载根 `.local.env`、`.env.local` 和 `.env`，已存在的进程变量优先；发布不再经过 `scripts/workspace.mjs` 的调用者环境适配，也不依赖应用启动器加载根 `.env.local`。

## 原生命令

```sh
# 自动根据 Conventional Commits 推导版本
pnpm run release --dry-run
pnpm run release

# 显式递增级别或精确版本
pnpm run release patch --dry-run
pnpm run release minor --dry-run
pnpm run release major --dry-run
pnpm run release 1.0.0 --dry-run

# 原生预发布：新候选、后续候选、精确转正
pnpm run release 0.3.0-beta.0 --dry-run
pnpm run release prerelease --preid=beta --dry-run
pnpm run release 0.3.0 --dry-run
```

去掉 `--dry-run` 才执行写入与远端操作。位置参数与选项全部按 Nx 解释，更多选项用 `pnpm run release --help` 查看；也可直接使用 `pnpm exec nx release --skip-publish ...`。不使用 registry 发布子命令。

`--channel` 和 `release:resume` 已移除。预发布使用原生 `premajor`、`preminor`、`prepatch`、`prerelease` 与 `--preid`，也可指定完整 SemVer。维护者须核对预览中的候选基版和转正目标；原自定义累计版本下限、渠道顺序与同基版晋级校验已移除，决策见 [ADR 0005](adr/0005-native-release.md)。

仅全新仓库没有发布 tag 时才使用 `--first-release`。目标版本由原生规则或显式版本决定，不固定为 `0.1.0`；已有发布历史时不要重复首发。例如为全新仓库显式建立 `0.1.0`：

```sh
pnpm run release 0.1.0 --first-release --dry-run
```

## 版本与日志

根产品通过 Nx 隐式依赖包含两个子包，因此仅修改网页应用或领域包的提交也参与根版本及统一日志，见 [ADR 0004](adr/0004-workspace-and-single-product.md)。提交 scope 继续表示领域范围，`useCommitScope: false`；软件版本独立于 SQLite schema 和测算输入版本。

| 提交变化 | 0.x 阶段 | 1.x 起 |
| --- | --- | --- |
| `feat` | patch | minor |
| `fix`、`perf` | patch | patch |
| 任意允许类型的破坏性变更 | minor | major |
| 其他普通允许类型 | 不自动递增 | 不自动递增 |

上述是稳定版本的自动推导映射；原生预发布与显式版本按 Nx 规则执行，手动目标不再经过项目自定义的累计下限校验。`adjustSemverBumpsForZeroMajorVersion: true` 也影响手动相对参数：0.x 的 `major` 调整为 minor、`minor` 调整为 patch（预发布形式同理）；希望精确选择基版时传完整版本号。维护提交可进入下次日志，也可显式选择版本。原提交与 revert 使用 Nx 原生版本分析和日志配对语义，不按最终代码净差异保证跳过发布。

日志使用 Nx 默认渲染器。11 个允许类型通过 `changelog.title` 配置图标和英文分类标题，例如 `🚀 Features`、`🐛 Bug Fixes`、`📚 Documentation`，摘要和引用不自动翻译。破坏性变更按[提交约定](agents/git-commits.md)使用 `BREAKING CHANGE:`；完整迁移说明使用普通段落或列表，在 Markdown 标题或水平分隔线之前写完，遵循原生提取边界。

“Thank You” 启用原生 GitHub 用户名映射，可匹配时显示 `姓名 @用户名`。noreply 邮箱可直接解析，其他邮箱由 Nx 查询作者服务并按需回退到 `gh`；无法识别时保留姓名。`--dry-run` 也可能进行只读作者查询。

## Git 与 GitHub Release

`nx.json` 启用根 workspace changelog 的 `createRelease: "github"` 与 Git commit、tag；GitHub Release 配置由 Nx 在最终发布阶段触发推送。发布提交标题为 `chore: release v<版本>`，遵循现有提交规范与签名设置。Nx 创建的 GitHub Release 使用原生生成的说明与预发布标记。

Nx 24 推送内部执行 `git push --follow-tags --no-verify --atomic`。它跳过 `pre-push` hook；本仓库未配置该 hook，发布前检查须显式完成。`commit-msg` 仍会运行。`--follow-tags` 可能同时推送当前分支可达、尚未推送的其他 annotated tags；推送范围按 Git / Nx 原生行为确定，发布前须检查本地 tag，不再承诺仅推送本次 tag。

`--dry-run` 预览版本、日志和计划 Git / GitHub 操作，不写版本、日志、提交或 tag，不推送或创建 / 更新 Release；允许写入被忽略的 Nx 缓存。启用 GitHub Release 后，预览也会只读查询远端 Release，因此不保证离线可用。预览不运行应用检查，不代表已通过发布前验证。

## 失败后处理

Git、文件与 GitHub API 不是跨系统原子事务。失败后先检查 `git status`、HEAD、目标 tag、远端 refs 和 GitHub Release，保留原生错误输出所指向的现场；不要在已有发布提交或 tag 时盲目重跑完整发布。

- 本地版本、日志、提交、签名或 tag 阶段失败：检查实际遗留状态，修复对应问题后再决定如何继续。
- 本地提交与 tag 正确、推送失败：确认远端状态后仅补推应发布的分支和 tag。
- tag 已推送但 GitHub Release 缺失：从目标 tag 的 `CHANGELOG.md` 取得对应版本说明，在 GitHub 上针对该 tag 补建 Release，核对预发布与 Latest 设置。
- Release 已存在：先保留人工说明并检查实际内容。Nx 原生可以更新已有 Release，不能把重跑视作“只补缺失、不覆盖”的恢复操作。

项目不再提供 API-only 的 `release:resume`，也不承诺从历史 tag 自动提取原始说明或保护人工编辑。原生 `nx release version` / `changelog` 是独立阶段命令，使用前按其帮助和配置要求核对行为，不作为旧恢复协议的等价替代。

## 验证记录边界

`pnpm run test:release` 从公开 `pnpm run release` 贯穿真实 Nx、隔离 Git 仓库与本地 bare remote，仅在 GitHub API 和作者查询边界使用可控替身，不向真实仓库发布。当前覆盖与命令结果见[验收记录](acceptance.md)。

旧发布器的历史验收仍保留在记录中，不能作为本原生入口的当前通过证明。最低 Node 未运行完整套件；真实 GitHub 发布与真实高德联调未执行，发布专项不替代应用或 Docker 验收。

原生命令及配置参考：[Nx Release](https://nx.dev/docs/features/manage-releases)、[跳过 registry 发布](https://nx.dev/docs/guides/nx-release/publish-in-ci-cd)、[GitHub Release](https://nx.dev/docs/kb/automate-github-releases)。
