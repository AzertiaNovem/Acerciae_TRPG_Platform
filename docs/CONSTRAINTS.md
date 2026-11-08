# 工程约束与维护入口

本文记录实际代码中的数据边界。频道身份以 `AuthService::channelAccess` 查询到的当前成员身份为准；策略函数不替代带频道条件的数据库查询。自由属性编辑和 `.st` 属于合作游戏的正常功能，不是违规入口。外挂 GM Agent 也只使用普通账户的 HTTP / WebSocket 契约。

## 身份与会话

权威数据是 `users`、`sessions`、频道成员关系和部署配置 `PLATFORM_ADMINS`。`AuthService` 负责注册、改名、授权、撤权和短期文件 token；HTTP 公共包装与 WebSocket 都调用它。管理员保留名称不能被注册或通过改名取得，现有管理员也不能通过改名释放名称。文件 token 不可代替普通 API 的 bearer token；会话撤销后不能继续获取私密文件或订阅频道。将部署配置改为不可变用户 ID 需要单独的兼容迁移，本次保留既有配置契约。

客户端只在明确的 401 后清除失效凭据。断网、请求超时和 503 保留凭据并允许重试；旧账号的迟到响应不能恢复旧身份、切换缓存范围或重新连上旧订阅。维护入口是 Web 的 `store/auth.ts`、`api/ws.ts`、原生客户端的会话仓库，以及账号范围的资产/聊天缓存。

正向与失败覆盖：`tests/integration/admin.test.mjs` 的受控管理员、授权和停用；`frontend/tests/auth-bootstrap.test.cjs` 的恢复、401、503、断网与迟到响应；`frontend/tests/token-store.test.cjs`、`desktop-accounts.test.cjs` 的账户存储；`tests/browser/desktop-accounts.mjs` 的账号切换。

## 来源范围与衍生内容

聊天以当前窗口权限、消息可见性、玩家组和组版本为准，由 `Visibility` / `StudioPolicy` 生成带主体条件的查询。快照不是永久权限凭证；读取冻结行仍重新检查当前来源。故事结束沿用已有的角色快照开放规则，GM 全量快照始终不向玩家开放。

素材的 `source_reference.private_presentation_id` 与 `private_chat_window_id` 分别记录回放和聊天派生来源；不能仅靠将 `visibility_scope` 改成 `channel` 抹掉来源。`ContentPolicy.h` 集中读取、共享导出、公开对象和缓存保留的纯判断。`MediaService` 查询当前来源角色所有者后，元数据和文件使用同一规则。素材列表不列出私密派生图；GM 和来源角色当前所有者可读，其他玩家、外部用户、被移除成员不可读。NPC 元数据另行去除提示词，NPC 图不能持久缓存。

`tts_audio_assets.private_source` 记录私密配音来源，预览默认私密；公开和私密合成使用不同缓存键。私密音频与图片都不返回公共地址，响应使用 `no-store`。

`PublicationService` 通过同一素材读取入口组织离线文件，并在发布时另查快照与目标受众。公共分享只接受 `pl_public` 快照和可共享的已批准素材；私密导出不等于公开发布。媒体请求通过权限后才能返回 304、下载内容或对象地址；私密来源不得取得公共对象键或持久缓存资格。旧公开对象与 CDN 缓存的清理步骤见 `OPERATIONS.md`；数据库迁移不能撤回客户端已经取得的副本。

正向与失败覆盖：C++ 单元测试的 content policy 矩阵；`tests/integration/vnscript.test.mjs` 的 GM/角色/另一玩家素材访问与私密导出；`tests/integration/vn-windows.test.mjs`、`window-forks.test.mjs` 的视角；`backend/tests/integration/db_tests.cpp` 的撤权和来源权限；`frontend/tests/asset-cache.test.cjs`、`chat-history.test.cjs` 的账号隔离。

## 编辑、保存与资源持有

Open Log Studio 的内存项目是当前编辑版本，磁盘仅代表最后成功保存的版本。保存队列串行写入，并分别记录编辑与保存版本；正在写旧版本时出现的新编辑必须继续写盘。失败保留内存和待保存状态，显示错误并允许重试。窗口和后台任务分别持有项目；最后一个持有者离开也必须等成功保存后才能驱逐。删除先阻止后续编辑，等待已开始的写入结束，再删除磁盘项目，避免旧写入复活已删除项目。退出时有未保存内容必须提示。

维护入口是 `openstudio/projects.ts`、保存队列、持有关系和 `tasks.ts`。正向与并发/失败覆盖见 `frontend/tests/openstudio-tasks.test.cjs`、`tests/browser/vn-hybrid.mjs`；测试包括保存失败后关闭重开、保存期间继续编辑、重试和后台任务结束。

## 事务与通知

`ChatService::updateChannel` 在写入前解析全部设置，在一个数据库事务内完成频道修改、规则切换和角色旧卡归档，提交后通知。服务内的拆分文件共享同一用例入口，不能把该事务拆成多次提交。错误返回时不得留下部分更新。新增关联写操作也遵循输入校验、事务提交、通知的顺序。

权威状态在数据库，WebSocket 是通知机制而非提交凭证。验证入口是 `backend/tests/integration/db_tests.cpp` 的非法设置回滚与规则转换，以及 `tests/integration` 中频道和规则系统的 HTTP / WebSocket 测试；测试服务启用 `ACERCIAE_STRICT_DB=1` 以发现嵌套事务。

## 任务、恢复与取消

平台 VN 任务由 `VnScriptService` 持有生命周期，数据库中的任务行和分块结果是恢复依据。领取与状态转换带原状态条件，已成功分块可复用，取消、失败和等待答复不能冒充完成；生成素材仍归属于来源回放。PDF 领取使用租约，迟到或重复完成不得覆盖另一租约结果。删除服务负责关联行和存储对象收尾。

外挂 GM 的 `Generation` 负责代际取消，`Table` 决定回合顺序，动作模块使用既有动作标识、API 幂等键与结果核对。恢复记录保留待处理到场和回合状态；玩家代理始终使用自身视角，不借用 GM 上下文。HTTP 客户端负责请求期限和取消传播。

正向与失败覆盖：`tests/integration/vn-retry.test.mjs`、`vn-background-retry.test.mjs`、`logstudio.test.mjs`；`gm-agent/test/recall.test.mjs`、`host-sessions.test.mjs` 与主循环固定夹具；`frontend/tests/openstudio-tasks.test.cjs` 的取消和任务互斥。`scripts/test.sh` 最后还验证测试中创建的全部服务器可以级联删除。

## 接口与测试隔离

模块拆分不改 HTTP 路径、方法、JSON 字段或数据库迁移语义。Web/桌面、iOS、Android 保留各自原生存储实现，依据共同错误分类与权限场景验收。测试账户由受控夹具创建，管理员在配置保留名称前从测试数据库建立。GM 测试启动前清除部署配置变量，并禁用自动读取本机 `.env`；显式 `--env` 仍可用于夹具和正常运行。
