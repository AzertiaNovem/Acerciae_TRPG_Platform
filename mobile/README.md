# Acerciae 原生移动端

Android 使用 Kotlin / Jetpack Compose，iOS 使用 SwiftUI，独立于 React 网页。首次打开或退出登录后直接显示登录页，提供手机端注册；不加载示例对话。已有当前服务的登录会话会自动恢复。登录后的主界面为聊天与左侧抽屉，没有底部选项卡。普通直板 iPhone 17 是当前 iOS 验收设备。

服务固定为 `https://trpg.missazertia.com:15510`，UI 不提供后端地址或连接配置入口。仅通过修改 `ios/AcerciaeCore/Sources/AcerciaeCore/ServiceConfiguration.swift` 与 `android/app/src/main/java/app/acerciae/mobile/core/ServiceConfiguration.kt` 并重新编译切换服务。旧偏好中的地址不再读取；保存会话的地址若不匹配编译配置，会清除该会话，且不会将旧令牌发送到新服务。

## 当前功能

- 登录页可切换注册：用户名格式、至少 6 位密码、确认密码校验；注册成功直接登录并安全保存会话。重复用户名有明确提示；新账号没有服务器时展示邀请说明。

- 自动恢复登录：iOS 钥匙串使用 WhenUnlockedThisDeviceOnly，Android 使用 Keystore AES-GCM 加密令牌、账号与服务地址，私有存储禁止备份；不保存密码。启动后校验会话，断网保留凭据，退出／401 清除本地凭据。服务端令牌到期后仍需重新登录。服务器、频道、窗口按账号权限加载，草稿按窗口分别保留。
- 左右消息气泡按 `author_id` 判断自己；每页 50 条历史、显式发送、失败保留草稿。应用在前台每 4 秒拉取消息、角色、阶段与上下文，每 30 秒同步服务器、频道和权限，回到前台立即更新；设置页也可手动刷新。后台停止轮询，当前尚未连接 WebSocket。战役内容只缓存在内存，不把 GM 私密资料写入磁盘。
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

对接 `e630fad`：当服务器 `features.coc7_points` 启用时，角色空间按 `space.points.enabled` 加载认证的 `/coc7/rules`，提供可搜索的 230 个职业、职业选项、自由特长、技能基础／成长／职业／兴趣点编辑、困难／极难值和预算预览。保存按钮固定在顶部；超限或规则未加载时不能提交，信用评级警告不阻止保存。关闭模式后回到普通技能总值编辑，保留 career／skill_points 字段。服务器仍重新计算总值，客户端仅把 `points_rule` 错误作为可读校验信息展示，其他错误不暴露服务端内部内容。素材操作不覆盖尚未保存的角色卡草稿。

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
