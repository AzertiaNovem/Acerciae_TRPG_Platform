# PbtA 频道

创建频道时选择 **Powered by the Apocalypse (PbtA)**，或在已有频道的 GM 工作台设置中切换。新频道自带原创的「边境调查」规则包。网页和桌面端可以制作角色卡、使用动作和编辑规则，手机端可以阅读聊天中的裁定。

打开角色卡，选「巡界员」或「抄录师」，填入属性，保存。展开「冒险搜查」可以先读触发条件和各档结果。叙述自己的行动后，点击动作按钮将结果发往按钮标出的聊天窗口，或在聊天输入 `.move search +1`。此次修正只作用于这一掷。免骰动作如 `.move compare` 直接展示说明。玩家和 GM 按结果原文作出选择，再在角色卡上标记经验、资源或状态。

GM 在工作台的「设置 → 规则 → 规则包」中编辑本频道的规则。一个动作可以属于所有角色，也可以专属于一本手册。选择属性后，为每个结果档填写裁定和可选代价。选择免骰时，将效果写在触发说明里。GM 参考动作只有 GM 可查阅。导入 JSON 会先打开预览，点击「保存规则包」才会替换本频道的规则。如果其他 GM 已经保存过更新，重新加载最新版本后再编辑。导出文件包含 GM 私有参考。

切换到其他规则（或从其他规则切换到 PbtA）时，角色的故事部分（姓名、基本信息、背景、物品和外貌）保留，原规则的数值连同骰子数值存为只读的「旧角色卡」，角色卡按新规则重新建立，玩家会在聊天和角色卡上收到重建提示；之后可在角色卡上把同一规则的旧卡「重新使用」，前提是它仍符合当前规则包。详见 [切换规则](DND_2024.md#switching-the-rule-system)。

角色数据使用定义的 ID。修改显示名称会保留原有数值。删除仍在使用的定义时，提示会列出相关角色。历史聊天和记录工作室快照保留掷骰时的版本、结果说明和骰面，可按原裁定回看。

## 让 GM agent 主持

在网页或桌面端预建频道后，到「GM 工作台 → 设置」选好 PbtA，并让 agent 账号担任该频道的 GM。然后在 `gm-agent` 目录运行：

```sh
node src/cli.mjs run --channel <频道ID> --world world.md --coplayers 2
```

首次接入时，agent 在原频道起草规则，等你在「设置 → 规则包」启用草案或沿用当前规则，再建卡并开始主持。审核期间可以关闭进程；保留原状态目录，再用同一频道 ID 运行即可继续。省略 `--world` 会使用频道当前规则。需要更换规则体系时，在工作台手动切换。

也可以让命令行新建频道。在 `gm-agent` 目录运行 `node src/cli.mjs setup --create --rules pbta --world world.md`。首次准备空白频道时，agent 读完公开 world，提出规则包及设计理由。在 GM 工作台的「设置 → 规则包」中对照正式版，编辑动作和各档的「需要玩家选择」，然后启用草案或沿用当前规则。重复刚才的 setup 完成 AI 队友建卡，再用输出的频道 ID 执行 `node src/cli.mjs run --channel <频道ID>`。设计失败或中断时，在工作台点击重新设计，再运行 setup。已有正式自定义规则或跑团记录的频道可直接接入。

真人描述触发动作后，GM 可以在原窗口引用发言代掷。玩家负责选择的后果由 GM 提问，收到该角色的回答后才记账。记账记录引用骰点和回答，显示修改前后的值。若已经手动标记同一个值，GM 核对后留下记录；遇到其他数值冲突，由桌上参与者核实。在工作台切换到 PbtA 后，重新启动 agent 即可按当前手册准备 AI 队友，真人玩家自行重建角色卡。

## 接口

- 新建或更新频道时使用 `rule_system: "pbta"`。
- `GET /api/channels/{id}/pbta` 返回 `{revision, pack}`。玩家收到的规则包不含 `gmMoves`。
- GM 使用 `POST /api/channels/{id}/pbta/preview` 校验待导入的规则包，使用 `PUT /api/channels/{id}/pbta` 提交 `{revision, pack}`。版本冲突或删除在用定义时返回 409。
- JSON 包使用 `schemaVersion: 1`，包含名称、属性、手册、资源、状态、动作、结果档和 GM 参考动作。档位的上下限均包含端点，首档下限和末档上限为 null。动作以稳定 ID 引用属性和手册。导出的入门包可直接作为模板。
- 角色空间包含 `pbta_rules`。使用现有角色卡接口提交 `pack_revision` 及 `role_card.pbta`，其中 `book` 是手册 ID，`stats`、`resources` 和 `conditions` 按 ID 保存数值或勾选状态。
- 动作复用聊天发言接口及其窗口权限。消息的 `dice.type` 为 `pbta_move`，`dice.text` 为当时的完整裁定。掷骰动作额外包含 `rolls`、`stat_value`、`modifier`、`total`、`band` 和 `outcome`。

- GM 使用 `GET/POST /api/channels/{id}/pbta/draft` 读取和变更草案。写入使用草案版本；启用还须提交确认时的正式包修订号。动作的可选字段 `playerChoiceBands` 列出需要玩家选择的档位 ID，免骰使用 `no_roll`。
- GM 使用 `GET/POST /api/channels/{id}/windows/{window}/pbta-rulings` 查询裁定及提交引用发言的动作、选择提问和单字段记账。实际骰点、卡片变更和聊天回执由服务端保存。

## 本地浏览器验收

启动独立测试后端及代理到该后端的 Vite 前端。在 `tests/browser` 下执行 `npm ci`、`npx playwright install chromium webkit`，再运行 `WEB_BASE=http://127.0.0.1:5196 API_BASE=http://127.0.0.1:18089 npm run test:pbta`。测试创建临时账号和频道，在两个浏览器引擎中完成建卡、发送动作、查看聊天裁定和规则包编辑导入导出。HTTP 层的跨频道、权限及并发测试包含在常规集成套件中。
