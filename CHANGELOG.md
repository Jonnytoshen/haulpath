## 0.1.0 (2026-10-26)

### Features

- **export:** download route workbooks with current results ([f50d309](https://github.com/Jonnytoshen/haulpath/commit/f50d309))
- **import:** preview and confirm project point tables ([af83c79](https://github.com/Jonnytoshen/haulpath/commit/af83c79))
- **map:** proxy required amap services with server credentials ([adf2ec5](https://github.com/Jonnytoshen/haulpath/commit/adf2ec5))
- **planning:** preserve complete route calculation results ([96b10c7](https://github.com/Jonnytoshen/haulpath/commit/96b10c7))
- **point:** normalize raw coordinates through amap ([c50e242](https://github.com/Jonnytoshen/haulpath/commit/c50e242))
- **storage:** initialize local workspace persistence ([05d9c9d](https://github.com/Jonnytoshen/haulpath/commit/05d9c9d))
- **tooling:** preview release versions with Nx ([84a8df1](https://github.com/Jonnytoshen/haulpath/commit/84a8df1))
- **tooling:** publish and resume verified releases ([d30447e](https://github.com/Jonnytoshen/haulpath/commit/d30447e))
- **ui:** build the local route planning workbench ([8ea3a32](https://github.com/Jonnytoshen/haulpath/commit/8ea3a32))
- **ui:** streamline the route planning workbench ([78d1ff6](https://github.com/Jonnytoshen/haulpath/commit/78d1ff6))
- **ui:** add the HaulPath logo ([2161156](https://github.com/Jonnytoshen/haulpath/commit/2161156))

### Bug Fixes

- **git:** close commit message validation gaps ([c5a6c20](https://github.com/Jonnytoshen/haulpath/commit/c5a6c20))
- **planning:** recover interrupted tasks after service restart ([0c61109](https://github.com/Jonnytoshen/haulpath/commit/0c61109))
- **tooling:** preserve release context and initial history ([e7b795d](https://github.com/Jonnytoshen/haulpath/commit/e7b795d))
- **ui:** wait for project data before dependent writes ([0471566](https://github.com/Jonnytoshen/haulpath/commit/0471566))
- **ui:** provide a Lucide application icon ([5d2d0f5](https://github.com/Jonnytoshen/haulpath/commit/5d2d0f5))
- **ui:** improve selected route text contrast ([76cec5b](https://github.com/Jonnytoshen/haulpath/commit/76cec5b))
- **ui:** guard point edits and planning readiness ([34ead8b](https://github.com/Jonnytoshen/haulpath/commit/34ead8b))

### Code Refactoring

- **ui:** separate shared dialog composition ([0c07d79](https://github.com/Jonnytoshen/haulpath/commit/0c07d79))

### Documentation

- document local operation and acceptance results ([2788aa2](https://github.com/Jonnytoshen/haulpath/commit/2788aa2))
- record review fixes and final validation ([0e80e3f](https://github.com/Jonnytoshen/haulpath/commit/0e80e3f))
- prepare documentation for v0.1.0 ([9f3ab9a](https://github.com/Jonnytoshen/haulpath/commit/9f3ab9a))
- **git:** document atomic commit workflow ([fb498bd](https://github.com/Jonnytoshen/haulpath/commit/fb498bd))
- **tooling:** document the release workflow ([08ce718](https://github.com/Jonnytoshen/haulpath/commit/08ce718))
- **tooling:** record release workflow validation ([1180cdc](https://github.com/Jonnytoshen/haulpath/commit/1180cdc))
- **tooling:** align release recovery guidance ([15f93c7](https://github.com/Jonnytoshen/haulpath/commit/15f93c7))
- **ui:** record component and icon requirements ([3355fec](https://github.com/Jonnytoshen/haulpath/commit/3355fec))

### Build System

- **deps:** add pnpm workspace configuration ([70d809e](https://github.com/Jonnytoshen/haulpath/commit/70d809e))
- **git:** enforce angular-style commit messages ([4aee4d1](https://github.com/Jonnytoshen/haulpath/commit/4aee4d1))

### Chores

- initialize repository ([9db103e](https://github.com/Jonnytoshen/haulpath/commit/9db103e))
- ⚠️  rename the project to HaulPath ([8f438d0](https://github.com/Jonnytoshen/haulpath/commit/8f438d0))
- **tooling:** initialize Impeccable product context ([8e16126](https://github.com/Jonnytoshen/haulpath/commit/8e16126))

### Tests

- verify complete local planning workflows ([7510c6e](https://github.com/Jonnytoshen/haulpath/commit/7510c6e))
- **export:** verify complete and stale planning downloads ([10218c3](https://github.com/Jonnytoshen/haulpath/commit/10218c3))
- **point:** cover invalid coordinate conversion responses ([b884c50](https://github.com/Jonnytoshen/haulpath/commit/b884c50))

### ⚠️  Breaking Changes

- rename the project to HaulPath  ([8f438d0](https://github.com/Jonnytoshen/haulpath/commit/8f438d0))
  use HAULPATH configuration and database names
  将运行配置改用 HAULPATH_DB_PATH、测试配置改用 HAULPATH_TEST_MODE，默认数据库文件使用 data/haulpath.sqlite。需要继续使用已有数据时，先停服再将主库及 WAL、SHM 文件整体改为新名称，然后重启服务。

### ❤️ Thank You

- Jonnytoshen