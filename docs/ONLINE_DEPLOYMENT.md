# online 自动部署

开发代码推送到 `main`，或打开/更新 PR 时，`CI / test` 编译后端、运行完整测试，并生成部署 artifact。
通过 PR 合并到 `online` 后，工作流只下载并上传已测试的产物，不在 runner 或服务器上重新编译。
Cloudflare Pages 独立监听 `online`；它不会等待后端部署完成，所以前后端接口变更需要兼容上一版。

产物名为 `backend-<Git tree SHA>`，包含后端 ELF、运行所需的非 glibc 共享库、数据库迁移、PDF worker
及锁定的生产 npm 依赖。合并提交的 SHA 通常不同于测试提交，因此按完整代码树匹配，并核验构建来源：
必须来自本仓库 `CI` 的成功运行，来源为 `main` push 或 `main → online` 的 PR。PR 产物还核验临时合并提交
的原始 head 父提交和已上线历史中的 base 父提交（不信任会随分支前进而改变的 PR 引用），下载后校验 GitHub artifact digest 与内部 tar 的 SHA-256。PR 构建没有生产密钥。

artifact 保留 30 天；失败、过期、其他仓库/分支、代码树不同或摘要不符的产物不会被部署。
没有匹配产物时部署失败，不会偷偷转为线上编译。先重新运行 `main` 或发布 PR 的 CI，再重跑 `online`
的部署工作流即可。若 `online` 独有修改导致最终树与 `main` 不同，需先把这些修改同步到 `main` 并重新测试，
或使用成功的 PR 合并候选产物。正常流程的必需 `test` 检查包括打包与上传，合并前应等待它全部成功。

## GitHub production 环境

在仓库 Settings → Environments → production 中配置：

- Variables：`DEPLOY_HOST=streamback.missazertia.com`、`DEPLOY_PORT=15500`、`DEPLOY_USER=deploy`、
  `DEPLOY_ROOT=/srv/acerciae`（可省略，默认此路径）。
- Secrets：`DEPLOY_SSH_KEY` 为完整私钥；`DEPLOY_KNOWN_HOSTS` 为核验过的完整主机记录，
  形如 `[streamback.missazertia.com]:15500 ssh-ed25519 AAAA...`。
- Deployment branches：仅允许 `online`。如果希望完全自动发布，不设置 Required reviewers。

密钥不进入仓库，SSH 强制校验主机公钥。服务器无需 GitHub 凭据。

## 服务器一次性配置

现有 `deploy` 账号需要对 `/srv` 的 ACL 读写权限。以管理员身份执行：

```bash
ssh -o ClearAllForwardings=yes server-sh 'bash -s' < scripts/deploy/install-server.sh
```

安装脚本只允许 `deploy` 启停指定的两个应用服务，以及以 postgres 身份导出 `acerciae` 数据库，
不授予通用 sudo。原先位于可写 `/srv` 下的 root 防火墙前置脚本迁移为独立的 root 所有的 systemd 单元，
避免部署账号可以修改 root 启动脚本或给该脚本注入环境变量。安装只执行 daemon-reload，不重启现有应用。

发布机为 Ubuntu 24.04 x86_64，与 CI 构建平台一致，保留系统 glibc、PostgreSQL 客户端、Python 3.12+、
`/opt/node/bin/node`、npm 和 Chromium。应用共享库随产物携带并通过相对 RUNPATH 加载；服务器不再需要
CMake/Ninja/C++ 开发包，也无需在部署时访问 npm registry。CI 使用 Node 22，服务器在切换前仍会用实际
Node 运行 PDF worker 测试，并检查 ELF 动态链接及 `--help`，兼容性失败时不停止当前服务。

可以将 `scripts/deploy/deploy.py` 上传到服务器后，以 deploy 运行 `python3 deploy.py --check`。
该检查仅验证依赖、配置文件访问、sudo 权限和服务状态，不编译、不备份、不重启。

## 发布步骤和记录

GitHub 上传匹配最终代码树的已测试二进制包，服务器使用文件锁串行发布。较旧部署运行在开始上传时发现
`online` 已前进会跳过；服务器也拒绝用较旧的工作流运行号覆盖已成功发布的新版本。

1. 校验包摘要和代码树，解包到 `/srv/acerciae/releases/<完整 SHA>-<run ID>-<attempt>`，验证已编译 ELF 和 PDF worker。
   此阶段现有服务保持运行，不编译、不安装依赖。单元、数据库、HTTP/WebSocket 和前端测试在构建产物前由 CI 执行。
2. 确认历史 SQL 迁移没有被修改或删除，停止 `acerciae-pdf` 和 `acerciae`。
3. 备份数据库、上传文件、两个 env 文件和旧版本记录，校验数据库归档可读取。
4. 原子切换 `current`，启动后端和 PDF worker，检查本机健康接口及两个服务状态。
5. 写入 `/srv/acerciae/release.json`，记录最终提交及原始构建提交、tree、run ID，再从 GitHub runner 检查公网 HTTPS 健康接口。

切换期间有短暂停机，现有 WebSocket 会断线重连。保留所有旧 release 和备份，不自动删除。
部署日志在 Actions 中以及 `/srv/acerciae/incoming/<release ID>/deploy.log`。
含密钥的备份目录权限为 700，不上传到 GitHub artifact。

如果备份失败会重新启动旧版本；如果没有新增迁移且新版本启动检查失败，会切回旧版本并重新启动。
如果新增迁移已经开始执行后失败，会停止服务并报错，保留备份，要求管理员确认数据库状态后恢复；
不会擅自用旧二进制连接新 schema，也不会用旧数据库覆盖新版本可能写入的数据。
公网检查失败不会停止已通过本机检查的服务，可修复网络后在 Actions 中重新运行失败 job。

手动恢复前先查看 `deploy.log` 和备份中的 `previous-release.txt`。需要回退数据库时，应由管理员
停止服务、核对 `database.dump` / `uploads.tar.gz` / env 文件来自同一份完整备份，再恢复数据库和上传文件、
切换 `current` 并启动服务。不要仅修改软链接来回退存在不兼容迁移的版本。

## Cloudflare Pages 与发布 PR

Pages Git 集成的 Production branch 设为 `online`，Root directory 为 `frontend`，Build command 为
`npm run build`，Output directory 为 `dist`。Production 环境变量：

```dotenv
NODE_VERSION=22
VITE_API_BASE=https://trpg.missazertia.com:15510
```

建议关闭其他分支的 Preview builds，正式域名沿用 `trpg-platform.azertia.org`。无需在 GitHub 配置 CF token。

给 `online` 设置分支保护：要求 PR、要求 CI 的 `test` 检查成功、禁止强推和删除。
不要把 `Deploy backend` 设为合并前必需检查，因为它只在合并后运行。
GitHub 新建 PR 时选择 **base: online、compare: main**，检查通过后合并；
合并前在 Actions → CI 查看 `test` 和部署 artifact；合并后查看独立运行的 `Deploy backend`，在 Cloudflare Pages 查看前端发布。

官方参考：[GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[GitHub 部署与并发](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、
[Cloudflare Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)。
