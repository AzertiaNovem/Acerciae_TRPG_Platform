// The channel settings the host's Web UI edits as a form: every key a channel file may set (credentials, provider and
// endpoints stay in the shared file), with its type, range, label and help, and how to read its effective value from
// buildConfig()'s result. `applyChanges` edits the YAML in place, keeping comments and every key it does not touch.
import YAML from "yaml";

export const GROUPS = [
  { id: "table", title: "牌桌", help: "语言、AI 队友与开场。频道的规则系统来自平台（在 GM 工作区中修改）。" },
  { id: "llm", title: "主持模型", help: "GM、NPC 与 AI 队友所用的模型。服务商、地址与密钥在公共配置中设置。" },
  { id: "planner", title: "剧情规划", help: "较慢、较深的规划模型：节拍、线索与会后总结。" },
  { id: "pacing", title: "节奏", help: "回应前的等待与每回合的动作数。" },
  { id: "context", title: "上下文与预算", help: "提示词的令牌预算与每日消耗上限。" },
  { id: "autonomy", title: "自主推进", help: "没有玩家发言时，牌桌按自己的时钟推进。" },
  { id: "timelines", title: "时间线与窗口", help: "分头行动、重聚与场景窗口。" },
  { id: "scenarios", title: "场景", help: "GM 自行开启下一场景的条件。" },
  { id: "calendar", title: "日历（日常模式）", help: "GM 推进故事日期的速度。0 表示不限。" },
  { id: "modes", title: "模式", help: "即兴与日常模式保存在状态文件中；这里只在设置时改变它们。" },
];

const f = (key, type, label, help, effective, extra = {}) => ({ key, group: key.split(".")[0] === "channel" ? "table" : key.split(".")[0], type, label, help, effective, ...extra });
const minutes = (ms) => Math.round(ms / 60000);
export const FIELDS = [
  f("table.language", "enum", "语言", "GM 与 AI 角色写作的语言。留空则跟随频道设置。", (c) => c.language, { options: ["", "zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"] }),
  f("table.coplayers", "int", "AI 队友数量", "启动时准备的 GM 扮演队友数（已有的会被沿用）。", (c) => c.coplayers, { min: 0, max: 8 }),
  f("table.level", "int", "新队友等级（D&D）", "D&D 频道中新建 AI 队友的等级；已有角色保持原等级。", (c) => c.level, { min: 1, max: 20 }),
  f("table.coplayer_windows", "list", "队友初始窗口", "AI 队友起始所在的窗口名，逗号分隔。留空则为主聊天。", (c) => c.coplayerWindows),
  f("channel.era", "string", "时代", "生成队友时参考的时代（例如 1920s）。", (c) => c.era),
  f("table.kickoff", "bool", "启动时开场", "启动后 GM 立即在主场景开场。", (c) => c.kickoff),
  f("table.verbose", "bool", "详细日志", "在日志中记录更多细节。", (c) => c.verbose),

  f("llm.model", "string", "模型", "留空则使用公共配置或服务商默认模型。", (c) => c.llm.model),
  f("llm.effort", "enum", "推理强度", "模型的思考强度。", (c) => c.llm.effort, { options: ["", "low", "medium", "high", "xhigh", "max"] }),
  f("llm.max_tokens", "int", "最大输出令牌", "每次调用的输出上限。", (c) => c.llm.maxTokens, { min: 256, max: 128000 }),
  f("llm.timeout_ms", "int", "调用超时", "单次模型调用的超时。", (c) => c.llm.timeoutMs, { min: 10000, unit: "ms" }),
  f("llm.stream", "bool", "流式响应", "边生成边接收模型回复。", (c) => c.llm.stream),
  f("llm.fallbacks", "bool", "失败回退", "模型拒绝或出错时使用备用策略。", (c) => c.llm.fallbacks),
  f("llm.cache_ttl", "enum", "提示词缓存", "1h 跨越短暂休息保持缓存；5m 写入更便宜；off 不缓存。", (c) => c.llm.cacheTtl, { options: ["", "1h", "5m", "off"] }),

  f("planner.enabled", "bool", "启用剧情规划", "关闭后不再规划节拍，也不做会后总结。", (c) => c.planner.enabled),
  f("planner.model", "string", "规划模型", "留空则与主持模型相同。", (c) => c.planner.model),
  f("planner.effort", "enum", "规划推理强度", "规划模型的思考强度。", (c) => c.planner.effort, { options: ["", "low", "medium", "high", "xhigh", "max"] }),
  f("planner.interval_minutes", "int", "规划间隔", "自动规划的最短间隔。", (c) => minutes(c.planner.intervalMs), { min: 0, unit: "分钟" }),
  f("planner.min_lines", "int", "规划所需行数", "两次规划之间至少新增的聊天行数。", (c) => c.planner.minLines, { min: 0 }),
  f("planner.cooldown_minutes", "int", "规划冷却", "任何一次规划之后的冷却时间。", (c) => minutes(c.planner.cooldownMs), { min: 0, unit: "分钟" }),
  f("planner.stall_turns", "int", "停滞回合", "剧情停滞这么多回合后提前规划。", (c) => c.planner.stallTurns, { min: 2 }),
  f("planner.max_runs_per_hour", "int", "每小时最多规划", "规划次数上限。", (c) => c.planner.maxRunsPerHour, { min: 1 }),
  f("planner.impulse_lines", "int", "冲动间隔行数", "NPC 冲动的检查间隔。", (c) => c.planner.impulseLines, { min: 1 }),
  f("planner.plan_tokens", "int", "计划篇幅", "交给 GM 的计划摘要令牌数。", (c) => c.planner.planTokens, { min: 300 }),
  f("planner.wish_window", "bool", "规划窗口", "开放“致剧情规划”窗口，供玩家写下愿望与纠正。", (c) => c.planner.wishWindow),
  f("planner.final_review", "bool", "会后总结", "玩家离开后复盘本次游戏。", (c) => c.planner.finalReview),
  f("planner.final_review_min_lines", "int", "总结所需玩家行数", "一次游戏至少这么多玩家发言才做总结。", (c) => c.planner.finalReviewMinLines, { min: 1 }),
  f("planner.final_review_max_days", "int", "总结最多推进天数", "会后总结可推进日历的最多天数。", (c) => c.planner.finalReviewMaxDays, { min: 0, unit: "天" }),

  f("pacing.debounce_ms", "int", "回应等待", "玩家停笔多久后 GM 回应。", (c) => c.debounceMs, { min: 0, unit: "ms" }),
  f("pacing.post_delay_ms", "int", "发言间隔", "连续发出的两行之间的停顿。", (c) => c.postDelayMs, { min: 0, unit: "ms" }),
  f("pacing.max_actions_per_turn", "int", "每回合最多动作", "GM 与队友一回合内的动作上限。", (c) => c.maxActionsPerTurn, { min: 1 }),

  f("context.gm_tokens", "int", "GM 上下文预算", "GM 提示词的令牌预算，较早的历史会被压缩为章节。", (c) => c.gmContextTokens, { min: 8000 }),
  f("context.coplayer_tokens", "int", "队友上下文预算", "每位 AI 队友的令牌预算。", (c) => c.coplayerContextTokens, { min: 4000 }),
  f("context.recall_tokens", "int", "回忆片段预算", "从久远历史中召回的片段令牌数。", (c) => c.recallTokens, { min: 0, max: 4000 }),
  f("context.page_lines", "int", "同步分页行数", "同步聊天时每页读取的行数。", (c) => c.contextLines, { min: 10, max: 200 }),
  f("context.backfill_lines", "int", "历史回填行数", "首次启动时读取的历史行数。", (c) => c.historyBackfillLines, { min: 0 }),
  f("context.daily_token_budget", "int", "每日令牌预算", "计费等价令牌（缓存读取按十分之一计）。用尽后停止自主回合。0 为不限。", (c) => c.dailyTokenBudget, { min: 0 }),

  f("autonomy.enabled", "bool", "启用自主推进", "队友独处的支线与安静的共享窗口自行推进。", (c) => c.autonomy),
  f("autonomy.tick_ms", "int", "检查间隔", "自主推进的检查周期。", (c) => c.autonomyTickMs, { min: 1000, unit: "ms" }),
  f("autonomy.side_interval_ms", "int", "支线推进间隔", "只有 AI 队友的支线多久推进一次。", (c) => c.autonomySideIntervalMs, { min: 0, unit: "ms" }),
  f("autonomy.quiet_ms", "int", "安静多久后推进", "共享窗口沉默多久后 GM 推进。", (c) => c.autonomyQuietMs, { min: 0, unit: "ms" }),
  f("autonomy.quiet_turns", "int", "安静推进次数", "无人回应时最多推进几次。", (c) => c.autonomyQuietTurns, { min: 0 }),
  f("autonomy.max_turns_per_hour", "int", "每小时自主回合", "自主回合的上限。", (c) => c.autonomyMaxTurnsPerHour, { min: 0 }),
  f("autonomy.idle_minutes", "int", "离开判定", "多久没有玩家发言视为离开：共享窗口暂停。", (c) => c.autonomyIdleMinutes, { min: 1, unit: "分钟" }),
  f("autonomy.away_side_interval_ms", "int", "离开时支线间隔", "玩家离开期间支线的推进间隔（0 为暂停）。", (c) => c.awaySideIntervalMs, { min: 0, unit: "ms" }),

  f("timelines.auto", "bool", "主动分头", "GM 报告行踪，牌桌自动分头与重聚。关闭则回到模型主导的分头。", (c) => c.timelineAuto),
  f("timelines.scene_forks", "bool", "场景分叉", "开启：首次分头后主线移入私有分叉窗口，主聊天变为 GM 不叙述的大厅（多名玩家）。关闭：主线留在主聊天（单人）。", (c) => c.sceneForks),
  f("timelines.max_active", "int", "同时最多线程", "包括主线在内。", (c) => c.timelineMaxActive, { min: 1 }),
  f("timelines.guard_turns", "int", "防反复回合", "撤销近期移动前需要的一致回合数。", (c) => c.timelineGuardTurns, { min: 0 }),
  f("timelines.guard_ms", "int", "防反复时长", "撤销近期移动前需要经过的时间。", (c) => c.timelineGuardMs, { min: 0, unit: "ms" }),
  f("timelines.pc_cooldown_ms", "int", "玩家新窗口冷却", "同一玩家两次获得新窗口的最短间隔。", (c) => c.timelinePcCooldownMs, { min: 0, unit: "ms" }),
  f("timelines.max_arrivals_per_hour", "int", "每小时到场回合", "开启新场景或重聚的回合上限。", (c) => c.timelineMaxArrivalsPerHour, { min: 0 }),

  f("scenarios.auto", "bool", "GM 推进场景", "GM 自行开启下一场景。", (c) => c.scenarioAuto),
  f("scenarios.min_minutes", "int", "场景最短时长", "当前场景至少持续这么久。", (c) => c.scenarioMinMinutes, { min: 0, unit: "分钟" }),
  f("scenarios.min_lines", "int", "场景最少行数", "当前场景至少这么多行。", (c) => c.scenarioMinLines, { min: 0 }),

  f("calendar.min_minutes", "int", "日期推进冷却", "日期变化后，至少过这么久才能再推进。", (c) => c.calendarMinMinutes, { min: 0, unit: "分钟" }),
  f("calendar.min_lines", "int", "日期推进所需行数", "以及这么多玩家发言。", (c) => c.calendarMinLines, { min: 0 }),
  f("calendar.max_days", "int", "一次最多跳过天数", "GM 一次推进日期的上限。", (c) => c.calendarMaxDays, { min: 0, unit: "天" }),

  f("modes.improv", "tri", "即兴模式", "没有模组：故事来自世界设定。留空则保持状态文件中的设置。", (c) => c.improv),
  f("modes.world_file", "string", "世界设定文件", "相对于本频道配置文件的路径。", (c) => c.worldFile),
  f("modes.secrets_file", "string", "GM 秘密文件", "相对于本频道配置文件的路径。", (c) => c.secretsFile),
  f("modes.casual", "tri", "日常模式", "手机、短信与故事日历。留空则保持状态文件中的设置。", (c) => c.casual),
  f("modes.casual_max_delay_minutes", "int", "短信最长延迟", "NPC 短信最晚多久送达。", (c) => c.casualMaxDelayMinutes, { min: 0, unit: "分钟" }),
  f("modes.casual_ai_texts_per_hour", "int", "AI 间短信每小时", "AI 角色之间每小时最多回复的短信数。", (c) => c.casualAiTextsPerHour, { min: 0 }),
  f("modes.casual_ai_chain", "int", "AI 间连续短信", "两名 AI 角色连续往来的上限，玩家发言后重置。", (c) => c.casualAiChain, { min: 1 }),
];
const BY_KEY = new Map(FIELDS.map((x) => [x.key, x]));

// What the browser needs: no effective-value functions.
export const schema = () => ({ groups: GROUPS, fields: FIELDS.map(({ effective, ...rest }) => rest) });

const get = (obj, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

// Each field: the value written in the channel file (undefined: not set), the value the channel runs with, and the
// value it would run with if the key were removed (`rebuild(data)` builds the config for other file data).
export function formValues(data, cfg, rebuild = null) {
  const out = {};
  const read = (x, c) => { try { return x.effective(c) ?? null; } catch { return null; } };
  for (const x of FIELDS) {
    const raw = get(data, x.key), set = raw === null ? undefined : raw, effective = read(x, cfg);
    let fallback = effective;
    if (set !== undefined && rebuild) {
      const [section, key] = x.key.split(".");
      const { [key]: _, ...rest } = data[section] ?? {};
      try { fallback = read(x, rebuild({ ...data, [section]: rest })); } catch { fallback = null; }
    }
    out[x.key] = { set, effective, default: fallback };
  }
  return out;
}

function coerce(x, v) {
  const bad = (why) => { throw Object.assign(new Error(`${x.label}（${x.key}）${why}`), { code: "INVALID_SETTING" }); };
  switch (x.type) {
    case "bool": case "tri":
      if (v === true || v === false) return v;
      if (v === "true" || v === "false") return v === "true";
      return bad("必须是开或关");
    case "int": {
      const n = typeof v === "number" ? v : String(v).trim() === "" ? NaN : Number(v);
      if (!Number.isInteger(n)) bad("必须是整数");
      if (x.min !== undefined && n < x.min) bad(`不能小于 ${x.min}`);
      if (x.max !== undefined && n > x.max) bad(`不能大于 ${x.max}`);
      return n;
    }
    case "enum":
      if (!x.options.includes(String(v))) bad(`必须是 ${x.options.filter(Boolean).join(" / ")} 之一`);
      return String(v);
    case "list": {
      const items = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
      if (items.some((s) => s.length > 120)) bad("的每一项不能超过 120 个字符");
      return items;
    }
    default: {
      const s = String(v);
      if (s.length > 500 || /[\r\n]/.test(s)) bad("必须是一行文本（不超过 500 字符）");
      return s;
    }
  }
}

// changes: { "pacing.debounce_ms": 3000, "llm.model": null, … }. null, undefined or "" removes the key (the default
// applies). Unknown keys are refused; sections left empty are removed.
export function applyChanges(text, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("changes must be an object");
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error("Invalid channel YAML");
  if (doc.contents === null || doc.contents === undefined || (YAML.isScalar(doc.contents) && doc.contents.value === null)) doc.contents = doc.createNode({});
  if (!YAML.isMap(doc.contents)) throw new Error("Channel configuration must be a YAML mapping");
  for (const [key, raw] of Object.entries(changes)) {
    const x = BY_KEY.get(key);
    if (!x) throw Object.assign(new Error(`Unknown setting ${key}`), { code: "INVALID_SETTING" });
    const [section, name] = key.split(".");
    const unset = raw === null || raw === undefined || (raw === "" && x.type !== "enum") || (Array.isArray(raw) && !raw.length) || (x.type === "enum" && raw === "");
    if (unset) { if (YAML.isMap(doc.get(section, true))) doc.deleteIn([section, name]); continue; }
    const value = coerce(x, raw);
    if (!YAML.isMap(doc.get(section, true))) doc.set(section, doc.createNode({}));
    doc.setIn([section, name], value);
  }
  for (const item of [...doc.contents.items]) if (YAML.isMap(item.value) && !item.value.items.length) doc.delete(item.key);
  return String(doc);
}
