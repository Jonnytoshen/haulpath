# 重途·HaulPath

个人使用的本机中文网页工作台，按项目整理重卡业务的行前线路、点位与里程测算。支持有序多点规划、地图预览、Excel / CSV 点位导入，以及单线路和项目 Excel 导出。

中文名称为“重途”，英文名称为“HaulPath”，仓库名称为 `haulpath`。

**未校验重卡限高、限重及货车限行。** 首版采用高德普通驾车规划 2.0，按相邻点位分别规划后汇总；不保证重卡可通行，不提供实时导航，也不自动优化点位顺序。

## 本机启动

准备 Node.js **22.12.0 或更高版本**、pnpm **12.10.1**（最低 12）。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
test -e .env.local || cp .env.example .env.local
pnpm run dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。应用默认只监听本机 `127.0.0.1`。端口占用时可以使用 `pnpm run dev --port 3001`。环境变量修改后需重启服务。

在 `.env.local` 填写自己的高德凭证：

| 变量 | 用途 |
| --- | --- |
| `AMAP_WEB_SERVICE_KEY` | 服务端驾车规划、WGS84 坐标转换 |
| `AMAP_JS_KEY` | 高德 JS API 2.0 地图、地点搜索；浏览器可见 |
| `AMAP_JS_SECURITY_CODE` | 与 JS Key 配套的安全密钥，服务端通过受控代理使用 |
| `HAULPATH_DB_PATH` | SQLite 路径，默认 `./data/haulpath.sqlite`；相对路径以启动目录为准 |

配置统一使用 `HAULPATH_DB_PATH`、测试变量 `HAULPATH_TEST_MODE`，默认数据库为 `data/haulpath.sqlite`。

Web 服务 Key 与 JS 安全密钥不发送到浏览器。请按高德控制台要求配置对应服务权限与本机访问来源。无凭证时仍可管理项目、线路草稿、GCJ-02 点位及导出；地图、规划和 WGS84 转换会提示缺少相应配置。

生产模式：

```sh
pnpm run build
pnpm run start
```

`build` 使用 `next build --webpack`。当前受限环境的默认 Turbopack 生产构建曾遇到权限失败，webpack 构建及生产启动已实际验证。项目使用 Next.js App Router、TypeScript、SQLite / better-sqlite3、ExcelJS；界面采用 shadcn/ui、Tailwind CSS 和 Lucide Icons。

## 使用流程

1. 新建项目，在项目下创建命名线路；线路可以先保存为空草稿。
2. 按行驶顺序加入点位：搜索地点后确认、点击地图确认、手动输入坐标，或从项目点位库选择。线路中可拖动或使用上下移按钮排序。
3. 点位库支持 `.xlsx` 和 UTF-8 CSV。下载模板，选择工作表、映射名称/经度/纬度列、声明坐标系，预览错误行后确认选中的有效行。点库选入线路后独立维护。
4. 选择高德推荐、高速优先或少收费，手动开始规划。N 个点计算 N−1 个区间，地图、总里程、区间明细使用同一份完整成功方案。
5. 修改点位、顺序或偏好后显示“待重算”，旧折线退出预览、当前里程留空。成功重算后整体替换方案；失败保留最近成功方案。仅改线路名称不会使结果失效。
6. 导出当前线路或整个项目，得到“线路总览”和“区间明细”双表；里程为公里数值，显示三位小数。未规划、待重算线路保留总览状态但不输出有效里程和区间。导出和重开线路均不触发自动规划。

坐标系由用户声明，默认 GCJ-02；WGS84 经高德转换后使用，同时保留原始坐标。支持 A→B→A 往返，相邻重复坐标须先调整。首版不支持旧 `.xls`、纯地址批量定位、多用户、云同步或离线地图。

项目、点库、线路及最近成功方案由本机服务写入 SQLite；更换浏览器不丢失项目数据。请阅读 [备份、恢复与配置排查](docs/operations.md)，备份时不能在线直接复制 SQLite 主文件。

## 验证与开发

```sh
pnpm run typecheck
pnpm run build
pnpm run test:api
pnpm run test:browser
pnpm run test:commits
pnpm run test:release
# 一次串行运行全部测试文件（分类入口存在交叉）：
pnpm test
```

API 与浏览器测试会启动真实本机应用并使用临时 SQLite，下载和读取实际 Excel 文件；仅高德 HTTP 服务及地图 SDK 使用可控替身。`test:api` 的备份恢复用例需要系统 `sqlite3` 命令。浏览器测试默认使用已安装的 Google Chrome；可用 `PLAYWRIGHT_CHROMIUM_CHANNEL` 选择其他已安装的 Playwright 浏览器 channel。请串行运行这些命令，不要让多个 Next 开发服务共享本工作副本的 `.next`。

生产中断恢复用例先执行 webpack 构建，使用临时生产服务和真实浏览器验证重启及备份恢复后的手动重试，因此 `test:api` 与 `test:browser` 都需要系统 `sqlite3` 和已安装的浏览器。该用例在两个分类入口中有交叉；`pnpm test` 按文件只执行一次。

[本轮验收记录](docs/acceptance.md) 包含完整闭环、20 点 / 100 线路 / 1,000 点库的本机观测与证据边界。**真实高德联调尚未执行**：需要配置真实凭证后完成记录中的人工清单；模拟测试不证明真实地图、搜索或重卡通行可用。

提交前阅读 [Angular 扩展提交约定](docs/agents/git-commits.md)。本次安装跳过生命周期脚本，可显式 `pnpm run prepare` 安装提交 hook；已启用独立 worktree 配置时使用该文档中的 `GIT_CONFIG` 命令。领域术语见 [GLOSSARY.md](GLOSSARY.md)，架构取舍见 [ADR](docs/adr/)；需求和工单按本地 [tracker 约定](docs/agents/issue-tracker.md) 管理。

## 软件发布

使用本机 Nx Release 工作流；先以 `pnpm run release --first-release --dry-run` 预览首个 `0.1.0` 正式基线。后续支持自动版本、位置参数 `patch` / `minor` / `major` / `X.Y.Z`、`--channel stable|alpha|beta|rc` 及 `--dry-run`；API 失败后使用 `pnpm run release:resume <目标tag>` 补建。完整门禁、认证、候选规则和精确恢复步骤见[发布指南](docs/releasing.md)。

发布功能与 Node `22.12.0` 最低环境的实际验证待发布工单 04 补齐；既有应用通过记录不代表发布流程已经验收。发布仅维护源码版本、日志、Git tag 与 GitHub Release，始终跳过 npm 发布，不生成安装包或自动部署。
