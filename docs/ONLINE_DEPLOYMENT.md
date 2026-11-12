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

可以将 `scripts/deploy/deploy.py` 和同目录的 `private_media.py` 一起上传到服务器后，以 deploy 运行 `python3 deploy.py --check`。
该检查仅验证依赖、配置文件访问、sudo 权限和服务状态，不编译、不备份、不重启。

## 发布步骤和记录

GitHub 上传本次通过测试的确切提交，服务器使用文件锁串行发布。较旧 CI 运行在开始上传时发现
`online` 已前进会跳过；服务器也拒绝用较旧的工作流运行号覆盖已成功发布的新版本。

1. 解包到 `/srv/acerciae/releases/<完整 SHA>-<run ID>-<attempt>`，原生编译并运行后端单元测试及 PDF worker 测试。
   编译和依赖安装期间现有服务保持运行。完整数据库、HTTP/WebSocket 和前端测试由 GitHub CI 执行。
2. 确认历史 SQL 迁移没有被修改或删除，停止 `acerciae-pdf` 和 `acerciae`。
3. 备份数据库、上传文件、两个 env 文件和旧版本记录，校验数据库归档可读取。
4. 原子切换 `current`；如果服务器已准备并启用下述一次性媒体迁移，在服务仍停止时切换媒体引用。
   启动后端和 PDF worker，自动应用 SQL 迁移，检查本机健康接口及两个服务状态。
5. 写入 `/srv/acerciae/release.json`；已启用媒体迁移时清除旧公开原件，再从 GitHub runner 检查公网 HTTPS 健康接口。

切换期间有短暂停机，现有 WebSocket 会断线重连。健康检查成功后自动只保留 3 个 release：
当前运行版本、记录中的上一运行版本，以及按目录时间排序的最新剩余版本。失败的部署不执行清理。
清理与部署共用 `.deploy.lock`，不会跟随发布目录中的上传目录符号链接；旧发布附带的源码压缩包一并删除。
也可以以 deploy 用户运行 `python3 deploy.py --prune`，只清理旧发布，不重启服务。
这里的三版限制仅针对 `releases/`，`backups/` 中的数据库和上传文件备份保持独立，不随发布目录删除。
部署日志在 Actions 中以及 `/srv/acerciae/incoming/<release ID>/deploy.log`。
含密钥的备份目录权限为 700，不上传到 GitHub artifact。

如果备份失败会重新启动旧版本；如果没有新增迁移且新版本启动检查失败，会切回旧版本并重新启动。
如果新增迁移已经开始执行后失败，会停止服务并报错，保留备份，要求管理员确认数据库状态后恢复；
不会擅自用旧二进制连接新 schema，也不会用旧数据库覆盖新版本可能写入的数据。
公网检查失败不会停止已通过本机检查的服务，可修复网络后在 Actions 中重新运行失败 job。

手动恢复前先查看 `deploy.log` 和备份中的 `previous-release.txt`。需要回退数据库时，应由管理员
停止服务、核对 `database.dump` / `uploads.tar.gz` / env 文件来自同一份完整备份，再恢复数据库和上传文件、
切换 `current` 并启动服务。不要仅修改软链接来回退存在不兼容迁移的版本。

## 0060–0062 升级准备与 R2 收口

`scripts/deploy/private_media.py` 从服务器的 `backend.env` 读取数据库和 R2 凭据，密钥不会进入命令行、
仓库或 CI 日志。它只处理私有回放素材、聊天插图、私有音频和旧预打包 ZIP，沿用 `IMAGE_STORE` /
`OBJECT_STORE` 的路由；当前 server-sh 是图片进入私有 R2、音频进入本地 `uploads/objects`。
Python 需要 boto3，数据库操作使用已有的 psql，本地文件目录通过 setfacl 保留 acerciae 服务账号的访问权限。
其他服务器默认不启用此流程。

2026-11-08 已完成 server-sh 的准备并创建 `ARMED`：657 个旧公开对象共 592,531,232 字节，
其中 51 个图片复制到私有 R2、606 个音频复制到本地受控存储。全部原件备份通过 SHA-256 校验，
606 个本地文件均已由 acerciae 服务账号实际读取校验。数据库备份已完整恢复到临时库并演练引用切换及
三个迁移，私有公开键残留为 0，临时库随后删除。准备完成时正式服务仍运行原版本，schema 停留在 0059，业务引用尚未切换；
首次启用迁移钩子的发布会再次执行增量盘点、备份和健康检查。服务器上的 `PREPARED.json` 保存当时的准备记录。

同日已在 CI 部署的新版上通过 `finish` 完成实际切换，并执行 CDN 清理：657 个旧公开原件已删除，
657 个旧 URL 逐个检查均返回 404，旧对象数据库引用为 0，平台健康检查正常。`COMPLETED.json` 保存完成核验、
当前 release 及停机备份路径；`finish.log`、`purge.log` 保存执行日志。准备目录中的对象备份继续保留，
后续 CI 会根据 `RETIRED` 跳过这次已完成的一次性迁移。

准备目录固定为 `/srv/acerciae/upgrades/private-media-v1`，权限 700，部署账号拥有该目录。
`before-preparation/` 保存在线准备前的数据库、上传文件、配置和版本备份；这份在线备份用于排查与演练，
正式切换仍使用 CI 在停止服务后创建的 `backups/before-<release>/` 一致性备份。
`objects/` 保存每个旧公开对象的原始字节，`manifest.json` 记录旧键、新键、目标存储、大小、MIME、ETag 和 SHA-256。
不要在迁移和恢复核验结束前删除这些文件。

旧版运行期间可以重复执行准备命令，它只备份并复制对象、校验内容、登记 90 天清理保护，
不会切换业务引用、删除公开对象或重启服务。准备与 CI 共用 `.deploy.lock`：

```bash
ssh -o ClearAllForwardings=yes server-sh \
  'runuser -u deploy -- python3 -u /srv/acerciae/upgrades/private-media-v1/private_media.py prepare'
```

确认备份和预复制完成后，在准备目录创建 `ARMED` 文件。下一次包含本次部署脚本和三个迁移的 CI 发布
会在停机备份之后补齐新增对象，并在一个数据库事务内更新素材、版本、音频、ZIP、显式发布冻结内容及生成任务输入引用。
只替换 JSON 的 `object_key`，不会改动用户正文。任何未覆盖的存储引用都会使事务回滚。
新版健康检查通过后才删除旧 R2 公开对象，逐项确认原件已消失；`RETIRED` 表示源站处理结束。
预复制的文件和私有桶对象在此之前已经完成内容校验，切换时还会再次核对本地散列和 R2 收据。

引用切换失败会停止服务并保留备份，不能直接重新启动旧版迁移器。旧公开对象清理失败则保留已经健康的新服务，
CI 报错；重新运行同一 CI job 会继续清理，也可在新版上线后以 deploy 执行脚本的 `retire` 命令。
如果 CI 已经部署含 0060–0062 的新版，但发布时未包含本次部署钩子，`purge` 会提示
`Purge only after origin retirement, to prevent cache refills`。这表示尚未完成源站迁移，
不能通过手工创建 `RETIRED` 来跳过。先执行以下恢复命令：

```bash
ssh -o ClearAllForwardings=yes server-sh \
  'runuser -u deploy -- python3 -u /srv/acerciae/upgrades/private-media-v1/private_media.py finish'
```

`finish` 要求新版和三个 SQL 迁移均已上线；它保持当前 release，先在线核验副本，再短暂停止平台服务，
创建 `backups/before-private-media-<时间>/` 一致性备份并切换引用。随后恢复同一新版，健康检查通过后删除旧公开原件。
即使备份或引用切换失败，也会恢复该新版服务；源站清理中断可重复执行 `finish`，已提交引用时不会再次停服。
命令成功后再运行下面的 `purge`。

恢复旧数据库时，应先按清单从 `objects/` 恢复已删除的公开对象，再按上面的停机恢复流程处理数据库和版本。
不得只恢复旧数据库而丢弃对象备份。

R2 的 access key / secret key 可以复制与删除对象，但不能替代 Cloudflare Zone 的缓存清除 API token。
源站清理结束后，脚本生成 `cdn-purge-urls.txt`；缓存清除不自动视为已完成。为 `azertia.org` 创建仅包含
`Zone → Cache Purge → Purge` 权限的 token，把以下内容写入服务器准备目录下权限 600 的 `cloudflare.env`，
文件属主设为 deploy，不要把 token 粘贴到仓库或聊天里：

```dotenv
CLOUDFLARE_ZONE_ID=<azertia.org 的 Zone ID>
CLOUDFLARE_API_TOKEN=<只用于该 Zone 的缓存清除 token>
```

CI 发布成功、`RETIRED` 文件出现之后执行：

```bash
ssh -o ClearAllForwardings=yes server-sh \
  'runuser -u deploy -- python3 -u /srv/acerciae/upgrades/private-media-v1/private_media.py purge'
```

脚本分批清除清单中的精确 URL，失败可重复执行；`CDN_PURGE_ACCEPTED` 仅表示 Cloudflare 接受全部请求。
也可在 Cloudflare 控制台选择 `azertia.org → Caching → Configuration → Purge Cache → Custom Purge → URL`，
分批提交清单。若配置过自定义缓存键，需要按实际缓存键补充清除条件。清除后抽查旧 URL 不再返回文件，
并以有权访问的账号检查新版素材和音频下载；浏览器已缓存或已下载的副本无法召回。
参见 [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) 和
[Cloudflare 单文件缓存清除](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)。

## Cloudflare Pages 与发布 PR

Pages Git 集成的 Production branch 设为 `online`，Root directory 为 `frontend`，Build command 为
`npm run build`，Output directory 为 `dist`。Production 环境变量：

```dotenv
NODE_VERSION=22
VITE_API_BASE=https://trpg.missazertia.com
```

建议关闭其他分支的 Preview builds，正式域名沿用 `trpg-platform.azertia.org`。无需在 GitHub 配置 CF token。

前端的每个页面都有自己的路径（如 `/servers/…/channels/…/windows/…`、`…/gm/settings`，见 `docs/ARCHITECTURE.md`）。
Pages 在 `dist` 顶层没有 `404.html` 时会对未知路径返回 `index.html`，刷新和分享的链接因此可用；不要在 `frontend/public`
里加入 `404.html`。换用其他静态托管时同样需要「未知路径回退到 `index.html`」（自带 nginx 的 `try_files` 已配置）。

给 `online` 设置分支保护：要求 PR、要求 CI 的 `test` 检查成功、禁止强推和删除。
不要把 `Deploy backend` 设为合并前必需检查，因为它只在合并后运行。
GitHub 新建 PR 时选择 **base: online、compare: main**，检查通过后合并；
在 Actions → CI 中查看 `test` → `Deploy backend`，在 Cloudflare Pages 查看前端发布。

官方参考：[GitHub 部署与并发](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、
[Cloudflare Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)。
