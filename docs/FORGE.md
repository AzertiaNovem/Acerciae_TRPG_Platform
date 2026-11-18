# 开局共创 Forge

Forge 仅用于即兴模式的正式游戏开始前。启用 `modes.improv: true` 和 `forge.enabled: true` 后运行托管，GM 会创建“开局共创 · Forge”窗口。可不给 world 文件，从一个想法开始；已有 `modes.world_file` 是输入草稿，原文件不会被修改。正式开局采用共同确认的产物，重启时不会重新载入输入草稿覆盖它。进行中的世界调整继续使用即兴模式的“致剧情规划”。

在托管 WebUI 新建频道时，可以在「邀请玩家」步骤搜索平台账号。点击「邀请并继续」会把所选玩家加入频道，最后确认启动时会再次核对名单。玩家不必同时在线；第一张卡会在他们取得共创窗口的访问权后发出。也可以跳过邀请：空频道会等人，筹备期间后来入场的玩家会收到当时可用的操作卡。

玩家先在窗口中加入共创，再点击继续提问。每轮有两至三个问题，每题提供具体选项、自定义输入和请 GM 提案。卡片的自定义输入上限为 250 个字符；较长回答直接发到窗口即可。GM 只读取已提交的聊天消息，不读取用户未提交的卡片状态。平台未启用富文本时，显示文本说明和对应命令。

生成完整草案后，所有明确加入的参与者都必须确认同一版本的世界、规则和自己的角色。任何新的修改都会撤销旧版确认。任何参与者都可要求独立试跑：快速为两组各两轮，标准为四组各三轮，深入为六组各三轮（包括中段压力）；试跑不发正式故事、不修改正式状态，报告在 GM 托管界面中查看。模型调用、评审、修复和试跑都计入现有每日预算，耗尽时保留草案。

角色卡会生成对应数值。CoC 与 D&D 使用现有规则、派生计算和服务端预检；PbtA 的世界、playbook、角色卡是同一份共同设计，整体验证并在一个数据库事务中启用规则和角色卡。新的人类角色先由 GM 创建，再交还其玩家；已有角色要求版本匹配后才能更新。启用完成后仍等待“开始正式游戏”，保存或暂停筹备不会开局。

公共世界、开局条件和角色卡分开保存；隐藏真相单独生成，既不进入公共访谈，也不放进公开角色卡。共创窗口的 `purpose=forge` 永久保持，不产生剧情事件、不加入剧情场景、不作为分线祖先；正式 GM 不读取该窗口作为游戏上下文。

## 接口与恢复

SQLite `forge.session` 保存输入、参与者、原始回答、稳定事实/问题 ID、草案历史、当前版本、确认、卡片和操作日志。`<channel>.json` 的 `forge` 保存阶段指针。HTTP 写入前先保存操作意图；新窗口、角色和角色卡使用 `request_id`，相同内容重试不会重复应用。不同内容复用同一请求 ID 会返回 409。中途启用失败留在 `applying`，可重试；不会启动正式主持。

`POST /api/channels/{channelId}/characters/preview` 只允许 GM，接收 `{rule_system, role_card}`，返回按当前规则校验和标准化的角色卡，不写角色。角色卡保存支持可选 `expected_updated_at` 和 `request_id`。

`PUT /api/channels/{channelId}/characters/{characterId}/owner` 是隐藏 API，没有普通游戏界面的按钮。所有本频道 GM 可调用，正文为 `{user_id, expected_user_id}`，后者为预期旧归属或 null。仅限本频道 PC，目标必须是本频道玩家或 GM。相同目标幂等；旧归属不匹配返回 409。成功时审计归属变化，清除旧绑定，仅填补新主人已加入的剧情窗口中的空绑定，不加入原主人的私密窗口、不覆盖新主人选中的其他角色。

PbtA 的 `POST .../pbta/preview` 还接受 `{pack,characters}`；`POST .../pbta/draft` 的 `forge_submit` 提交联合草案，随后 `activate` 必须提交相同的 pack/characters 和唯一 request_id。启用时重新检查规则版本、角色版本、玩家成员资格和频道未开局，失败时事务全部回滚。

## 世界状态接入

Forge 独占 `gm-agent/src/forge/`，不修改 composer/provider/planner 工具实现。每位草案角色使用 `key: C1` 等稳定临时键，成功应用后 `session.characterIds` 为 `{C1: platform_character_uuid}`。`phase` 顺序为 interview → review → applying → ready → playing，暂停为 cancelled。

私有 `session.worldStateSeed` 在隐藏真相之后生成并校验；数据格式遵循 `world-state/state.mjs` 的 `seedWorldState`。在所有角色已创建、卡片已保存、归属已交还后，开始正式游戏时调用纯函数，将结果与正式 world 一起保存到 `state.worldState`。`sourceId` 固定为 `forge:<session id>:<revision>`，重复导入同一 seed 幂等。关系值只为真实 NPC 指向具体角色的有向关系建立，不为陪玩建立情绪数值，不自动生成全团矩阵。背包仍以 `role_card.items` 为准。
