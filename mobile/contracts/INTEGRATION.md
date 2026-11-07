# 移动端与后端对接

以 `docs/API.md` 和实际 C++ 实现为准。原生应用使用服务根地址，加 `/api`，安全持久化的 Bearer 会话，禁止凭据跟随 HTTP 重定向。REST 解析允许未知字段，结构化骰子和 Log Studio 使用无损 JSON 容器保留未知字段。示例 fixture 仅供开发测试，不在未登录界面展示，也不是服务端协议。

## 已实现（2026-10-27）

两端已接 auth/login/logout、服务器／频道／窗口列表与消息 GET/POST、50 条分页、角色与属性、场景、文档摘要／全文、高亮、一致性和灵感。服务器维护者的 `is_maintainer` 与频道的 `my_role` 分开判断，服务端仍执行最终授权。服务器开关和语言可以修改；GM 可修改频道 AI、日志云端许可和 TTS 字符预算。最新服务器密钥与策略管理见下方 b865e94 同步说明。

消息作者用 `author_id` 与当前会话用户比较。发言角色只允许本人角色或 GM 操作的 NPC；无角色时玩家发 OOC、GM 发旁白。骰子预览 400ms 防抖，无任何投骰；正式发送走消息接口，保留整个 `dice`，显示 `dice.text`，`hidden_notice` 没有结果时回退公告文字。暗骰和其他小队数据只从服务端过滤后的响应读取。

应用前台通过聊天 WebSocket 接收推送（见下方 2026-11-07 一节），推送断开时每 4 秒自动刷新；回前台立即刷新，后台不轮询也不保持连接。通过上下文版本阻止旧消息请求写回新窗口；切换服务器／频道会立即清空旧数据，草稿按窗口保存在内存，退出全部清除。权限角色、所属角色、player_group_id／player_group_version、知识模式或窗口成员变化时丢弃旧消息缓存并重新取当前可见结果；401 退出，前台轮询遇到 403／404 清理频道内容。手动分页不会触发聊天自动滚到底部。

## 媒体缓存按内容哈希

服务端为每张图片保存 SHA-256，并随引用一起返回：媒体行 `content_hash`，角色空间的 `avatar`/`portrait`/`subtitles` 各带 `hash`，频道角色列表 `avatar_asset_hash`（及 `avatar_asset_version`），消息 `character_avatar_hash`/`author_avatar_hash`，个人资料 `avatar_hash`，视觉小说场景 `background_asset_hash` 与站位 `asset_hash`，氛围 `hashes{variant: hash}`。两端 `bytes(path, query, hash)` 以哈希作为磁盘缓存键（`AssetDiskCache.key`）：同一字节无论由哪个素材、版本或用户展示都只存一份，只有哈希变化或条目过期才会重新下载；每次使用都会刷新条目的 30 天寿命（文件修改时间），超过上限时最久未用的先删。旧对象在首次被服务端提供时才生成哈希，此前以 URL 为键。仍然只缓存服务端标记 `immutable` 的响应。

## 停用（平台管理员）

平台管理员可停用服务器或账号（见 `docs/ADMIN.md`）。被停用账号的请求返回 401，登录返回 `403 account_suspended`，message 含原因，应原样展示并留在登录页。被停用服务器在 `GET /servers` 中仍列出，带 `suspended: true` 与 `suspended_reason`；其频道、消息、角色、日志等请求返回 `403 server_suspended`，客户端应显示原因而不是报错重试。移动端无需管理面板。

## 日志与媒体

移动端使用 `GET /studio/log` 自动汇总单一战役日志；导出 `/studio/log/export?format=json|txt|html|zip`，SealDice JSON 使用 `format=sealdice&chat_window_id=...`，格式 version 105。旧项目和快照接口不再作为移动端导航模型。

视觉小说使用 `/studio/vn-scripts/status` 和 `/studio/vn-scripts`，创建范围为 gm_full、pl_public 或本人角色。模板 base 为 adv/nvl/dossier/cinematic，生成只在用户操作时提交，云端需要明确许可，素材生成默认关闭。任务支持前台轮询与取消。演出经 `/presentations/{id}` 读取、`/cast` 选角、`/tts/estimate` 估算、确认后 `/tts/jobs`；音色可从 `/tts/available-voices` 新建为不绑定角色的 preset，不修改其他人的角色声音。`/bundle.zip` 下载完整离线播放器。

背景／立绘来自 `/media/{id}?v=...`；音频经 `/studio/tts/audio/{id}` 取得认证字节，mock 明确标为示例。阅读位置使用 `/presentations/{id}/progress`；换段／离开页面停止播放。布局仍为原生阅读卡片，高级转场、完整视觉小说模板动画和时间轴编辑留在网页。

角色空间读取 `/characters/{id}/space`，以服务端 editable 控制角色卡／appearance 更新，保存角色卡保留未编辑分组；物品目前只读。素材用 multipart `/assets` 上传 slot、subtitle、file（移动端限制 10 MB，PNG/JPEG），使用系统文件选择器，不索取整个照片库权限。`/assets/generate` 仅由用户明确操作，生成进度可刷新。

玩家仅请求 `/reminders` 与 `/reminders/{id}/context`；不展示内部知识索引或请求 GM 文档。GM 可访问 `/kp/board`、`/script-knowledge` 并修改条目状态。详情每次重取权限过滤后的原文，引用文字高亮。切换分组／角色会重置对应页面及缓存。

阶段通过 `/scenarios/advance`、`/scenarios/enter` 操作整个战役，闭合阶段不可进入；新建 `/scenes` 仅准备。服务器 features.log_studio 和频道 studio_visible 双开关控制入口与读取，关闭时显示说明而不反复发送禁止访问的请求。
日志范围保持原有权限：隔离知识模式下主聊天也可能属于 character audience；公开快照并不必然包含整段主聊天。个人视角快照只供该角色或 GM 读取。客户端不会因公开快照内容少而回退到 GM 全量。

## 布局与未完成项

聊天是主界面，左侧抽屉为屏宽 64%、最大 320 点，支持菜单、边缘拖动及遮罩关闭。角色、阶段、服务器选项、回放和设置都位于抽屉，输入框保留身份／一致性／灵感／发送；考据和提示保持右上角。

待后续完成：上下文流（文档、高亮、提示）的 WebSocket 推送；Keychain／Keystore 会话恢复；服务器与频道创建、成员管理、供应商配置；完整 GM 工作区；演出时间轴编辑、物品编辑、PDF 定制／生成与发布；完整媒体焦点、中断、后台与字幕处理；Android 真机、大字体、平板和横屏验收。旧 MediaPorts 为未来制作能力预留，不表示已提供这些功能。

当前共同工作边界：本聊天仅改 `mobile/`。后端 agent 已提供合并后的 API 与 Log Studio，移动端独立使用 18082 / acerciae_mobile_demo 验证；不修改其后端、网页或 18081 联调服务。运行方法与测试结果见 `mobile/README.md`。


## 新角色卡购点模式

按服务端 `space.points.enabled` 决定角色卡模式，`features.coc7_points` 仅在该键存在时显示管理员开关（新服务器已改为频道选项 `point_buy`，不再返回该键）。未知服务器不请求 `/coc7/rules`，保存服务器 features 保留未知开关。完整 role_card 回传保留 `career{name,choices,specialties}`、`skill_points{skill:{base?,growth,career,hobby}}` 及其他未修改分组。职业数据来自服务器，不在客户端打包职业表。两端独立预览器共用测试 fixture；预览不代替服务器最终授权和重新计算。规则错误只允许 `400 points_rule` 的 message 进入用户提示，限制长度 2000 字；失败不丢弃表单。

默认地址现为 `https://trpg.missazertia.com:15510`，只填写根地址，客户端自行附加 `/api`。未尝试用种子账号登录该域名。购点模式联调使用独立 18083，不影响已有 18082 或其他 agent 的服务。

## b865e94 同步（2026-10-28）

当前对接基准更新为 b865e94。首屏为登录／注册；测试 fixture 不自动展示。会话由 Keychain／Android Keystore 保护，服务地址仅由 ServiceConfiguration 编译常量决定。原文关于未登录演示、内存会话及不可编辑服务器密钥的描述属于早期阶段，现以本节为准。

职业名称、说明、属性公式与技能标签使用 /coc7/rules 的 names／descriptions，按服务器语言显示；提交保留职业标准名与英文技能键。专长限制区分 Biology 与其他 Science 技能，空特长不占数量；玩家的成长点只读，清空职业／兴趣分配保留已有成长点。游戏消息继续自动解析骰子指令，不提供手动 roll 类别。

侧栏的服务器入口支持公开目录搜索、加入、邀请码预览／接受，以及服务器允许时的主聊天旁观。旁观页只读取 /spectate 的已过滤文本，不访问角色媒体、私聊、文档或发言接口。服务器策略决定创建频道与 GM 邀请访客的权限。服务器管理员可管理加入策略、邀请、独立 LLM／图像／TTS 配置与预算；新 API 密钥仅提交给该服务器，留空保留，明确勾选才清除，不保存于本地偏好。

GM 频道设置可控制结团前玩家的 Log Studio 权限、结束／重新开放故事。结团确认说明所有窗口、私语和暗骰的开放范围，额外公开 GM 行默认关闭。日志缓存随故事状态／公开范围／访问状态改变而重建；轮询 403／404 清空失效频道。阶段切换显示目标、地点／故事时间与不可撤销提示。

维护者的所有频道列表使用 /servers/{id}/all-channels。删除频道仅限服务器 owner/admin，删除服务器仅 owner；提交前必须完整输入 Delete Channel 或 Delete Server，GM 身份本身不授予删除权。后端仍执行最终授权。

新版接口回归：先在独立数据库启动 b865e94 本机后端，再执行 ACERCIAE_SYNC_BASE=http://localhost:18084 python3 mobile/scripts/check-current-contract.py。脚本仅允许 loopback，创建并清理自己的临时服务器，覆盖加入策略、访客／旁观、日志开放、邀请撤销、密钥留空／清除／遮蔽和删除权限。不访问正式服务。

## bc9e063 同步与聊天布局（2026-10-29）

自动背景由服务器 `features.atmosphere` 与账号 `atmosphere_enabled` 双开关控制，默认关闭；个人设置经 `/auth/me` 保存，会话恢复和个人资料刷新保留该值。移动端仅显示后端已经生成完成的四图集合，不主动调用图像生成。前台每 30 秒读取 `/channels/{id}/atmosphere`，按应用主题和屏幕方向选择 day/night 与 portrait/landscape，使用专用 Bearer 预览接口 `/atmosphere/assets/{id}`。只在内存保存下采样图片；账号、频道、权限范围改变或关闭后移除，后台停止轮询。图片铺满聊天、标题栏及输入框周围，顶部渐变保持标题可读，文字气泡与输入框保留底色。GM 频道选项提供 `/atmosphere/history`，展示场景、提示词、四幅图的任务状态及失败原因；玩家不请求该历史。

输入区独立选择 narration / ic / ooc，与说话角色分别保存；切换窗口时 GM 默认旁白、玩家默认角色发言。服务端继续自动识别骰子命令，不能手工指定 roll。空白一致性按钮保持禁用。右上角只有「提示」与「灵感」；提示与灵感结果都悬浮于聊天上，详情不弹新窗口，也不遮挡发送栏。灵感需手动插入输入框，不自动发送，并保留已有草稿。

提示遵循网页 ContextBubbleDock 的数据和权限：玩家仅提醒；GM 为剧本下一步、备忘、自己的提醒和文档卡片。文档按当前窗口 active_scene_id 加载 entries，保留状态、版本、高亮及出处；剧本下一步显示行动、前置条件、转折与未公开线索，备忘显示未决线索、时间线、已演阶段和已审阅变更。提醒展开使用 context 原文与逐字引用高亮，版本变化重新加载、撤回自动回到列表。来源可跳转原消息或添加最多五条消息引用，发送携带 reference_ids；接口仍重新检查读取权限。浮层按账号/频道权限范围和窗口重建，禁止跨范围沿用旧内容。

验证使用独立 loopback 18085 / acerciae_mobile_atmosphere_demo 的 mock 后端，不写正式服务器、不产生图像费用。`prepare-atmosphere-demo.py` 准备四图样本；后端 atmosphere 集成测试通过，Swift 与 Kotlin 各 22 项测试通过。iPhone 17 模拟器实际发送三种模式，服务端确认 kind 正确且角色选择保留；确认文档浮层、出处原文及跳转。Android APK 编译与 lint 通过，未连接 Android 真机。

## 2026-10-31 — non-GM-Agent sync through 4501670

The native clients consume the channel `consistency_enabled`, `inspiration_enabled`, and `atmosphere_enabled` switches independently of `ai_enabled`. Server feature flags remain the upper bound. Missing channel fields retain the previous enabled behavior. Channel GM controls and server maintainer controls stay separate; client action guards and atmosphere loading use the same effective feature check. No GM-Agent controls or routes are added.

The server TTS selector now includes OpenAI. Native voice settings use `/studio/tts/status.features` for languages, model choices, accents, delivery instructions, and numeric parameters. Preset creation and existing profile parameter edits use the active provider; casting excludes other providers and clears incompatible selections before estimation. Voice design/cloning and dictionary management are not introduced by this mobile update. No synthesis occurs when opening settings or saving a preset. Generation still follows the existing estimate/confirmation flow. VN playback already consumes `display_text` and respects hidden events, so server-side `script_text` rewrites need no client-side rewriting; raw chat content remains unchanged.

GM channel options now expose text/PDF module imports. Text sends `async:true`; PDF uses authenticated multipart, capped at 25 MB on mobile. The task list distinguishes extraction, structuring, knowledge construction, ready and failed; chunk counts appear only during structuring. Warnings do not hide a ready module. Retry uses the existing source and durable knowledge rebuild sends `async:true`. Polling is scoped to the visible foreground page; leaving it does not cancel server work. The native UI does not infer overall completion from an HTTP success response or a chunk counter.

Character saves compare the latest server `role_card` with the editor's original card before PUT. If automatic investigator growth or another editor changed it, the current draft stays intact and the user can explicitly reload with a discard confirmation. This is a client preflight, not an atomic server revision lock; simultaneous writes still need backend optimistic concurrency to eliminate the final GET/PUT race. Artwork-only refreshes keep card drafts. Pose generation requires a main portrait and sends `subtitles` so the backend can use its transparent PNG pipeline. Scenario growth messages and refreshed character data come from the backend; the client never rerolls growth. Page-only GM citations now show their page even without an excerpt.

User/session DTOs preserve optional `has_avatar`, including accounts whose `avatar_data` is empty after storage migration. Native asset requests retain Authorization headers and the no-redirect policy: current backend contracts return bytes for bearer-authenticated media, while public object URLs are for browser file-token flows. No bearer token is forwarded to a storage host. JSON mutations allow 120 seconds for model work; Android's overall request limit is 125 seconds.

Validation uses the isolated loopback service on port 18086, database `acerciae_mobile_oct31_demo`, and an unmodified `git archive 4501670 backend` build under ignored `mobile/artifacts/oct31-source` / `oct31-build`. `scripts/check-commit-sync.py` checks channel switches, async text/PDF import, duplicate detection, durable rebuilds, OpenAI preset capabilities/parameters without synthesis, and scenario growth. Existing membership/permission checks also pass on this service. Real cloud synthesis, cloud pose generation and R2 network delivery require their configured services and are not exercised by the mock fixture.

## 2026-11-01 — non-GM-Agent sync through 460a8c66

The release service is now `https://trpg.missazertia.com` (443), without an address picker. Saved production sessions from the explicitly migrated same-host HTTPS port 15510 are accepted; arbitrary hosts, HTTP and other ports remain rejected. Clients always construct requests from the compiled root and rewrite the saved endpoint after refresh. HTTPS `/api/health` returned `status: ok`, `db: ok`.

D&D rules come from `/dnd/rules`; the channel's `rule_system` and `point_buy` select its native card editor. Saves use `role_card.dnd`, retaining server-owned live HP/slots/death saves. Initiative `turn` is an entry UUID, not a list offset. Current messages retain server-localized dice text and recognize the D20 `critical` flag, including integer-valued `rolls` arrays. World facts are fetched from `/channels/{ch}/world`; only the GM can declare changes, independently of server administrator permissions, through the existing floating hint panel.

Window summaries supply `unread` and `last_seq`. The client posts `{seq}` to the window `/read` only in the visible foreground chat. Banners are restricted to the main window and actual joined windows, not every private window a GM can inspect. They skip initial history and own messages, clear on scope changes, and reopen messages through the existing permission-aware evidence resolver. Native speech is local, opt-in and stopped on navigation/background/logout; the foreground refresh suppresses backlog narration.

VN creation/retry accepts `retry_failed_chunks`. Job detail provides `background_jobs`, and `/backgrounds/retry` reuses original consent. Presentation owners/GM can request `continue_presentation_id`. Standalone ZIP creation now uses `/presentations/{p}/bundle`, polls caller-scoped `/bundles`, and downloads ready jobs from the fixed `/studio/bundles/{id}/download` route with header authentication. Existing canonical JSON export is byte-preserving and compatible with native log format 2.0. Current character art/version resolution remains server-owned.

Validation: both native builds pass; Swift and Android each pass 27 tests. `check-november-sync.py` exercises the new endpoints on isolated loopback mock service 18087, PostgreSQL 55433. Older `check-commit-sync.py` and `check-current-contract.py` regressions also pass. No production campaign writes or paid model/image/voice calls were made. Browser Kokoro.js, desktop-only file export integrations and all GM-Agent routes remain excluded.

## 2026-11-02 — resilient native channel loading

Initial channel selection now depends only on channel/window access and messages. The 4-second foreground chat refresh checks fresh access metadata before publishing messages. Optional documents/highlights/reminders/settings/characters/scenes run independently at roughly 30-second intervals, preserve authorized cached data on transient errors, clear individual caches on actual API 403/404, and clear all private content on scope changes. Background results are cancelled and checked against both navigation epoch and knowledge scope before publication. Catalog failures can defer that refresh while an already authorized chat continues.

Read-only requests have at most three attempts for selected transient transport errors and 408/502/503/504/520/522/523/524. Mutations/uploads are not replayed. Android cancels the underlying OkHttp call with its coroutine and disables implicit transport retries; iOS uses waitsForConnectivity. Poll failures back off to 30 seconds. Redirects and invalid certificates remain rejected. HTTP error bodies must contain the API's JSON error field before driving authentication/permission handling; edge HTML/text denials are separate gateway errors. Decoder failures are reported as incompatible data rather than network loss.

Run `xcodebuild ... -scheme Acerciae test` for the new AppModel fault-injection target. Core production health probing is opt-in via `ACERCIAE_HEALTH_PROBE=1`; it uses only unauthenticated GET `/api/health`. Validation on November 2: 34 Core tests (including loopback integration and six production health reads), 5 AppModel tests, 33 Android tests, lint and native builds passed. Production account data and Cloudflare settings were not changed by the diagnostic probes.

## 2026-11-07 — 聊天 WebSocket 推送与消息撤回

**推送。** 两端 `ChatSocket`（iOS `AcerciaeCore/ChatSocket.swift`，Android `core/ChatSocket.kt`）只连接聊天流并跟随当前频道：每次连接前 `POST /auth/file-token` 取短期文件令牌放进 `/ws/chat?token=`（会话令牌不进入 URL），连接后发送 `{"type":"subscribe","channel_id"}`，收到 `subscribed` 即为在线；每 25 秒心跳，断开后按 1、2、4、8、15 秒重连并重新取令牌，重连后的每次订阅都会触发一次补齐刷新。推送只负责唤醒：`message.posted`、`window.changed` 等事件让前台循环在 0.25 秒内执行一次原有的刷新流程（权限检查、横幅、朗读、已读都不变）；角色、阶段、服务器设置事件同时触发元数据更新，频道／服务器删除触发目录刷新。推送在线时定时刷新放宽到每 30 秒，离线回到每 4 秒。设置页连接状态显示「已连接 · 实时推送」。上下文流尚未接入，文档和提示仍按约 30 秒刷新。

**撤回。** 作者可在发送后 2 分钟内撤回自己的 ic／ooc／旁白（`POST /channels/{c}/messages/{m}/recall`）；骰子、系统消息与 PbtA 行动记录不能撤回，服务端最终判定（409 `recall_expired`／`not_recallable`）。被撤回的消息保留为墓碑：同一 id、窗口与 seq，正文、骰子与引用清空，带 `recalled_at`；每条消息带 `recall_seconds_left`（不可撤回时为 null）。两端按首次收到时的剩余秒数在本机计时（之后的副本只能缩短不能延长），长按自己的可撤回消息出现「撤回」（iOS 菜单同时提供「复制」，替代此时被占用的文字选择）。`message.recalled` 推送携带墓碑，立即替换聊天中的原消息、移除待发引用与横幅中的该条；没有推送时，常规刷新返回的墓碑同样按 id 替换。气泡位置显示「某某撤回了一条消息」，作者本次会话可「重新编辑」把原文放回输入框。被撤回消息不会进入朗读与横幅，引用卡片显示「这条消息已被撤回」，服务端的未读数、搜索、日志和 AI 记忆均已排除它。

**测试。** 共享 fixture `contracts/fixtures/realtime-events.json` 为真实服务端发出的帧（hello、subscribed、消息、撤回墓碑、窗口变更），两端都解码它。Android 核心测试另用 MockWebServer 的真实 WebSocket 验证文件令牌、订阅、事件、断线重连换新令牌、补齐刷新和切换频道；本次在无 Android SDK 的环境中以纯 JVM 运行 `core` 包测试（51 项通过），`AppViewModel`、Compose 界面和 iOS 代码未能在此编译，需在 Xcode 与 Android Studio 中按下方 README 的命令验证。

本机验收补充：iOS 签名构建、普通 iPhone 模拟器的 AppModel 测试，以及 Android 完整构建、单元测试和 lint 已执行。撤回与刷新并发的回归覆盖旧 GET 返回、待发引用、横幅及离线重启缓存：已知墓碑优先于旧响应，后台删除包含该消息 ID 的页面缓存并阻止之前的请求回写，其他页面与美术缓存保留；常规刷新收到墓碑时同样清理引用。引用原文不在当前窗口时也按已知墓碑隐藏。首次订阅成功立即补拉一次，覆盖首次历史加载与订阅之间的空隙。

Swift 的真实 WebSocket 测试可先运行 `node mobile/scripts/socket-test-server.mjs`（依赖 `tests/integration` 的 npm 包），再运行 `ACERCIAE_SOCKET_TEST_BASE=http://127.0.0.1:18090 swift test --package-path mobile/ios/AcerciaeCore --filter RealtimeTests`。测试只访问本地隔离服务，验证 URLSession 的文件令牌、订阅、真实断线重连、补拉回调与频道切换。浏览器双实例验收使用 `WEB_BASE=<本地 Vite 地址> CHROME_CHANNEL=chrome npm --prefix tests/browser run test:recall`，Vite 通过 `ACERCIAE_API_TARGET` 指向专用测试后端，验证另一客户端实时收到撤回、引用/草稿清理、重新编辑、重载和重连补拉。

