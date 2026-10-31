# online 自动部署

开发代码推送到 `main`，通过 PR 合并到 `online` 后发布。现有 `CI` 工作流先运行 `test`，
只有 `push` 到 `online` 且测试成功，才执行 `Deploy backend`。`main` 的 push 和所有 PR 都只测试。
Cloudflare Pages 独立监听 `online`；它不会等待后端部署完成，所以前后端接口变更需要兼容上一版。

部署只上传 `backend` 和 `pdf-worker` 的 Git 源码归档，不包含构建产物、共享库或 `node_modules`。
不再生成或下载部署 artifact；服务器编译成功后才切换服务，部署任务超时为 60 分钟。

## 编译缓存

CI 和服务器均使用 ccache 复用未变化的 C++ 编译结果。CI 用 GitHub Actions cache 保存缓存，
服务器使用 `/srv/acerciae/cache/ccache`，各自上限为 1 GB。不同 release 的源码路径会归一化，
避免仅因目录中的提交 SHA 改变而全部失去缓存命中；编译器、编译选项、源文件和头文件变化仍会使相关结果失效。

每个 release 仍有独立的 build 目录和二进制，继续执行链接、测试、备份和健康检查。
这不是复用旧版可执行文件。第一次建立缓存仍会完整编译，后续改动较少时收益最大；
删除缓存只会使下一次编译变慢，不影响运行中的 release。命中统计会打印在构建日志中。

服务器首次安装（无需重启应用）：

```bash
sudo apt-get install --no-install-recommends ccache
```

部署账号需要能写入上述缓存目录。未安装 ccache 的服务器会在日志中提示并退回普通编译，
不会因此阻断部署。参考 [ccache 的跨目录缓存说明](https://ccache.dev/manual/latest.html#_compiling_in_different_directories)。

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

发布机需要现有的 CMake/Ninja/C++ 依赖、PostgreSQL 客户端、Python 3.12+、`/opt/node/bin/node` 和 npm。
实际生产 Node 版本沿用服务器配置；CI 使用 Node 22，发布时也会在服务器上运行 PDF worker 测试。
发布时需要服务器能够访问 npm registry；Chromium 沿用现有安装。

可以将 `scripts/deploy/deploy.py` 上传到服务器后，以 deploy 运行 `python3 deploy.py --check`。
该检查仅验证依赖、配置文件访问、sudo 权限和服务状态，不编译、不备份、不重启。

## 发布步骤和记录

GitHub 上传本次通过测试的确切提交，服务器使用文件锁串行发布。较旧 CI 运行在开始上传时发现
`online` 已前进会跳过；服务器也拒绝用较旧的工作流运行号覆盖已成功发布的新版本。

1. 解包到 `/srv/acerciae/releases/<完整 SHA>-<run ID>-<attempt>`，原生编译并运行后端单元测试及 PDF worker 测试。
   编译和依赖安装期间现有服务保持运行。完整数据库、HTTP/WebSocket 和前端测试由 GitHub CI 执行。
2. 确认历史 SQL 迁移没有被修改或删除，停止 `acerciae-pdf` 和 `acerciae`。
3. 备份数据库、上传文件、两个 env 文件和旧版本记录，校验数据库归档可读取。
4. 原子切换 `current`，启动后端和 PDF worker，检查本机健康接口及两个服务状态。
5. 写入 `/srv/acerciae/release.json`，再从 GitHub runner 检查公网 HTTPS 健康接口。

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
在 Actions → CI 中查看 `test` → `Deploy backend`，在 Cloudflare Pages 查看前端发布。

官方参考：[GitHub 部署与并发](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、
[Cloudflare Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)。
