# 移动端与后端对接

以 `docs/API.md` 和实际 C++ 实现为准。原生应用使用服务根地址，加 `/api`，安全持久化的 Bearer 会话，禁止凭据跟随 HTTP 重定向。REST 解析允许未知字段，结构化骰子和 Log Studio 使用无损 JSON 容器保留未知字段。示例 fixture 仅供开发测试，不在未登录界面展示，也不是服务端协议。

## 已实现（2026-10-27）

两端已接 auth/login/logout、服务器／频道／窗口列表与消息 GET/POST、50 条分页、角色与属性、场景、文档摘要／全文、高亮、一致性和灵感。服务器维护者的 `is_maintainer` 与频道的 `my_role` 分开判断，服务端仍执行最终授权。服务器开关和语言可以修改；GM 可修改频道 AI、日志云端许可和 TTS 字符预算。最新服务器密钥与策略管理见下方 b865e94 同步说明。

消息作者用 `author_id` 与当前会话用户比较。发言角色只允许本人角色或 GM 操作的 NPC；无角色时玩家发 OOC、GM 发旁白。骰子预览 400ms 防抖，无任何投骰；正式发送走消息接口，保留整个 `dice`，显示 `dice.text`，`hidden_notice` 没有结果时回退公告文字。暗骰和其他小队数据只从服务端过滤后的响应读取。

应用前台每 4 秒自动刷新，回前台立即刷新，后台不轮询。现阶段使用 REST，WebSocket URL 构建器仍是预留能力。通过上下文版本阻止旧消息请求写回新窗口；切换服务器／频道会立即清空旧数据，草稿按窗口保存在内存，退出全部清除。权限角色、所属角色、player_group_id／player_group_version、知识模式或窗口成员变化时丢弃旧消息缓存并重新取当前可见结果；401 退出，前台轮询遇到 403／404 清理频道内容。手动分页不会触发聊天自动滚到底部。

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

待后续完成：WebSocket 推送与重连；Keychain／Keystore 会话恢复；服务器与频道创建、成员管理、供应商配置；完整 GM 工作区；演出时间轴编辑、物品编辑、PDF 定制／生成与发布；完整媒体焦点、中断、后台与字幕处理；Android 真机、大字体、平板和横屏验收。旧 MediaPorts 为未来制作能力预留，不表示已提供这些功能。

当前共同工作边界：本聊天仅改 `mobile/`。后端 agent 已提供合并后的 API 与 Log Studio，移动端独立使用 18082 / acerciae_mobile_demo 验证；不修改其后端、网页或 18081 联调服务。运行方法与测试结果见 `mobile/README.md`。


## 新角色卡购点模式

按服务端 `space.points.enabled` 决定角色卡模式，`features.coc7_points` 仅在该键存在时显示管理员开关。未知服务器不请求 `/coc7/rules`，保存服务器 features 保留未知开关。完整 role_card 回传保留 `career{name,choices,specialties}`、`skill_points{skill:{base?,growth,career,hobby}}` 及其他未修改分组。职业数据来自服务器，不在客户端打包职业表。两端独立预览器共用测试 fixture；预览不代替服务器最终授权和重新计算。规则错误只允许 `400 points_rule` 的 message 进入用户提示，限制长度 2000 字；失败不丢弃表单。

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
