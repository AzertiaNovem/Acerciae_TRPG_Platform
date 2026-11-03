# Acerciae 原生移动端

Android 使用 Kotlin / Jetpack Compose，iOS 使用 SwiftUI，独立于 React 网页。首次打开或退出登录后直接显示登录页，提供手机端注册；不加载示例对话。已有当前服务的登录会话会自动恢复。登录后的主界面为聊天与左侧抽屉，没有底部选项卡。普通直板 iPhone 17 是当前 iOS 验收设备。

服务固定为 `https://trpg.missazertia.com`（HTTPS 443），UI 不提供后端地址或连接配置入口。仅通过修改 `ios/AcerciaeCore/Sources/AcerciaeCore/ServiceConfiguration.swift` 与 `android/app/src/main/java/app/acerciae/mobile/core/ServiceConfiguration.kt` 并重新编译切换服务。旧偏好中的地址不再读取；仅允许同一正式域名从 15510 迁移到 443 时复用原登录；其他地址若不匹配编译配置，会清除该会话，且不会将旧令牌发送到新服务。

## 当前功能

- 登录页可切换注册：用户名格式、至少 6 位密码、确认密码校验；注册成功直接登录并安全保存会话。重复用户名有明确提示；新账号没有服务器时展示邀请说明。

- 自动恢复登录：iOS 钥匙串使用 WhenUnlockedThisDeviceOnly，Android 使用 Keystore AES-GCM 加密令牌、账号与服务地址，私有存储禁止备份；不保存密码。启动后校验会话，断网保留凭据，退出／401 清除本地凭据。服务端令牌到期后仍需重新登录。服务器、频道、窗口按账号权限加载，草稿按窗口分别保留。
- 左右消息气泡按 `author_id` 判断自己；每页 50 条历史、显式发送、失败保留草稿。应用在前台每 4 秒拉取消息、角色、阶段与上下文，每 30 秒同步服务器、频道和权限，回到前台立即更新；设置页也可手动刷新。后台停止轮询，当前尚未连接 WebSocket。频道、最近消息、角色主页、提示和背景信息先从本地磁盘恢复，再后台读取服务器；只读加载不占用全局操作锁。页面数据（64 MB）与已下载的图片、语音（512 MB）按账号和服务分别保存在 iOS Application Support／Android 私有 files 目录，重启后保留，不依赖系统可回收的临时缓存。超出上限先删除最久未用的数据。素材只持久保存服务端标记 `immutable` 且没有 `no-store` 的响应，优先按内容 hash 复用，缺少 hash 时使用带版本的 URL；页面数据是明确允许离线恢复的 GET 响应，不包含登录接口、密码和会话令牌。退出登录清除该账号缓存；确认权限变化会清理页面及素材缓存，并使旧请求的缓存写入失效。iOS 文件受设备数据保护，两个平台均排除系统备份。
- 侧栏可添加频道，创建者自动成为 GM 并获得主聊天窗口；可添加自己的玩家角色，GM 可创建 NPC、为频道成员建卡。新角色直接进入编辑页。
- 原生角色空间：姓名、简介、说话风格及 CoC7 基本资料、属性、状态、技能和背景编辑，物品查看；头像、主立绘、表情素材上传与预览，外观描述与生成任务。
- 全战役阶段管理：准备、立即开启、进入已准备阶段、摘要编辑与自动建议开关；已关闭阶段不能重新进入。切阶段同步所有聊天窗口。
- 右上角考据／提示显示当前分组提醒及聊天出处；玩家不读取知识索引，GM 额外访问文档、KP 下一步看板、待解决线索及剧本知识状态。
- 骰子输入防抖预览与服务端投骰，保留结构化暗骰公告；空白草稿的一致性按钮置灰，灵感需明确采用后才进入输入框。
- 侧栏的「服务器选项」与「频道选项」为独立页面，分别只对服务器管理员和当前频道 GM 显示；服务器管理员身份不自动获得 GM 频道选项。管理员在服务器选项控制骰子／一致性／灵感／日志制作；GM 在频道选项可修改频道名称／介绍、年代、角色知识隔离、骰子回复组、频道 AI、阶段建议、日志可见性、云端许可与配音预算，也可按账号名邀请玩家。供应商密钥仍在网页管理。
- 单一战役日志自动汇总，导出 JSON／TXT／HTML／ZIP；按聊天窗口导出 SealDice v105 JSON。已完成 PDF 可下载。
- 成员按自身权限创建视觉小说：四种模板、可见范围、改编方向、云端确认、可选素材生成、任务进度与取消。已有演出可原生阅读、播放配音、保存阅读位置、下载独立播放 ZIP。
- 演出配音选角、预设音色创建、字符预算估算、明确确认后生成和任务状态。素材与音频通过认证请求获取，文件 URL 不携带令牌。

仍需网页完成高级演出时间轴、PDF 排版／生成、发布管理和服务商配置。物品编辑、完整音频焦点、后台播放、来电中断、字级字幕与演出转场尚未接入。独立图片服务／Anthropic 配置所在 `codex/server-ai-providers` 尚未合入主线，本次没有合并该分支，也没有调用真实付费云服务。

## Android

在 Android Studio 打开 `android/`，使用 JDK 17 或 21、SDK 36、Build Tools 35.0.0。通过 `ANDROID_HOME` 或忽略的 `android/local.properties` 指向 SDK。

```sh
cd mobile/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`，调试包名 `app.acerciae.mobile.debug`。最低 Android 8（API 26）。模拟器访问 Mac 使用 `http://10.0.2.2:8080`，USB 真机通过 `adb reverse` 使用 localhost。Release 只允许 HTTPS；Debug HTTP 仅允许 localhost / 127.0.0.1 / 10.0.2.2。

## iOS

打开 `ios/Acerciae.xcodeproj` 的 Acerciae scheme。最低 iOS 17。新增 App 源文件或调整 `project.yml` 后在 `mobile/ios` 执行 `xcodegen generate`。真机签名 Team 由用户在 Xcode 中设置。

```sh
mobile/scripts/run-ios-demo.sh
swift test --package-path mobile/ios/AcerciaeCore
```

脚本选择兼容普通 iPhone 17 的运行时，构建、安装并启动。到 Xcode Device Hub 选择 `Acerciae iPhone 17`。模拟器使用 localhost，真机使用 HTTPS。

## 本地联调（2026-10-27）

本次独立移动端服务为 `http://localhost:18082`，数据库 `acerciae_mobile_demo` 位于本机 PostgreSQL 的 55432 端口。它使用合并后的后端、全套迁移、种子战役与 mock LLM/TTS/图像；不影响另一 agent 的 18081 或旧的 8080。账号 `alice`（玩家）、`keeper`（GM 和服务器 owner），密码均为种子演示密码 `password`。原生客户端本机联调需在代码的 ServiceConfiguration 中设置本机地址后重新编译 Debug 版本；Android 模拟器使用 `http://10.0.2.2:18082`。发布前恢复正式地址。

```sh
ACERCIAE_TEST_BASE=http://localhost:18082 swift test --package-path mobile/ios/AcerciaeCore
python3 mobile/scripts/smoke-live.py
```

`smoke-live.py` 仅接受本机地址，要求服务为 mock；会向该独立演示战役写入测试投骰、日志项目、快照、演出和 mock 配音。不要用于真实战役。验证包含玩家分队隔离、暗骰、无副作用预览、分页、管理员写入被拒、一致性、草稿不自动发送、个人视角快照隔离、配音下载、阅读进度及四种导出。

当前 Android 构建、11 项单元测试与 lint 通过；Swift 核心 9 项测试含真实接口与图片上传通过，iOS 模拟器构建通过。独立 mock 服务验证了角色卡权限、玩家/KP 隔离、全窗口阶段同步、战役导出、玩家视觉小说、选角与配音估算、独立 ZIP、日志可见性和既有消息／骰子／配音协议。普通 iPhone 17 已操作登录、日志、配音选角和示例配音生成。Android 尚无模拟器镜像或真机，因此没有设备视觉验收；真实云端图像／语音和 PDF 成品也未作端到端验收。

更多边界见 [接口交接说明](contracts/INTEGRATION.md)。

## CoC7 购点角色卡（2026-10-28）

对接 `e630fad`：当频道开启 `point_buy`（主持人在 GM 工作台 → 设置 → 规则中开启；旧服务器为 `features.coc7_points`）时，角色空间按 `space.points.enabled` 加载认证的 `/coc7/rules`，提供可搜索的 230 个职业、职业选项、自由特长、技能基础／成长／职业／兴趣点编辑、困难／极难值和预算预览。保存按钮固定在顶部；超限或规则未加载时不能提交，信用评级警告不阻止保存。关闭模式后回到普通技能总值编辑，保留 career／skill_points 字段。服务器仍重新计算总值，客户端仅把 `points_rule` 错误作为可读校验信息展示，其他错误不暴露服务端内部内容。素材操作不覆盖尚未保存的角色卡草稿。

新版购点测试服务独立使用 `http://localhost:18083` / `acerciae_mobile_points_demo`（55432）。源码为 `git archive e630fad backend`，保存在忽略的 `mobile/artifacts/points-source`；仅将 Coc7Rules.cpp 两个中文左括号查找从字符字面量改为字符串以兼容 Apple Clang，该问题已反馈后端 agent。构建目录 `mobile/artifacts/points-build`；迁移使用该源码的 migrations，不能用旧主线迁移代替。没有修改或合并后端工作树。

```sh
ACERCIAE_TEST_BASE=http://localhost:18082 ACERCIAE_POINTS_BASE=http://localhost:18083 swift test --package-path mobile/ios/AcerciaeCore
```

共享 `contracts/fixtures/point-buy.json` 覆盖预算公式、动态基础值、专长、职业资格、99 上限、兴趣超限和神话限制。Swift 真实接口测试验证 230 职业、保存后服务端预算／技能总值与预览一致、非法分配拒绝且不修改旧卡、关闭开关后数据保留。种子测试凭据只用于本机 mock 服务，不用于默认正式域名。

## 登录与创建验收（2026-10-28）

iPhone 17 模拟器验证了登录后终止并重启仍可恢复会话、创建频道及主聊天窗口、创建角色后直接编辑并保存，以及守密人设置保存。Swift 的 SessionAndCreationTests 使用独立本机 mock 服务验证令牌序列化、恢复认证、退出撤销、频道和角色创建／编辑、邀请已有玩家，以及玩家不能改 GM 设置或创建 NPC。Android 通过编译、单元测试与 lint；尚未在 Android 设备上验证 Keystore 和交互。

移动端使用与网页一致的新无字标图标：iOS `App/Assets.xcassets/AppIcon.appiconset` 由 Xcode 生成设备尺寸；Android 保留不透明 1024 母版，通过 adaptive icon 安全区适配不同桌面遮罩。包含此图标的 Release 版本已使用本地签名更新到连接的 Atlas iPhone，并成功启动。

登录入口与注册验收：iPhone 17 模拟器直接显示登录／注册页，无侧栏、示例聊天和地址输入；Swift 本机 mock 注册往返、重复用户名 409、新用户无战役权限及跨服务令牌隔离测试通过，Android 公共注册请求与会话地址校验测试通过。注册测试仅在独立本机服务进行，未在正式服务创建测试账号。

## 骰子、角色主页与语言（2026-10-28）

聊天投骰与网页使用相同的结果判定顺序：指令单列，成功／失败为绿／红色结果卡，大成功／大失败强调边框；暗骰通知不展示原指令，即使缺少结果文本也不回退到指令。角色入口打开完整角色主页，展示主立绘、头像、简介、说话风格和表情立绘，图片可单独查看，并保留角色卡编辑入口。

聊天头像优先读取角色图像，角色没有头像时使用发言者账户头像，图片不可用时显示首字占位。角色列表及账户设置同样展示真实头像。使用经过认证的媒体和用户头像接口，缩略图仅在内存缓存，并以账户、频道权限范围及头像版本区分；账户资料和头像版本随目录刷新更新。

角色头像请求使用 `avatar_asset_version` 的整数版本；聊天不再把角色更新时间拼进图片版本，也不混用旧消息的图片 hash。频道角色列表刷新后会启动独立的后台队列，先加载全部角色头像，再获取角色空间中的主立绘和表情图。队列一次只传输一项，不占用界面操作锁；角色空间最多每分钟重新检查一次，版本或 hash 改变后加载新图，同 hash 复用账号磁盘缓存。失败请求延后重试，非持久化响应也限制重复预取频率；进入后台、切换频道、退出登录或权限改变时停止队列。预加载仍遵守服务器的 `immutable` / `no-store` 策略，不扩大私密素材的持久保存范围。

界面语言覆盖网页版的 en、zh-CN、zh-TW、ja、ko、es、fr、de、ru、pt、it。登录页可选择本机语言，登录后通过 `PUT /auth/me` 保存并跨端同步 `ui_language`。服务器 AI 输出语言仍为管理员独立设置。只翻译应用界面文字，聊天、骰子回复、角色姓名／资料、剧本文字保持服务器原文。翻译复用网页 catalog，并补充 `contracts/localization/mobile.tsv`；修改后运行 `python3 mobile/scripts/sync-localizations.py`，同时生成两端资源。

两端各 16 项测试通过，包括投骰判定／暗骰通知、头像字段兼容、11 种语言资源完整性及用户内容边界；Swift 本机接口验证所有语言偏好的保存与读取。iPhone 17 模拟器验证中文／英文／日文／法文界面、长文案输入区、骰子卡片、角色图像及聊天头像。Android 构建和 lint 通过，尚无 Android 设备进行视觉验收。图片测试只使用独立本机频道，正式安装包继续使用固定正式服务地址。

## 最新提交同步（2026-10-28，b865e94）

iOS／Android 已同步职业与技能的 11 种语言、专长购点限制和玩家成长点只读。服务器目录／邀请码加入／主聊天只读旁观进入侧栏的服务器页面；服务器设置新增访问策略、邀请、服务商与 AI 预算、频道管理，GM 频道设置新增玩家日志权限与结团／重开故事。删除入口按服务器身份限制，必须输入完整确认短语。日志与失效频道的缓存随权限变化清理。

两端各 19 项测试通过，Android assembleDebug／lintDebug、iOS 模拟器 Debug／真机 Release 编译通过。新增本机接口回归使用 b865e94、独立数据库 acerciae_mobile_sync_demo、18084 端口及 mock 配置，测试自己的临时资源后清理。普通 iPhone 17 模拟器检查了访问策略布局与删除确认禁用状态；Android 尚无设备进行界面验收。发布构建继续固定连接 https://trpg.missazertia.com:15510。

这次 Release 已通过本地签名校验并安装到 Atlas iPhone（app.acerciae.mobile）；正式服务版本也已安装并打开到 iPhone 17 模拟器的中文登录页。Android APK 位于 android/app/build/outputs/apk/debug/app-debug.apk。
真机自动启动返回 CoreDevice remoteService XPC 连接不可用；安装已成功，尚未验证此次版本的真机启动，需在手机上手动打开。模拟器启动与登录页显示正常。

## 自动背景与提示浮层（2026-10-29）

客户端已跟进后端 bc9e063：服务器开启「频道氛围背景」，用户在个人设置开启显示后，聊天使用服务器自动生成的背景。图片覆盖标题和输入框周围，顶部渐变过渡；GM 可在频道选项查背景历史。输入区支持旁白、角色发言、OOC 三种独立模式；右上角「提示」合并网页泡泡的信息，「灵感」与它并列，展开内容均浮在聊天上。

本机背景验证（仅 loopback、mock 服务）可执行 `python3 mobile/scripts/prepare-atmosphere-demo.py`；再使用 `ACERCIAE_TEST_BASE=http://localhost:18082 ACERCIAE_POINTS_BASE=http://localhost:18083 ACERCIAE_ATMOSPHERE_BASE=http://localhost:18085 swift test --package-path mobile/ios/AcerciaeCore`。两端当前各 22 项测试通过，Android assembleDebug / lintDebug 通过。测试图片明确标为模拟背景，正式安装包继续固定连接 `https://trpg.missazertia.com:15510`。

本次签名 Release 构建及 codesign 校验已通过。模拟器和 Atlas iPhone 真机均已安装正式地址版本；2026-10-29 重新连接数据线后，devicectl 确认安装成功并成功启动 app.acerciae.mobile。

## 2026-10-31 移动端同步（不含 GM-Agent）

跟进至 `4501670` 的非 GM-Agent 提交：频道一致性/灵感/背景独立开关、OpenAI 配音服务及按能力呈现的预设音色编辑、GM 的文本/PDF 异步模组导入和任务重试/知识重建、自动成长后的角色卡保存冲突提示、透明背景表情立绘入口、页码引用和对象存储头像兼容。模组与音色入口位于频道选项；服务器服务商配置仍仅在管理员的服务器选项。正式后端地址不变，首次启动仍要求登录。

本机新版联调使用 `http://localhost:18086`，数据库 `acerciae_mobile_oct31_demo`。新接口验证可运行 `python3 mobile/scripts/check-commit-sync.py`；权限回归可运行 `ACERCIAE_SYNC_BASE=http://localhost:18086 python3 mobile/scripts/check-current-contract.py`。完整 Swift 测试使用 `ACERCIAE_TEST_BASE=http://localhost:18086 ACERCIAE_POINTS_BASE=http://localhost:18086 ACERCIAE_ATMOSPHERE_BASE=http://localhost:18086 swift test --package-path mobile/ios/AcerciaeCore`，先运行 `ACERCIAE_ATMOSPHERE_BASE=http://localhost:18086 python3 mobile/scripts/prepare-atmosphere-demo.py` 准备 mock 背景。测试脚本只允许 loopback 服务。

标准 iPhone 17 模拟器已验证登录、GM 频道设置、文本导入和 OpenAI 能力表单；设备键盘捕获保持关闭。Swift 25 项（含本地接口）通过，Android 25 项单元测试及 assembleDebug/lintDebug 通过。配音设置不触发真实合成，云端出图和 R2 实际网络链路未进行付费或生产写入验证。

2026-10-31 正式 Release 已通过本地账户签名验证，并安装到 Atlas iPhone（`00008150-0010793A26D8401C`）。Android 安装包为 `android/app/build/outputs/apk/debug/app-debug.apk`。安装包继续使用固定正式后端；本地 mock 联调地址只用于独立的模拟器验证构建。

安装后的自动启动被 iPhone 锁屏拒绝（CoreDevice `Locked`）；安装本身成功，解锁后可手动打开 Acerciae。

## 2026-11-01 移动端同步（至 460a8c66，不含 GM-Agent）

已拉取远端，恢复并保留此前未提交的移动端更新。双端新增 D&D 2024/SRD 5.2 角色卡、频道规则和频道级购点开关、先攻顺序及 D20 暴击显示；角色构筑与当前 HP/法术位仍由后端区分保存。服务器管理员选项不再提供旧的 CoC 全服务器购点开关。

聊天侧栏显示服务器返回的未读数；前台其他已加入窗口的新消息以可展开横幅提示，跳转重新检查权限。实际显示聊天时才上报已读，切到其他页面或后台不会清除未读。新增系统语音朗读，默认关闭，只读当前聊天的新消息；切换页面或进入后台停止，恢复前台不补读旧消息。世界现状、近期变化和 GM 宣告位于聊天“提示”浮层。

视觉小说新增续写、失败脚本重试、缺失背景重试及后台 ZIP 打包下载，保留服务端进度和当前角色素材版本。文件下载使用同源固定路径与 Bearer 认证，不转发令牌到打包结果中的任意 URL。增加缓存词元用量，打包最新网页语言目录和移动端补充翻译，共 1650 条、11 种语言。GM-Agent 和浏览器专用 Kokoro.js 不在原生实现范围内；手机朗读使用系统已有语音。本地 Open Log Studio 已另行接入，见下方说明。

正式默认地址已按用户要求从 15510 改为 `https://trpg.missazertia.com`（HTTPS 443），健康检查正常。仅为这个明确迁移的同域服务复用旧端口登录，其他主机、HTTP 和任意端口仍拒绝迁移；下次刷新将凭据写回当前地址。UI 仍不提供地址配置。

验证服务使用本地 `18087`、独立 PostgreSQL `55433` / `acerciae_mobile_nov01_demo`，源码归档在忽略的 `artifacts/nov01-source`，模型与图像均为 mock。`ACERCIAE_SYNC_BASE=http://localhost:18087 python3 mobile/scripts/check-november-sync.py` 验证 D&D 构筑/实时 HP、先攻权限、未读单调标记、世界宣告、VN 续写和后台 ZIP 下载；此前两组导入/权限回归也通过。Swift 27 项（含本地接口）、Android 27 项及 lintDebug/assembleDebug 通过。标准 iPhone 17 模拟器检查了登录、半屏侧栏未读和 D&D 角色编辑，键盘捕获关闭。正式签名包已安装并启动于 Atlas iPhone。真实云端生成、对象存储外网链路及安卓真机 UI 尚未在本次验证。

## 2026-11-02 正式服务连接与刷新修复

登录/选频道原先必须等角色、场景等辅助接口全部成功，随后每轮又串行等待最多九项接口，最后才发布聊天数据；任意辅助请求出错都可能被显示为“连接失败”。现在先验证频道/窗口权限并加载聊天，辅助信息约每 30 秒独立更新，失败保留仍有权限的缓存；首次进入频道不再等待辅助接口。权限或知识分区变更仍立即清除旧内容，后台任务带频道/权限范围检查，切换频道或进入后台取消。

原生请求统一标明 Acerciae 客户端身份。只对 GET/HEAD 的暂时网络错误和网关 5xx/超时进行最多两次重试；POST/PUT/DELETE 和上传不自动重放。轮询失败后逐步延后至最多 30 秒，避免弱网连续轰炸。Android 的协程取消会取消实际 HTTP 请求；iOS 使用可等待联网的会话。TLS 校验和拒绝重定向策略不变。

入口返回的 HTML/纯文本 401/403 不再被当成后端账号失效或频道权限变化；只有符合后端 JSON 错误结构的响应才执行这类处理。数据解码失败、网络中断、超时和安全连接错误分别提示。排查时普通 Python UA 收到 Cloudflare 1010，原生/明确客户端标识的健康请求返回 200；这是入口存在客户端差异的证据，不足以证明手机的每次失败都来自 Cloudflare，未修改线上防火墙配置。

验证：Swift Core 34 项（包含显式启用的 6 次正式 HTTPS 健康请求，以及 loopback 接口回归）、iPhone 17 模拟器 AppModel 故障注入 5 项、Android 33 项和 lint 均通过。新增用例验证连续 503 不阻断首次进入聊天、辅助权限撤销仅清除对应缓存、权限变化后即使消息失败也不保留旧私密数据、只读重试上限、写请求不重放、取消和入口错误分类。正式地址仍为 HTTPS 443。

### 持久缓存与后台更新（2026-11-02）

媒体磁盘缓存按内容哈希存放：服务端随每个图片引用返回其 SHA-256（`content_hash`、`hash`、`avatar_asset_hash`、`character_avatar_hash`/`author_avatar_hash`、`avatar_hash`、`background_asset_hash`/`asset_hash`、氛围 `hashes`），两端 `bytes(path, query, hash)` 以 `sha:<hash>` 为键（`AssetDiskCache.key`）。同一字节无论由哪个素材、版本或用户展示都只存一份；只有哈希变化或条目过期才重新下载；每次使用刷新条目的 30 天寿命，超过容量上限时最久未用的先删，过期条目在进程首次读取缓存时清理。没有哈希的旧对象在服务端首次提供后获得哈希，此前仍以 URL 为键。仍然只缓存服务端标记 `immutable` 的响应。

打开已浏览的频道和角色时先显示磁盘数据；回到前台继续按原周期向服务器核对。刷新期间可以切换聊天和编辑草稿，旧频道请求不会覆盖新频道。角色卡后台更新保留用户已经修改的字段与原始版本，保存时仍向服务器重新核对冲突；注册、发消息和其他写操作没有离线队列。缓存未命中的首次访问仍需要网络。

相同素材的并发下载合并为一次请求，旧缓存目录自动迁移到持久目录；Swift 的磁盘读取和大图缩略解码移出界面线程。头像、立绘和背景以版本寻址，背景的临时刷新失败不会清空已显示的图片。数据不设时间到期清理，受容量限制、退出登录与权限撤销约束。

验证：Swift Core 35 项通过（另 6 项需独立测试服务／显式启用的集成测试未运行）；iPhone 17 模拟器 AppModel 7 项、Android 单元测试 38 项与 lint 通过；iOS Release 真机签名构建通过。新增覆盖跨客户端重启、账号隔离、慢 GET 下显示缓存与保留输入、素材并发下载合并、版本区分、旧目录迁移、权限拒绝及乱序／失效请求不得回填缓存。

### 手机本地 Open Log Studio（2026-11-03）

登录页和侧栏提供独立入口，无需账号。原生项目列表与编辑表单支持导入／补充 SealDice、QQ、Acerciae 日志，复用网页核心的编码识别、去重、角色整理和平台 ID 清理；编辑标题、背景、人物名称／归属／外貌、头像和主立绘，并上传统一背景图。已有角色卡与其他项目字段保留在作品中。

作品保存在 iOS Application Support/OpenLogStudio/projects 或 Android files/OpenLogStudio/projects，与聊天缓存和账号隔离，不受缓存过期／容量清理或退出登录影响。编辑自动保存，关闭工作室及应用进入后台时刷新保存。删除必须在项目列表确认。文件导入总量最多 32 MiB、作品最多 30,000 条消息、图片总量约 20 MiB；上传图片降采样至约 1920 像素。卸载或换设备前可导出完整作品备份，在另一部手机导入恢复；备份含所有消息与本地图片，新导入会生成独立项目 ID。

提供自包含 HTML 日志、A5 PDF（iOS 原生分页生成 PDF；Android 系统打印／另存 PDF）、Acerciae JSON、纯文本，以及规则编排的离线视觉小说播放与 HTML 导出。普通导出默认不含 OOC／私密消息，包含开关作用于日志、PDF、小说、JSON 和文本；完整作品备份始终保留原始内容。生成的预览没有原生桥接，禁止联网，导入的远端图片链接不会自动下载。字体与分页使用设备引擎，可能与桌面印刷结果不同。

离线功能无需 AI 服务；AI 剧本编排、追问与续写现已接入，见下节。图片生成、Qwen 配音和视频编码尚未接入。工作室与当前频道的服务器 Log Studio 及 GM 权限独立；共享项目数据从原生层交给随包离线引擎，不把聊天令牌或其他密钥传入网页。

共享入口为 `mobile/openstudio/engine.ts`。修改共享日志核心后执行 `node mobile/scripts/build-openstudio.mjs`（先安装 frontend 依赖）更新两个平台共用的 `contracts/openstudio` 静态包；`node --test mobile/openstudio/engine.test.mjs` 验证实际打包文件。Swift App 测试还覆盖真实 WKWebView 执行和多页 PDF 输出，两端存储测试验证重启、缓存隔离与路径约束。

### 手机 AI 剧本编辑（2026-11-03）

在本地作品的「AI 剧本编辑 → AI 服务」填写自备服务的 HTTPS 基地址（包含服务要求的 `/v1` 等前缀）、模型和 API 密钥，支持 OpenAI 兼容 Chat Completions 和 Anthropic Messages。该地址只用于独立 AI 服务，聊天后端仍固定为正式域名。配置由 iOS Keychain／Android Keystore 加密保存，与账号缓存隔离；作品、备份、日志预览和打包引擎均不接收密钥。原生 HTTP 不跟随重定向，不向其他地址转发认证信息。

「AI 编排／改写」调用最新共享编排器，保留原始日志；现有剧本在新任务成功前保留。模型提出的问题、引用原文、备选答案及自由输入显示在原生表单，回答自动存盘。可回答后继续，也可勾选保留某一段草稿；全部选择保留时可离线完成。完成部分不重新请求，已保存的剧本用于预览和小说导出，并可查看改写／删减原因与编排提示。补充日志后可从原结尾续写，已有场景和改写保留。

切至后台或点击暂停会中断在途请求，在前台选择「继续未完成任务」恢复。已经收取并保存的回答会复用；服务已处理但尚未收到或保存的在途请求可能需要再次发送。作品或服务变更时拒绝复用旧任务，需放弃任务再开始。追问草稿及任务恢复记录随作品备份保留，API 密钥不随备份迁移。若 AI 剧本的输入含私密消息，分享该小说前需检查剧本并显式勾选包含私密消息，避免改写混入私密上下文。

测试使用本地模拟的 AI 响应，无真实服务付费请求。共享引擎覆盖改写、追问备份恢复、选项回答、保留草稿、续写追问、分段恢复、源数据变更拒绝、Anthropic 签名块重放与 400 文本回退、私密上下文边界；两端测试验证原生认证头与 HTTPS 地址约束，iOS 另验证实际 WKWebView 中的追问和草稿恢复。
