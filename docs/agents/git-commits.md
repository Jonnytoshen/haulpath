# Git 提交约定

重途采用项目定制的 Angular 扩展版，以 `@commitlint/config-conventional` 为基础，再由项目规则收紧格式。这里的规则适用于开发者和代码代理，目的是让每次提交都能独立解释、验证和回退。

[Angular 官方现行规范](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md)列出八种普通类型，并要求除 `docs` 外的提交填写至少 20 个字符的正文。本项目额外接受 `chore`、`style` 和专门的 `revert` 类型，普通正文可选，也没有最短长度；scope 使用下表的项目词汇。不要混用两套规则。

## 每次提交应当完整

- 一次提交只解决一个可独立理解的问题，包含相关代码、必要测试和配套配置；无关改动分开提交，不为增加提交次数拆散必要的组成部分。
- 提交前检查工作区和暂存区，确认文件归属，完成与改动相关的验证。正文按需记录动机、行为变化和验证结果；不能把未运行的检查写成已通过。
- 交付前检查本轮全部新增提交，核对每次改动的目的、完整性及验证记录，并运行下文的提交区间校验。已有历史不因本约定自动重写，签名沿用用户设置。

## 标题、类型与范围

```text
type(scope): summary
```

scope 可省略；填写时只能选一个完整的小写值。冒号后恰好一个空格，标题无首尾空白，整体最多 100 个字符，计数包含类型、范围和标点。摘要必须非空，以英文小写字母开头，使用英文祈使句，末尾不加英文句点；摘要内部允许 `Next.js`、`SQLite` 等技术名称的大写字母。

| type | 用途 |
| --- | --- |
| `build` | 构建系统、依赖或开发工具链变更。 |
| `ci` | 持续集成配置和脚本；保留此类型不表示当前已有 CI。 |
| `docs` | 仅涉及文档的变更。 |
| `feat` | 新增功能。 |
| `fix` | 修复缺陷。 |
| `perf` | 改善性能的代码变更。 |
| `refactor` | 不新增功能、不修复缺陷的代码重构。 |
| `test` | 增补或修正测试。 |
| `chore` | 其他维护性变更。 |
| `style` | 不改变代码含义的格式调整；界面功能或视觉行为变更不能仅因涉及样式就使用此类型。 |
| `revert` | 撤销已有提交，必须补全下文的撤销说明。 |

| scope | 含义 |
| --- | --- |
| `project` | 项目管理及项目归属。 |
| `route` | 线路及其有序点位、草稿和维护操作。 |
| `point` | 点位、项目点位库及点位复用。 |
| `planning` | 行前测算、区间汇总及路线方案的结果生命周期。 |
| `map` | 地图显示、地点搜索和地图交互。 |
| `import` | 文件导入、预览、列映射与确认。 |
| `export` | 线路或项目导出及工作簿输出。 |
| `storage` | 本机数据持久化和数据访问。 |
| `ui` | 界面结构、展示和通用交互。 |
| `git` | Git 提交约束及仓库提交操作。 |
| `deps` | 依赖与版本管理。 |
| `tooling` | 其他开发工具和辅助工程能力。 |

scope 表达改动范围，不绑定目录。跨范围改动可省略 scope，但仍须具有同一目的。不能用逗号、斜杠或反斜杠组合多个 scope；新增 scope 时同步修改规格、规则、测试和本指南。

| 合法示例 | 说明 |
| --- | --- |
| `feat(route): preserve point order` | 单一业务范围与英文祈使句。 |
| `build(deps): update Next.js dependencies` | 摘要内部保留技术名称大小写。 |
| `fix(storage): preserve SQLite snapshots` | 存储范围。 |
| `docs: clarify planning limits` | 不填写 scope。 |

| 非法示例 | 原因 |
| --- | --- |
| `feature(route): preserve point order` | 未知类型。 |
| `feat(routes): preserve point order` | 未知 scope。 |
| `feat(route,point): preserve point order` | 多个 scope；斜杠或反斜杠组合也不允许。 |
| `feat(route):  preserve point order` | 冒号后多一个空格。 |
| `feat(route): Preserve point order` | 摘要以大写字母开头。 |
| `feat(route): 保留点位顺序` | 摘要未以英文小写字母开头。 |
| `feat(route): preserve point order.` | 摘要末尾有英文句点。 |
| `feat(route)!: change point order` | 不接受标题中的破坏性变更简写。 |
| `feat(route): wip preserve point order` | 摘要带临时前缀。 |

`WIP`、`fixup!`、`squash!` 和 `amend!` 临时标题或摘要前缀均被拒绝，包括 Git 自动生成的对应标题；正文中讨论这些操作不受影响。空消息、纯空白和仅有 Git 注释的消息也不能通过。

## 正文、页脚与特殊提交

普通正文可选，可用中文或英文，不要求至少 20 个字符。正文及页脚单行可以超过 100 个字符，长中文说明和链接不必为了校验强行折行。标题与后续正文或页脚、正文与页脚之间必须有空行。

```text
fix(route): preserve point order

保留用户指定的点位顺序，避免回程线路被重新排序。

Refs: local route-order spec
```

破坏性变更仅使用精确的 `BREAKING CHANGE:` 页脚：标记后必须有非空摘要，空一行后填写实际迁移说明。以下是消息格式示例，不代表当前已有存储迁移：

```text
feat(storage): change snapshot format

BREAKING CHANGE: replace the snapshot format

导入旧格式快照后执行格式转换，再使用新版本保存；转换前保留备份。
```

`BREAKING-CHANGE:` 别名、标记大小写或冒号不符、标题 `!`、只有标记或摘要、没有迁移说明的消息均失败。注释或 `Refs:`、`Fixes #...`、签名等元数据不能充当实际说明。

撤销仍采用 `revert(scope): summary` 或 `revert: summary`。正文必须单独一行写 `This reverts commit <40 位十六进制完整 SHA>.`，保留英文句点，并另写非空撤销原因。下列 SHA 仅为格式示例，实际操作应替换为正确目标：

```text
revert(route): restore point order

This reverts commit 0123456789abcdef0123456789abcdef01234567.

恢复原有点位顺序，修正本次回归。
```

Git 自动生成的 `Merge ...`、`Revert ...`、纯版本号消息没有豁免。需要创建合并提交时，可先用 `git merge --no-ff --no-commit <branch>` 应用合并、解决冲突并完成验证，再用普通 `git commit` 填写合规消息，例如 `chore: integrate route changes`；按实际改动选择 type 和 scope。已有待完成合并也可整理消息后用 `git commit` 完成。

直接 `git revert` 不保证触发 `commit-msg` hook。需要提交前拦截时，先运行 `git revert --no-commit <完整SHA>`，检查撤销改动并完成验证，再用普通 `git commit` 写入上述合规撤销消息。无论采用何种撤销方式，交付前仍需校验新增提交区间。

## 安装、修复与独立校验

在项目根目录使用已声明的 Node `>=22.12.0`、pnpm `12.10.1`（最低 `12.0.0`）。当前锁定的提交工具是 commitlint `20.5.3` 与 Husky `9.1.7`，兼容现有 Node 约定；应用依赖安装、启动和构建另行验证。

仅安装本轮提交工具所在的开发依赖，可运行：

```sh
pnpm install --dev --ignore-scripts --frozen-lockfile
pnpm run prepare
```

缓存齐全时，安装命令可加 `--offline`；本轮已验证离线安装 86 个开发依赖包且无下载。安装开发依赖时通常由 `prepare` 生命周期配置 hook；若跳过生命周期脚本，或需要修复 hook，显式执行 `pnpm run prepare`。不要依赖重复安装一定会再次执行生命周期。项目仅配置 `commit-msg`，没有借机接入应用检查或 `pre-commit`。

在已启用 `extensions.worktreeConfig` 的独立 worktree 中，本轮使用以下命令仅向当前 worktree 配置安装 hook，避免改变共享的 `core.hooksPath`：

```sh
GIT_CONFIG="$(git rev-parse --git-path config.worktree)" pnpm run prepare
```

该命令以仓库已启用 worktree 独立配置为前提，不会替你启用该选项。安装后可用 `git config --show-origin --get core.hooksPath` 检查实际配置来源。图形客户端也需要能找到 Node 和 pnpm；hook 缺失时先核对依赖、命令路径和配置，再显式修复。

hook 复用统一的 `pnpm run commitlint --edit "$1"` 入口，正确引用 Git 提供的文件路径。以下独立命令也在项目根目录运行，无需创建提交：

```sh
# 标准输入
printf '%s\n' 'docs(git): clarify commit checks' | pnpm run commitlint

# 消息文件，路径含空格时保留引号
pnpm run commitlint --edit '/tmp/haulpath commit message.txt'

# 校验基线之后的全部新增提交；先将 base 设为本轮起点
pnpm run commitlint --from "$base" --to HEAD

# 验证提交约束的外部行为
pnpm run test:commits
```

`--edit` 的文件需先存在并含完整提交消息。`--from` **不包含起始提交**，`--to` 包含结束提交；若要检查某个提交本身，以它的父提交作为起点。区间内任意消息失败都会使整体失败，包括中间非法、最新合法的情况；不要只检查 `HEAD` 而遗漏前面的新增历史。

统一入口通过薄启动层执行真实 commitlint CLI，并默认传入 `--strict`。薄层补齐 commitlint `20.5.3` 跳过空消息文件及历史空消息的行为；历史范围复用官方读取 API，保持起止边界一致，消息规则仍由同一份共享配置与项目规则完成。项目关闭默认忽略，将必要空行设为错误，保留 100 字符标题上限并关闭正文与页脚行长限制；仅继承 conventional preset 不足以表达全部约定。

错误返回非零退出码，并显示规则名称和修正提示。按反馈修改原消息后重新校验或提交即可；`git commit --amend` 同样执行检查。`pnpm run test:commits` 已通过 22 项测试，覆盖真实 CLI、消息文件和区间，以及隔离临时 Git 仓库中的安装修复、普通提交、修订、合并和撤销；测试不修改当前仓库签名设置。

## 检查边界与维护

本机 hook 可以被 `git commit --no-verify`、`HUSKY=0` 等方式绕过，直接撤销也不能依赖它必然触发。本轮没有远端 CI、服务器端 hook 或分支保护门禁，因此执行者必须在交付前主动检查全部新增提交。

工具检查结构、允许值、空行、SHA 形式及必要说明是否存在；执行者和审查者负责判断英文祈使句是否准确、type 和 scope 是否合适、摘要是否真实、提交是否完整、撤销目标是否正确，以及迁移说明能否执行。格式通过不能证明这些语义正确，也不能发现未声明的破坏性变更。

规则调整时同步维护需求规格、共享配置与项目规则、入口行为、测试和本指南。[commitlint 配置文档](https://commitlint.js.org/reference/configuration.html)说明共享配置和默认忽略；[Husky 文档](https://typicode.github.io/husky/get-started.html)说明生命周期安装及本机 hook 的可关闭性质。领域命名继续遵循[术语表](../../GLOSSARY.md)，业务决策继续遵循[现有 ADR](../adr/)。

## 发布提交与版本分析

[发布工作流](../releasing.md)使用 `chore: release v<版本>`，例如 `chore: release v0.1.1-beta.0`；不新增 `release` scope，不豁免提交规则，沿用用户身份、hook 和签名策略。实际发布串行校验提交历史、类型、webpack 构建及完整测试，通过后才写入发布提交与 tag；不依赖可绕过的 pre-push hook，也不关闭签名解决失败。首发校验包含根提交的全部历史，后续校验最近正式 tag 之后到待发布 HEAD。

Nx 的提交分析不以 scope 筛选软件包，现有领域 scope 无需改名。基础映射为 `feat` → minor、`fix` / `perf` → patch，其余允许类型 → none；零主版本调整使 0.x 的普通 feat、fix、perf 都递增 patch，破坏性变更递增 minor，1.x 起破坏性变更递增 major。任何允许类型的破坏性变更均须满足本文的页脚与迁移说明要求。维护提交默认不单独发版，但进入下次日志；原提交与 revert 采用 Nx 原生版本和日志配对语义，不承诺按净代码差异决定版本。

发布测试和最低 Node 环境的实际验证由发布工单 04 补齐；本文保留的既有提交工具验证记录不作为新发布功能已通过的依据。
