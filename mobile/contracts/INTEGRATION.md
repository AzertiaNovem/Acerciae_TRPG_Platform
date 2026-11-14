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

The native clients consume the channel `consistency_enabled`, `inspiration_enabled`, and `atmosphere_enabled` switches independently of `ai_enabled`. Their server and GM settings also carry the illustrations switches (`features.illustrations`, `illustrations_enabled`; a missing field reads as on), though the apps only show pictures and do not request them. Outfits need no client logic to show: the character list, `character.updated` and each message already report the avatar of the outfit worn (`avatar_asset_id` / `character_avatar_asset_id`; the base one is `base_avatar_asset_id`), and both apps' character pages offer **Wearing** (`PUT …/characters/{id}/outfit`) when the space lists `outfits`. Server feature flags remain the upper bound. Missing channel fields retain the previous enabled behavior. Channel GM controls and server maintainer controls stay separate; client action guards and atmosphere loading use the same effective feature check. No GM-Agent controls or routes are added.

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



## 2026-11-10 — 输入标记、状态摘要、灵感选项与固定消息

**输入标记。** 聊天流上行 `{"type":"typing","channel_id","chat_window_id","character_id","active"}`：只能为自己的角色（GM 可为任意角色）在自己所在的窗口举起；`active:true` 既是举起也是续期，服务器在最后一个包 10 秒后或该连接关闭时放下。下行 `typing.changed {chat_window_id, character_id, active}` 在举起和放下时各发一次（续期不转发，包括写的人自己也会收到），每次 `subscribed` 之后紧跟 `typing.snapshot {typing:[{chat_window_id, character_id}]}`；NPC 的标记只发给 GM。两端的 `TypingSignal` 负责上行（首次编辑举起、4 秒心跳、停顿 8 秒或文本清空时放下、目标变化时先放下旧的），`TypingFlags` 负责下行（快照整体替换；因为续期不转发，本地只保留 10 分钟的兜底超时，不能用几秒的超时判定放下）。输入标记事件不触发消息刷新。连接未订阅时 `ChatSocket.send` 不发送并返回 false，下一次心跳会重新举起。

**状态摘要。** `GET /channels/{id}/characters` 每行的 `vitals`：`coc7e` 为 `{hp, hp_max, san, san_max, dex}`，`dnd2024` 为 `{hp, hp_max, ac, dex}`，`pbta` 为 `{resources:[{id,name,value}], conditions:[{id,name}]}`；数值可为 null。两端 `Vitals.parts` 输出同样的标签与文本，旧服务器没有该字段时不显示这一行。

**灵感。** `POST /channels/{id}/inspiration` 的结果含 `options:[{text, kind, roll, angle}]` 与兼容用的 `draft`（等于第一个选项）；只有 `draft` 的结果按一个选项处理。「换一组」重发请求并附带 `avoid`（已展示过的句子，最多保留 12 条）与 `variant`。手机仍把输入框里的草稿作为 `hint` 发送。

**固定消息。** `POST /channels/{id}/messages/{mid}/pin` 把一条可见消息固定为 `kind:"pinned"` 的提醒（重复固定返回同一条；不可见 404，已撤回 409），`DELETE /channels/{id}/reminders/{rid}` 由固定者或 GM 取消。固定与取消后客户端重新读取 `GET /channels/{id}/reminders`（列表里的行才带 `pinned_by_name`）；别的成员固定的消息随约 30 秒一次的元数据刷新出现。系统消息与已撤回的消息不提供「固定」。

**测试。** `contracts/fixtures/table-status.json` 取自真实服务端（输入标记的三种帧、各规则的 `vitals` 与应显示的文本、一次灵感结果、带固定条目的提醒列表），Android `TableStatusTest` 与 iOS `TableStatusTests` 都读取它；Android `ChatSocketTest` 另外验证 `send` 在真实 WebSocket 上的行为。Android `LiveTableStatusTest` 在设置 `ACERCIAE_TEST_BASE=<本机测试服务地址>` 时用真实的 `BackendClient`／`ChatSocket` 走完举起、回显、放下、快照、连接关闭后放下，以及状态摘要、灵感和固定／取消固定；未设置时跳过。它自行注册账号并建频道，不需要种子数据，只应指向本机的 mock 服务。

## Shared session failure contract

`fixtures/session-errors.json` is read by Web auth, Android core and iOS core regression tests. Only an API-shaped HTTP 401 invalidates the saved session. A gateway's HTML 401, transport loss, 403/404, rate limiting and transient 5xx errors do not revoke identity; individual resource permissions and caches are still rechecked. Each client keeps its native credential storage and retry implementation. `mobile/scripts/test-ios.sh` runs core tests and application tests in a disposable simulator; the mobile workflow and desktop workflow run on relevant pull requests.

`fixtures/client-access.json` is also consumed by all three clients: Studio access (GM/player, feature disabled, hidden, locked, story ended) and persistent-cache eligibility. `no-store` takes precedence over `immutable`; native storage implementations remain independent.


## 2026-11-12 — Daily life passive presence

Messages optionally carry `stand_in`; character rows optionally carry `passive_since`. Android and iOS render a
stand-in label on the character's line (including OOC stand-ins) and a passive-presence label beside the typing mark.
The character owner sees Recall for a stand-in regardless of its author or `recall_seconds_left`; the server retains
its readability, archived-window and move-record checks. `character.updated` refreshes the character list as before.
Absent fields on older servers show neither mark and retain ordinary recall rules. Localizations come from
`localization/mobile.tsv`; `fixtures/passive-presence.json` describes both modern and legacy rows.

## 2026-11-14 — Interactive messages (hypertext)

A channel's GM accounts (bots such as gm-agent) can post an **interactive message** through REST; no composer posts
one. It is a message of kind `hypertext` whose `hypertext` field is a small declarative card (text, checkboxes,
choices, inputs, buttons, rows, groups) with an optional script that runs on the viewer's device when they act. The
format, script API and security model are in `docs/HYPERTEXT.md`; the routes and every error code in `docs/API.md`
(*Interactive messages*). The web and desktop app are the reference and both apps behave exactly like them: the pure
logic in `frontend/src/hypertext/` (`types`, `text`, `format`, `bindings`, `dice`, `effects`), the action pipeline in
`frontend/src/store/hypertext.ts`, the card in `frontend/src/components/HypertextCard.tsx` and its row in
`MessageList.tsx`. The pure logic is ported to Kotlin `core/Hypertext.kt` and Swift `AcerciaeCore/Hypertext.swift`,
where it is tested; the UI only draws what they decide.

**Message rows.** `Message` gains `hypertext` (on kind `hypertext`: the normalized card with its defaults filled in,
plus `closes_at` and the reply stubs `replies: [{id, slots, audience, group}]`; `null` on every other kind and on a
recalled card), `via_hypertext_id`, `via_user_id`, `via_user_name` (on a line a card produced: the card, and who acted;
on a reply the card's sender said, `via_user_id` is not the `author_id`) and `chat_window_id` (every row has it; the
apps did not decode it). Rows also carry `via_interaction_id` and `via_effect`, which the apps do not need. Keep
`hypertext` as raw JSON (Android `JsonObject?`; iOS the existing `JSONValue`, decoded with `JSONDecoder`, never
`JSONSerialization`, whose `NSNumber` passes `0`/`1` as booleans on Darwin; `APIJSON`'s snake-case strategy leaves a
`JSONValue`'s keys as the server spells them, which a typed struct would not) and read it with the `parseDoc` port
when drawing. Its numbers are integers within ±1e9 (iOS formats them with `String(Int64(d))`). Card values compare by
UTF-16 code unit, as JavaScript and Kotlin do; Swift's `String ==` (and so `JSONValue ==` and `Set<String>`) treats
canonically equivalent text as equal (`"\u{E9}"` and `"e\u{301}"`), so the Swift port compares them with
`Hypertext.same`. The history snapshot is re-encoded from decoded rows, so snapshots written before lack these fields:
its key becomes `mobile-history-2` (Android `BackendClient.cachedHistory`/`keepHistory`, iOS `BackendClient.swift`,
`Tests/RefreshTests.swift`).

**Older builds.** An app without this support shows the card's `content` and reads it aloud like any line (read-aloud
skips only `system` and recalled lines). `content` is the GM's fallback text, or one the server builds: the title,
then one line per visible node (`☐ label`, `label: A / B`, `label: ____`, `[label]`, `—`). The card's lines are
ordinary lines there, and its two pushes are unknown types that cause one refresh each.

**Drawing.** The row keeps the sender, the avatar and a pill: kind `hypertext` shows `Interactive message`, never the
raw kind. A line with `via_hypertext_id` shows `↳ via interactive message`, followed by ` · answering {name}`
(`via_user_name`) when `via_user_id` is set and is not the `author_id`; its accessibility description is `Posted from
an interactive message`. `Pins.canPin` is false for the kind (the server answers 409; the card's lines stay pinnable),
read-aloud skips it (Android `AppViewModel`, iOS `AcerciaeApp` speech filters), and recalling a card returns
`content: ""`, so no Re-edit. Card strings are plain text (no markup, links or pictures), each isolated on its own
(U+2068 … U+2069 around it, as the web's `<bdi>`) so it cannot reorder the frame, the pill or a sentence it is placed
in; iOS draws them with `Text(verbatim:)`. Styles come from the app's theme only. What each node shows comes from
`resolve(doc, shownState, lock)` (visible, disabled, text, label, caption, value, options), where the shown state is
the local draft, else the server's state over the defaults (`overlay`). On top of that a control with `on` is disabled
while the engine is unavailable, and a button whose `act` says or replies is disabled once `runs_left` is 0. A button
with a declarative `act.say` shows its caption after `Posts:` (`Posts (out of character):` when `act.say_kind` is
`ooc`). A menu choice with no value shows `Choose…`; `display: menu` on a set is drawn as a list, as on the web. An
input keeps its draft while typing; leaving the field commits it (action `commit`: saved, no handler runs); its button
(`submit_label`, else `Send`) or Enter outside an IME composition submits it (action `submit`). Past the declared `max`
code points it shows `At most {n} characters.` and cannot be submitted, and every input shows `Anything you type here
may be shared in the chat.` under it. Under the card: the `notify()` notes (this viewer only), the outcome sentence,
and a footer with the lock reason's sentence; else `Interactive actions are unavailable on this device.` when a control
has `on` and the engine is unavailable; `Working…` while an action is under way (not while confirming); `Uses left:
{n}` when the card can post (a control with `on`, or an `act` that says or replies), `runs_per_viewer` > 1 and
`runs_left` > 0; `You already used this.` when it can post and `runs_left` is 0. GMs (never in a spectator view) get
`Close` (hint `Stop everyone from using this message`) once the status is loaded, while the card is open, outside fork
history and with the feature available, and a `Script details` box marked `GM only` with the last failure (code,
message, `Line {n}`) and the `log()` lines.

**Lock reasons**, first match wins (`HypertextCard.tsx`); the name in parentheses is the `lock.reason` for `resolve`:
1. spectator view or the demo (`spectator`): "Spectators cannot use interactive messages." Spectators and the demo
   never fetch the status or start the engine; they draw the document with its default state.
2. the card was recalled (`recalled`): "This message was recalled."
3. `message.chat_window_id` is not the open window, i.e. fork history (`history`): "This message belongs to an earlier
   chat window."
4. the feature is unavailable (`closed`): "This server does not support interactive messages yet." (an older server)
   or "Interactive messages are turned off on this server." (`enabled: false`, 403 `feature_disabled`).
5. closed (`closed`): `closed_at` set (status, close or push), the status said `closed`, the status left the card out,
   or `closes_at` has passed (redraw at that moment): "This message is closed."
6. the window is archived (`archived`): "This window is archived."
7. a player whose view of the window is paused (`paused`): "Your participation in this window is paused."
8. a player who is not a member of the window (`not_actor`): "Join this chat window to use this message."
9. a player whose character in the card's window is not in `actors`, compared without case (GMs always may act, and
   a card without `actors` lets everyone act) (`not_actor`): "This message is for other characters."
10. the status has not arrived (`loading`): "Loading…".

**Status.** `GET /api/channels/{c}/hypertext?ids=a,b,…`: comma-separated message ids, at most 100 a request (ask in
chunks and join them; more, or an id that is not a UUID, is 400 `bad_request`; an empty list answers `{enabled: true,
items: []}`). It answers `{enabled, items: [{message_id, closes_at, closed_at, closed, state, version, runs_left}]}` for
the readable, non-recalled cards among them; `state` and `version` are the caller's own (`null` and `0` before their
first save). Ask it (debounced, 150 ms) for each non-recalled card loaded in the open window not asked yet, and for all
of them again when a window is opened and after every `subscribed`. `enabled: false` makes the feature `disabled`. A
card left out is gone (drawn closed). A status adopts the server's state when its version is at least the one held.
If it fails: 405 or any 404 → feature `missing`, 403 `feature_disabled` → `disabled`, anything else → ask again after
5 s, the controls staying "Loading…".

**Saving.** `PUT /api/channels/{c}/messages/{m}/hypertext/state` `{state, base_version}` → `{message_id, state,
version}`. A control with no handler and no `act` (a checkbox, a choice, an input's submit), and an input's commit
whatever its handler, change the draft, saved 500 ms later (debounced per card) with `base_version` = the version held.
While a PUT is on its way the draft is kept even when it equals the server's copy, so a change back is saved after it.
On success the newer server copy is adopted (a draft equal to it is dropped), and a draft made meanwhile is saved at
once unless its own save is due or an action is under way. Saves and actions of one card run one after the other, and
an action takes over a save still waiting for its timer (it carries the state).

**Acting.** `POST /api/channels/{c}/messages/{m}/hypertext/act` `{interaction_id, node, base_version, state, say?:
{text, kind, character_id?, confirmed?}, reply?: {id, slots}}` → `{interaction_id, replayed, partial, results: [{type,
ok, message, error?}], state: {state, version} | null}`. One action per card at a time on a device. `interaction_id` is
a new UUID per action, the same on every retry and on the resend after a confirmation; `base_version` is the version
held when it is sent; `say.character_id` is the character the composer speaks as, sent only when it is not the viewer's
character in the card's window. A script sees `viewer {gm, actor, character}`, `character` being that character's
name. By control:
- A button with `act`: `act()` gives the state and effects, checked with `checkEffects` (on failure: "This message's
  action failed.", and an `invalid_effect` failure for GMs). No effects: save the state at once. Otherwise send it
  without asking (the caption showed the line).
- A control with `on`: while the engine is unavailable show "Interactive actions are unavailable on this device." and
  change nothing. Otherwise show the control's own change and run the engine (below). A failed run reverts with "This
  message's action failed." (failure and logs to GMs). A run with effects while `runs_left` is 0 reverts with "You
  already used this.". Else show its notices and logs and take its state as the draft; with no effects save it at once
  when `changed`. Ask for confirmation when `confirmFor` (recomputed natively) says so, or for any say while the
  server's dice are off (`features.dice === false`; no sheet warning). Cancel reverts and clears the notices. Then send.
- 2xx: put each non-null `results[].message` into the chat (de-duplicated with its push by id), adopt `state` when
  newer, drop the draft, lower a known `runs_left` by one, and say "Part of this action could not be posted." when
  `partial`.
- 428 `confirmation_required` (`text`, `sheet` in the body) on a say not yet confirmed: ask "Post as {name}: {text}"
  (`{name}` the composer's character's name, else the account's display name; for an `ooc` say "Post as {name} (out of
  character): {text}" with the account's name), `{text}` being the body's `text`, else the say's. Add "This changes your
  character sheet." unless `sheet` is `false`. "Post" resends the same body, same `interaction_id`, with
  `say.confirmed: true`; "Cancel" reverts. A `hypertext.closed` push or a reset cancels a pending confirmation.

To revert, the draft goes back to what it was before the action (an unsaved draft is saved again), and the pending flag
and the confirmation are cleared. The other answers of the three routes:

| Answer | PUT state | POST act |
|---|---|---|
| no answer (network), 408, any 5xx; for act also 409 `interaction_in_progress` | again after 0.6, 1.8 and 4.5 s with the draft as it is then; then drop the draft: "Your change could not be saved." | the same body after 0.6, 1.8 and 4.5 s; then revert: "This message's action could not be sent. Check your connection." |
| 405, or a 404 without the API's JSON `error` (a server without the feature) | feature `missing`, drop the draft | feature `missing`, revert |
| 403 `feature_disabled` | feature `disabled`, drop the draft | feature `disabled`, revert |
| 404 with the API's `not_found` (recalled, or no longer readable) | drop the draft, sentence, ask the status again | revert, sentence, ask the status again |
| 409 `state_conflict` (`state`, `version` in the body) | adopt them, drop the draft: "This message changed on another device." | the same, adopting them even at an equal version |
| any other 409 (`hypertext_closed`, `runs_exhausted`, `reply_exhausted`, `interaction_mismatch`, `sender_unavailable`, `conflict` for an archived window) | drop the draft, sentence, ask the status again | revert, sentence, ask the status again |
| anything else (400 `invalid_state`/`invalid_effect`/`invalid_slot`/`no_character`, 403 `forbidden`/`not_an_actor`/`hypertext_command_not_allowed`, 429 `rate_limited`) | drop the draft, sentence | revert, sentence |

The sentence is the catalog's for a known code, else the server's own `message`: `hypertext_closed` "This message is
closed.", `runs_exhausted` "You already used this.", `reply_exhausted` "This answer is no longer available.",
`rate_limited` "Too many actions. Try again in a moment.", `not_an_actor` "This message is for other characters.",
`hypertext_command_not_allowed` "This message cannot post that command for you.", `sender_unavailable` "This message's
sender can no longer answer.", `state_conflict` "This message changed on another device.", `interaction_in_progress`
"An action on this message is still being posted. Try again in a moment.", `feature_disabled` "Interactive messages
are turned off on this server.". A 401 follows the *Shared session failure contract*. Detail fields are merged into
the error body beside `error` and `message` (`state`, `version`, `text`, `sheet`, `retry_after`, `key`), so these
routes keep the parsed body: Android `BackendException.details` (filled only when the body is the API's own JSON; the
exception's message still never holds server text) and iOS `ClientError.refused(status, body)` (thrown by the card
routes only; a 401 stays `.http(401)` and a body that is not the API's stays `.gateway`). The transport still never
replays a mutation: these retries are the pipeline's own, safe because the server replays an `interaction_id` and
checks `base_version`.

**Closing** (GMs). `POST /api/channels/{c}/messages/{m}/hypertext/close` → `{message_id, closes_at, closed_at,
closed_by, closed: true}`; closing again changes nothing. Then set `closed_at`/`closes_at` and cancel a confirmation.
A failure is shown with the server's message; 405, a non-API 404 and 403 `feature_disabled` also mark the feature
unavailable. Everything (cards, timers, confirmations, the engine) is dropped on sign-in or sign-out, a channel switch
and every change of knowledge scope, as the web store's `reset`.

**Pushes.** Captured from a server, at the end of `fixtures/realtime-events.json`:
```json
{"channel_id":"…","message_id":"…","state":{"door":null,"lamp":true},"type":"hypertext.state","version":1}
{"channel_id":"…","closed_at":"2026-11-14T14:25:47.149433+00:00","message_id":"…","type":"hypertext.closed"}
```
`hypertext.state` is the viewer's own complete state of a card after a save or an action on any of their devices, this
one included. It goes to every chat socket of that user, whatever channel the socket follows. `hypertext.closed` goes
to the card's readers subscribed to the channel. Neither carries a `message`. `onPush` already drops frames of another
channel; it applies these two and returns before `pushPending`, since they need no refresh: `hypertext.state` adopts
the state when `version` is higher than the one held (dropping a draft equal to it); `hypertext.closed` sets
`closed_at` and cancels a pending confirmation. Both are ignored for a card not loaded. The card arrives as an ordinary
`message.posted` (the row with its whole `hypertext`, script included; spectators get it without `script`), and so do
the lines it produces.

**Engine host.** Only controls with `on` need it, so it is created lazily on the first run, never for spectators or
the demo, and dropped after 2 minutes idle, in the background and on reset. The page is the committed build
`contracts/hypertext/hypertext-engine.html`, which loads `hypertext-engine.js` beside it (CSP `default-src 'none';
script-src 'self' file: 'wasm-unsafe-eval'; worker-src blob:; base-uri 'none'; form-action 'none'`). Its
`window.MobileHypertext` has `ready` (true once a request can run), `version` (`engine.version` of
`hypertext-client.json`), `start(id, json)` with `take(id)` (the result JSON once the run is done, `null` while it
runs; at most 32 results wait to be taken) and `run(json)` (a Promise of the result JSON). At most 8 requests wait;
more are answered at once with an `engine` failure. A request is `{doc, state, prev, handler, event: {type: change |
submit | click, node, value}, viewer: {gm, actor, character}}`: `doc` the message's `hypertext`, `state` the state after
the control's change (`applyAction`), `prev` the state shown before it (required), `handler` the control's `on`, `event`
the one `applyAction` gives. As on the web, a request is at most 64 KiB (else fail with `invalid_state`, "the action
is too large to run") and so is a result (else `invalid_effect`). A result is `{ok: true, state, effects, notices,
logs, confirm, changed}` or `{ok: false, error: {code, message, line?}, logs?}`, codes `script_error`, `no_handler`,
`budget`, `memory`, `stack`, `timeout`, `invalid_state`, `invalid_effect`, `engine_unavailable`, `engine`. Limits
(`engine.limits`): `interrupt_polls` 50 and `deadline_ms` 500 (checked at each poll), `memory_bytes` 8 MiB,
`stack_bytes` 128 KiB, `output_bytes` 16 KiB, and the wall-clock backstops `timeout_ms` 1000 and `cold_timeout_ms`
5000. The bundle applies the backstops itself: each run goes to a `blob:` worker started from the bundle's own source,
and the page answers `timeout` and replaces the worker when a run passes 1 s (5 s while a new worker starts). Only
where no worker can start does a run happen on the page, and then the native timeout is the only backstop. So the
native timeout must not be shorter than those marks; add a margin (and, on Android, the polling interval) so the
bundle's own answer normally comes first, and count the cold mark from the page's load (a cold WebKit process can take
much longer to start; `LocalStudioEngine` waits 60 s). The page's `ready` stays true once its first worker is ready,
but after it answers `timeout` (it ended the worker) or `engine` (the worker stopped) it starts a new worker, so the
next run is allowed the cold mark again. When the native timeout fires, discard that WebView, fail the run with
`timeout`, and create a new one for the next run.

**Native checks.** The result is checked again in `core` before anything is shown or sent, as `effects.ts` does: at
most 64 KiB (the bundle already held the script's own output to `output_bytes`; its result adds `confirm`, which
repeats the say text, and `changed`, so it may be a little larger), nested at most 16 deep, an object with a boolean
`ok`. A failure keeps a known code (else `script_error`), its message cut to 200 code points, a
positive integer `line`, and at most 20 logs of 200 code points. A success has no other keys than `ok`, `state`,
`effects`, `notices`, `logs`, `confirm`, `changed`; a state with every declared key that passes `validateState`;
effects that pass `checkEffects` (at most one say, ASCII-trimmed, `ic`/`ooc`, 1–500 code points, at most 5 lines, no
control or direction characters, not refused by the dice policy; at most one reply, to a declared stub, with exactly its
slots and allowed values); at most 3 notices of 1–200 code points; at most 20 logs of 200. `confirm` (`confirmFor`:
the dice verdict and `bareRoll`) and `changed` are computed natively, never taken from the page. Anything else fails
the run (`invalid_state` or `invalid_effect`). Without WebAssembly (iOS Lockdown Mode, jitless or old WebViews) every
run answers `engine_unavailable`. The web knows it up front (`typeof WebAssembly`); the apps can ask the loaded page the
same, or take the first `engine_unavailable` as the answer, and keep it for the app session. Then only controls with
`on` are disabled ("Interactive actions are unavailable on this device."); rendering, bindings and declarative `act`
keep working.

**Android sandbox** (`HypertextEngine.kt`, after `StudioEngine` in `LocalStudio.kt` but without its bridge). A hidden
WebView with JavaScript on, `blockNetworkLoads`, no file or content access, no DOM storage or databases. It loads
`https://appassets.androidplatform.net/hypertext-engine.html`; `shouldInterceptRequest` serves only that page and
`hypertext-engine.js` from the APK assets (`sourceSets["main"].assets.srcDir("../../contracts/hypertext")` in
`build.gradle.kts`, as OpenStudio's) and answers 403 to anything else; `shouldOverrideUrlLoading` returns true. No
`addJavascriptInterface`: a run is `evaluateJavascript("MobileHypertext.start(<id>, <json>)")`, then
`MobileHypertext.take(<id>)` polled the same way until it is not `null`, both arguments passed as JSON string literals
as `StudioEngine` does. The callback receives the value JSON-encoded, so the result string arrives as a JSON string
literal to decode once. On a timeout destroy only this WebView and recreate it lazily; never call
`webViewRenderProcess.terminate()`, since the renderer is shared with OpenStudio and the Log Studio viewer. Every
`WebViewClient` in the app overrides `onRenderProcessGone` and returns true, the document viewer's in `LocalStudio.kt`
included; the engine's fails the runs in flight and drops its WebView. The page's own `blob:` worker URL
(`blob:https://appassets.androidplatform.net/…`) is left to the WebView (`HxPageRoute`); it names data the page made,
so it reaches no network. The host's decisions (polling, the warm and cold marks, timeouts, idle and dispose, the
routes) are plain Kotlin in `core/HypertextHost.kt`, unit-tested with a stand-in page (`HypertextHostTest`), and
`HypertextWiringTest` checks the WebView settings in the sources. CI runs no WebView, so the real page is checked
only locally, on a device or emulator, by the instrumented `HypertextEngineSmokeTest` (`src/androidTest`; run
`./gradlew connectedDebugAndroidTest` from `mobile/android`). It runs a `hypertext-client.json` `runs` case with an
`on` button through `hypertextEngine` (the page loads through `shouldInterceptRequest` with network loads blocked),
then a `while(1)` script that answers `budget` or `timeout`, a stuck one that answers `timeout`, and the first case
again, which must still work. A second test checks that the page starts a `blob:` worker and that `fetch` and an image
load are refused.

**iOS sandbox** (`App/HypertextEngine.swift`, `@MainActor`, after `LocalStudioEngine`; its rules and timings are in
`AcerciaeCore/HypertextHost.swift`, `Hypertext.EngineHost`, where they are tested). A hidden `WKWebView` made on the
first run, with `websiteDataStore = .nonPersistent()`, no script message handlers, and a `WKContentRuleList` compiled
once per app session that blocks every load, then lets the engine's `file:` assets and the `blob:` worker it starts
from its own source through: `[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}},
{"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]`. WebKit checks a worker's script load
against the list and `.*` matches a `blob:` URL, so it is named from the start; a `blob:` URL only names data the
page made. The page's CSP blocks the same loads a second time. Both files ship as the folder resource `hypertext/`
(`../contracts/hypertext` in `project.yml`, a folder reference in the committed `Acerciae.xcodeproj`), and the page
is loaded with `loadFileURL(_:allowingReadAccessTo:)` on that folder only. Its navigation delegate allows only that
first main-frame load and cancels every later one. Loading the page and waiting for `MobileHypertext.ready` (a
`callAsyncJavaScript` that polls it every 25 ms) share one 60 s deadline. A run is the completion-handler form of
`callAsyncJavaScript("return String(await MobileHypertext.run(json));", arguments: ["json": request], in: nil,
in: .page)`, one at a time, returning the result string. The host's own backstop per run is 2.5 s while the page is
warm and 8 s for a new page or after a `timeout` or `engine` answer (`EngineHost.runTimeout`), so the bundle's 1 s and
5 s answers normally come first. A host timeout, a page failure or `webViewWebContentProcessDidTerminate` drops the
view and the next run makes a new one; it is also dropped after 2 minutes idle, in the background and on a reset.

**Shared fixtures.** Both ports pass, from `fixtures/hypertext.json`, `dice_policy`, `defaults`, `state_validation`,
`conditions` and `interpolation`, and from `fixtures/hypertext-client.json`, `bindings`, `resolve` (every lock reason),
`act` and `overlay`. Read each section as the file's `about` says: a `state_decl` case is the card `{v: 1, state:
state_decl, body: [{type: divider}]}`, `conditions` put `cond` in its `show_if`, missing state keys take their defaults,
and a `bindings` case's `lock` defaults to `{reason: null}`. `validation`, `fallback` and `templates` are the server's.
The packaged bundle's `hypertext-engine.sha256.json` must match `engine.wasm_sha256`, and the bundle must stay within
`engine.max_bundle_bytes`. The iOS simulator test runs a subset of `runs` through the real WebView, with a probe that
`fetch` and an `<img>` load are blocked, that later navigations are cancelled and that the `blob:` worker starts; the
Android host rests on the same bytes, `mobile/hypertext/engine.test.mjs` (node:vm), `HypertextHostTest` and the
instrumented `HypertextEngineSmokeTest`, run locally on a device or emulator. Android tests read the fixtures from the
test classpath (`getResourceAsStream("hypertext.json")`), AcerciaeCore tests from `#filePath` less five components
(`mobile/`) plus `contracts/fixtures/` (as `ContractTests.swift`). Android `ChatSocketTest` and iOS `RealtimeTests`
decode the two card frames.

**Localization.** Every card string is in `frontend/src/i18n/catalog.json` and is now packaged for both apps by
`mobile/scripts/sync-localizations.py`; no mobile-only rows were needed. The apps' `tr` has no placeholders: translate
the sentence, then replace `{n}`, `{name}` or `{text}` (as `tr("{name} recalled a message").replace(…)` does), keeping
a replaced card or user string isolated.
