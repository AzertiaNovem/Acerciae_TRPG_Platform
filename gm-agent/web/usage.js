// SVG bars and the text table share the same counters; no chart library or remote resources.
// Cache reads/writes are components of input, never added to input + output again.
export const PURPOSES = { director: 'GM 主持', planner: '剧情规划', planner_daily: '每日轻量规划', standin_turn: '玩家角色代答', away_rule: '离开规则判读', day_summary: '个人日终摘要', coplayer_turn: 'AI 队友回合', coplayer_phone: 'AI 队友短信',
  coplayer_card: '队友角色资料', npc_card: 'NPC 角色资料', coplayer_points: '队友购点', coplayer_build: '队友职业与技能',
  coplayer_repair: '角色卡修复', pbta_design: 'PbtA 规则设计', pbta_card: 'PbtA 角色卡', scene_handoff: '场景交接',
  scene_presence: '场景在场判断', scenario_illustration: '场景插图提示词', compact: 'GM 记忆整理', coplayer_memory: '队友记忆整理' };
export const PHASES = { draft: '初稿', critique: '评审', revise: '修订', final_draft: '会后初稿', final_critique: '会后评审', final_revise: '会后修订',
  human: '回应玩家', reaction: '回应事件', autonomous: '自主推进', side: '支线', kickoff: '开场', spark: '日常闲聊' };
export const PARTS = [{ key: 'uncached', label: '普通输入' }, { key: 'cacheRead', label: '缓存读取' },
  { key: 'cacheWrite', label: '缓存写入' }, { key: 'output', label: '输出' }];
const n = value => Number.isFinite(value) ? Math.max(0, value) : 0;
export function partsOf(row) {
  const input = n(row.input), cacheRead = Math.min(input, n(row.cacheRead)), cacheWrite = Math.min(input - cacheRead, n(row.cacheWrite));
  return { uncached: input - cacheRead - cacheWrite, cacheRead, cacheWrite, output: n(row.output) };
}
export function groupPurposes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.purpose || 'unknown';
    if (!groups.has(key)) groups.set(key, { id: key, label: PURPOSES[key] || key, calls: 0, failed: 0, unknown: 0, estimated: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
    const group = groups.get(key);
    for (const field of ['calls', 'failed', 'unknown', 'estimated', 'input', 'cacheRead', 'cacheWrite', 'output']) group[field] += n(row[field]);
    group.total = group.input + group.output;
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
}
export function tokenChart(rows, { h, num, title, onSelect } = {}) {
  const root = h('div', { class: 'token-chart' });
  const sum = rows.reduce((v, r) => v + n(r.total), 0), max = Math.max(1, ...rows.map(r => n(r.total)));
  const svg = (tag, attrs, ...children) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    el.append(...children); return el;
  };
  root.append(h('div', { class: 'usage-legend' }, ...PARTS.map(p => h('span', {}, h('i', { class: `usage-swatch ${p.key}`, 'aria-hidden': 'true' }), p.label))));
  if (!rows.length) { root.append(h('p', { class: 'muted', text: '这个时间段还没有调用记录。' })); return root; }
  const list = h('div', { role: 'list', 'aria-label': title });
  for (const row of rows) {
    const parts = partsOf(row), total = n(row.total), share = sum ? (total / sum * 100).toFixed(1) : '0.0';
    const unknown = row.calls > 0 && row.unknown === row.calls && total === 0;
    const label = unknown ? `${row.label}：用量未知，${num(row.calls)} 次调用` : `${row.label}：${num(total)} token，占已记录总量 ${share}%，${num(row.calls)} 次调用${row.unknown ? `，${num(row.unknown)} 次用量未知` : ''}`;
    const bar = svg('svg', { viewBox: '0 0 1000 18', preserveAspectRatio: 'none', role: 'img', 'aria-label': label }, svg('title', {}, label));
    bar.append(svg('rect', { x: 0, y: 0, width: 1000, height: 18, rx: 4, class: 'usage-track' }));
    let x = 0;
    for (const p of PARTS) {
      const width = parts[p.key] / max * 1000;
      if (width) bar.append(svg('rect', { x, y: 0, width, height: 18, class: `usage-fill ${p.key}` }, svg('title', {}, `${p.label}：${num(parts[p.key])} token`)));
      x += width;
    }
    const name = onSelect ? h('button', { class: 'quiet usage-name', onclick: () => onSelect(row.id), text: row.label }) : h('strong', { class: 'usage-name', text: row.label });
    list.append(h('div', { class: 'usage-bar-row', role: 'listitem', 'data-usage-id': row.id },
      h('div', { class: 'usage-row-head' }, name, h('span', { class: 'mono', text: unknown ? '用量未知 · —' : `${num(total)} · ${share}%` })), bar,
      h('div', { class: 'usage-row-meta', text: `${num(row.calls)} 次调用${unknown ? '' : ` · 输入 ${num(row.input)} / 输出 ${num(row.output)}`}${row.failed ? ` · 失败 ${num(row.failed)}` : ''}${row.unknown ? ` · ${num(row.unknown)} 次用量未知` : ''}${row.estimated ? ` · ${num(row.estimated)} 次为估算` : ''}${row.note ? ` · ${row.note}` : ''}` })));
  }
  root.append(list); return root;
}
