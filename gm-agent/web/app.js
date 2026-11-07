// GM 控制台: channel status, settings form, YAML editor and logs for the multi-channel host.
// The token stays in page memory only. All content is set with textContent (no HTML from the server).
'use strict';
let token = '', selected = '', tab = 'overview', busy = false;
let schema = null, config = null, detail = null, channels = [];
const dirty = new Map();            // field key → new value ('' = back to default)
let logSeq = 0, logLines = [];
const $ = id => document.getElementById(id);

// ---------- helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const notice = (text, kind = '') => { const n = $('notice'); n.textContent = text; n.className = `notice ${kind}`; };
async function api(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(Error(data?.error ?? `HTTP ${response.status}`), { status: response.status });
  return data;
}
const num = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));
function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return '刚刚'; if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`; if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
function span(iso) {
  if (!iso) return '—';
  let s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400; const hr = Math.floor(s / 3600); s -= hr * 3600; const m = Math.floor(s / 60);
  return d ? `${d} 天 ${hr} 小时` : hr ? `${hr} 小时 ${m} 分` : m ? `${m} 分钟` : `${s} 秒`;
}
const time = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const STATES = { starting: ['启动中', 'warn'], running: ['运行中', 'ok'], stopping: ['停止中', 'warn'], stopped: ['已停止', 'off'], failed: ['失败 / 已退出', 'bad'] };
const RULES = { coc7e: 'CoC 7e', dnd2024: 'D&D 2024', pbta: 'PbtA' };
const yesNo = v => (v === true ? '开' : v === false ? '关' : '—');
const unsaved = () => dirty.size > 0 || (config && $('yaml').value !== config.yaml);
const confirmDiscard = () => !unsaved() || confirm('放弃尚未保存的修改？');

// ---------- login
$('login').onsubmit = async event => {
  event.preventDefault(); token = $('token').value.trim();
  try {
    schema = await api('/api/schema');
    await refreshChannels(); await refreshHost();
    $('login').hidden = true; $('session').hidden = false; $('summary').hidden = false; $('token').value = ''; $('new-task').disabled = false;
    notice('已连接。请选择频道。');
  } catch (error) { token = ''; notice(error.status === 401 ? '令牌不正确。' : error.message, 'bad'); }
};
$('logout').onclick = () => {
  if (!confirmDiscard()) return;
  token = ''; selected = ''; config = null; detail = null; hostInfo = null; dirty.clear();
  $('login').hidden = false; $('session').hidden = true; $('summary').hidden = true; $('host').hidden = true;
  $('channels').replaceChildren(h('p', { class: 'muted', text: '连接后显示频道。' }));
  $('channel').hidden = true; $('create').hidden = true; $('empty').hidden = false; $('new-task').disabled = true; notice('已断开。');
};

// ---------- host and channel list
let hostInfo = null;
function renderSummary() {
  const count = s => channels.filter(c => c.status === s).length, failed = count('failed');
  $('summary').replaceChildren(
    h('span', { class: 'chip ok', text: `运行 ${count('running')}` }),
    failed ? h('span', { class: 'chip bad', text: `失败 ${failed}` }) : null,
    h('span', { class: 'chip', text: `共 ${channels.length} 个频道` }),
    hostInfo ? h('span', { class: 'chip', text: `主机已运行 ${span(hostInfo.startedAt)}` }) : null);
}
async function refreshHost() {
  const host = hostInfo = await api('/api/host');
  renderSummary();
  const row = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), h('span', { class: 'mono', text: v ?? '—' }));
  $('host').replaceChildren(h('h3', { text: '主机' }),
    row('平台', host.apiBase), row('账户', host.account), row('模型', [host.llm?.provider, host.llm?.model].filter(Boolean).join(' · ')),
    row('规划模型', host.planner?.model || '同主持模型'), row('状态目录', host.stateDir), row('进程', `pid ${host.pid} · Node ${host.node}`));
  $('host').hidden = false;
}
async function refreshChannels() {
  channels = await api('/api/channels');
  $('channel-count').textContent = `${channels.length} 个`; renderSummary();
  $('channels').replaceChildren(...channels.map(ch => {
    const [label, kind] = STATES[ch.status] ?? [ch.status, 'off'];
    return h('button', { class: 'channel-item', 'aria-pressed': String(ch.id === selected), onclick: () => select(ch.id) },
      h('div', { class: 'ci-top' }, h('span', { class: `dot ${kind}` }), h('strong', { text: ch.name || ch.id }), ch.rule ? h('span', { class: 'tag', text: RULES[ch.rule] ?? ch.rule }) : null),
      h('div', { class: 'ci-meta' }, h('span', { text: label }), ch.paused ? h('span', { class: 'warn-text', text: '暂停中' }) : null,
        !ch.enabled ? h('span', { class: 'muted', text: '不自动启动' }) : null,
        ch.usageToday !== null ? h('span', { class: 'muted', text: `今日 ${num(ch.usageToday)} 令牌` }) : null),
      ch.name ? h('div', { class: 'ci-id mono', text: ch.id }) : null,
      ch.status === 'failed' && ch.lastError ? h('div', { class: 'ci-error', text: ch.lastError }) : null);
  }));
}

// ---------- selecting a channel
async function select(id) {
  if (busy || (id !== selected && !confirmDiscard())) return;
  selected = id; dirty.clear(); logSeq = 0; logLines = []; $('log').replaceChildren(); detail = null; config = null;
  $('empty').hidden = true; $('create').hidden = true; $('channel').hidden = false;
  $('title').textContent = id; $('subtitle').textContent = '';
  try { await Promise.all([loadConfig(), refreshDetail()]); await refreshChannels(); showTab(tab); notice(''); }
  catch (error) { notice(error.message, 'bad'); }
}
async function loadConfig() {
  try { config = await api(`/api/channels/${selected}/config`); }
  catch (error) { config = null; $('yaml').value = ''; $('form').replaceChildren(h('p', { class: 'banner error', text: `无法读取配置：${error.message}` })); throw error; }
  $('yaml').value = config.yaml; $('yaml-result').textContent = '';
  dirty.clear(); renderForm(); renderSavebar();
}

// ---------- tabs
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => showTab(button.dataset.tab);
function showTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const t of ['overview', 'settings', 'yaml', 'logs']) $(`tab-${t}`).hidden = t !== name;
  if (name === 'logs') refreshLogs().catch(() => {});
}

// ---------- status
async function refreshDetail() {
  if (!selected) return;
  detail = await api(`/api/channels/${selected}/status`);
  renderHead(); renderOverview();
}
function renderHead() {
  const d = detail, live = d.live, [label, kind] = STATES[d.status] ?? [d.status, 'off'];
  $('title').textContent = live?.channel?.name || d.id;
  $('subtitle').textContent = [d.id, d.config].join(' · '); $('yaml-path').textContent = d.config;
  $('state').textContent = label; $('state').className = `pill ${kind}`;
  $('rule').textContent = live?.channel?.rule ? RULES[live.channel.rule] ?? live.channel.rule : ''; $('rule').hidden = !live?.channel?.rule;
  const running = ['running', 'starting'].includes(d.status), moving = ['starting', 'stopping'].includes(d.status);
  document.querySelector('[data-action=start]').disabled = busy || running || moving;
  document.querySelector('[data-action=stop]').disabled = busy || !running || d.status === 'stopping';
  document.querySelector('[data-action=restart]').disabled = busy || moving;
  const banner = $('error-banner');
  banner.hidden = !(d.status === 'failed' && d.runtime.lastError);
  banner.textContent = d.runtime.lastError ? `最近的错误：${d.runtime.lastError}` : '';
  $('r-enabled').checked = d.enabled; $('r-prepare').checked = d.prepareOnStart;
}
function card(title, ...rows) { return h('section', { class: 'card' }, h('h3', { text: title }), ...rows); }
const kv = (k, v, cls = '') => h('div', { class: 'kv' }, h('span', { text: k }), h('span', { class: cls, text: v ?? '—' }));
function renderOverview() {
  const d = detail, live = d.live, rt = d.runtime;
  $('snapshot-note').textContent = !live ? (d.status === 'running' ? '正在读取实时状态…' : '频道未运行，还没有可显示的实时状态。启动后这里显示牌桌、用量与剧情。')
    : live.stale ? `频道未运行或没有及时回应；显示的是 ${time(live.at)} 的最后状态。` : `实时状态 · ${time(live.at)}`;
  const cards = [];
  cards.push(card('运行',
    kv('状态', (STATES[d.status] ?? [d.status])[0]),
    kv('已运行', d.status === 'running' ? span(rt.readyAt ?? rt.startedAt) : '—'),
    kv('本次启动于', time(rt.startedAt)), kv('启动次数', num(rt.starts)),
    rt.stoppedAt ? kv('上次结束', `${time(rt.stoppedAt)}（代码 ${rt.exitCode ?? '—'}）`) : null,
    kv('自动启动', d.enabled ? '是' : '否'), kv('启动时准备频道', d.prepareOnStart ? '是' : '否'),
    live?.realtime ? kv('实时连接', live.realtime.streams.map(s => `${s} ${live.realtime.connected.includes(s) ? '✓' : '✗'}`).join('  ')) : null,
    rt.lastError ? h('p', { class: 'error-text', text: rt.lastError }) : null));
  if (live) {
    const c = live.channel ?? {}, a = live.activity ?? {}, cast = live.cast ?? {}, u = live.usage, p = live.planner, s = live.settings ?? {};
    cards.push(card('牌桌',
      kv('频道', c.name), kv('规则', RULES[c.rule] ?? c.rule), kv('语言', c.language), kv('GM 身份', c.gm === null ? '—' : c.gm ? '是' : '否（无法主持）', c.gm === false ? 'error-text' : ''),
      kv('知识模式', c.knowledge === 'isolated' ? '隔离' : c.knowledge === 'public' ? '公开' : c.knowledge), kv('窗口', num(cast.windows)),
      kv('模型', `${s.model ?? '—'}${s.effort ? ` · ${s.effort}` : ''}`),
      c.warning ? h('p', { class: 'warn-text', text: c.warning }) : null));
    cards.push(card('活动',
      kv('状态', a.paused ? '主持已暂停（玩家 /pause）' : a.away ? '玩家离开（共享窗口暂停）' : '玩家在场', a.paused ? 'warn-text' : ''),
      kv('GM 回合', num(a.turns)), kv('排队中的回合', num(a.pendingTurns)),
      kv('最近玩家发言', ago(a.lastHumanAt)), kv('最近一行', ago(a.lastLineAt)),
      kv('近一小时自主回合', num(a.autonomousLastHour)),
      a.splitInProgress ? kv('分头', '进行中（重启后会完成）', 'warn-text') : null,
      a.openingTurnsOwed ? kv('待开场的场景', num(a.openingTurnsOwed)) : null));
    if (u) {
      const today = u.today, cache = today.input ? Math.round((today.cacheRead / today.input) * 100) : 0;
      const budget = u.budget ? h('div', { class: 'budget' }, h('progress', { max: u.budget, value: Math.min(today.billable, u.budget) }), h('span', { class: u.overBudget ? 'error-text' : 'muted', text: `${num(today.billable)} / ${num(u.budget)}${u.overBudget ? '（已用尽，自主回合暂停）' : ''}` })) : null;
      cards.push(card('模型用量',
        kv('今日（计费等价）', `${num(today.billable)} 令牌`), budget ?? kv('每日预算', '不限'),
        kv('今日调用', `${num(today.calls)} 次 · 缓存命中 ${cache}%`), kv('今日输入 / 输出', `${num(today.input)} / ${num(today.output)}`),
        kv('近 7 天', `${num(u.week.billable)} 令牌 · ${num(u.week.calls)} 次`),
        u.byPurpose?.length ? h('table', { class: 'mini' }, h('thead', {}, h('tr', {}, h('th', { text: '用途' }), h('th', { text: '次数' }), h('th', { text: '令牌' }))),
          h('tbody', {}, ...u.byPurpose.map(r => h('tr', {}, h('td', { text: `${r.purpose}${r.phase ? `/${r.phase}` : ''}` }), h('td', { text: `${num(r.calls)}${r.failed ? `（失败 ${r.failed}）` : ''}` }), h('td', { text: num(r.total) }))))) : null));
    }
    cards.push(card('角色',
      h('h4', { text: `玩家角色（${cast.players?.length ?? 0}）` }),
      cast.players?.length ? h('ul', { class: 'list' }, ...cast.players.map(x => h('li', {}, h('strong', { text: x.name }), x.player ? ` · ${x.player}` : '', x.timeline !== null ? h('span', { class: 'tag', text: `T${x.timeline}` }) : null))) : h('p', { class: 'muted', text: '暂无' }),
      h('h4', { text: `AI 队友（${cast.coplayers?.length ?? 0}）` }),
      cast.coplayers?.length ? h('ul', { class: 'list' }, ...cast.coplayers.map(x => h('li', {}, h('strong', { text: x.name }), ` · ${x.windows.join('、') || '不在任何窗口'}`, x.timeline !== null ? h('span', { class: 'tag', text: `T${x.timeline}` }) : null))) : h('p', { class: 'muted', text: '暂无' }),
      h('h4', { text: `NPC（${cast.npcCount ?? 0}）` }),
      cast.npcs?.length ? h('p', { class: 'muted', text: cast.npcs.join('、') }) : h('p', { class: 'muted', text: '暂无' })));
    cards.push(card('时间线',
      kv('窗口模式', s.sceneForks ? '场景分叉（主聊天为大厅）' : '主线留在主聊天'), kv('分头方式', s.timelineAuto ? `主动（最多 ${s.maxActive} 条）` : '模型主导'),
      live.timelines?.length ? h('ul', { class: 'list timelines' }, ...live.timelines.map(t => h('li', { class: t.status === 'active' ? '' : 'faded' },
        h('div', {}, h('span', { class: 'tag', text: t.handle }), h('strong', { text: t.name }), t.status !== 'active' ? h('span', { class: 'muted', text: ` 已并入${t.mergedInto ? ` ${t.mergedInto}` : ''}` }) : t.span ? h('span', { class: 'muted', text: t.span === 'long' ? ' 远距离' : ' 近距离' }) : null, t.opened === false ? h('span', { class: 'warn-text', text: ' 待开场' }) : null),
        h('div', { class: 'muted small', text: [t.window ? `「${t.window}」` : '', t.place, t.time].filter(Boolean).join(' · ') }),
        t.members.length ? h('div', { class: 'small', text: t.members.join('、') }) : null))) : h('p', { class: 'muted', text: '暂无' })));
    if (p) cards.push(card('剧情规划',
      kv('状态', p.on ? (p.mode === 'full' ? '开（完整规划：即兴）' : '开（只管节奏：模组）') : '关'),
      p.on ? kv('计划', p.version ? `v${p.version} · ${ago(p.updatedAt)}${p.trigger ? `（${p.trigger}）` : ''}` : '尚无（需要更多发言）') : null,
      p.beat ? kv('当前节拍', p.beat) : null, p.version ? kv('判断', p.moveOn ? '可以推进' : '继续当前') : null,
      p.on ? kv('线索 / 冲动', `${num(p.threads)} / ${p.impulses?.length ? p.impulses.join('、') : '无'}`) : null,
      p.window ? kv('规划窗口', `「${p.window}」 · 纠正 ${p.corrections} · 愿望 ${p.wishes}${p.inbox ? ` · 未读 ${p.inbox}` : ''}`) : null,
      p.session ? kv('本次游戏', `${num(p.session.lines)} 行玩家发言 · 始于 ${time(p.session.startedAt)}`) : null,
      p.on ? kv('会后总结', p.finalReview ? '开' : '关') : null, p.busy ? kv('', '正在规划…', 'warn-text') : null,
      p.on ? kv('模型', `${p.model || '—'}${p.effort ? ` · ${p.effort}` : ''}`) : null));
    const cal = live.calendar ?? {}, ca = live.casual ?? {}, im = live.improv ?? {};
    cards.push(card('模式',
      kv('日常模式', ca.on ? `开 · ${num(ca.phones)} 部手机 · ${num(ca.pendingTexts)} 条短信待送达` : '关'),
      ca.on && ca.log ? kv('手机记录', `「${ca.log}」`) : null,
      kv('日历', cal.on ? (cal.date ?? '尚无日期（由剧情规划选定）') : '关'),
      cal.on && cal.routine ? kv('日常安排', cal.routine) : null,
      cal.on ? kv('日期推进', cal.mayMove ? `可以推进（一次最多 ${cal.maxDays || '不限'} 天）` : `需等待 ${cal.wait}`) : null,
      kv('即兴', im.on ? `开 · 世界设定 ${num(im.world)} 字 · 秘密 ${num(im.secrets)} 字 · ${num(im.truths)} 条隐藏真相` : '关'),
      kv('自主推进', yesNo(s.autonomy)), kv('GM 推进场景', yesNo(s.scenarioAuto)),
      live.memory ? kv('记忆', `${num(live.memory.lines)} 行 · GM 章节 ${num(live.memory.gmChapters)} · 队友章节 ${num(live.memory.coplayerChapters)}`) : null));
    if (live.bonds?.length) cards.push(card('关系', h('ul', { class: 'list' }, ...live.bonds.map(b => h('li', { text: `${b.a} — ${b.b}：${b.kind}${b.secret ? '（秘密）' : ''}` })))));
    if (live.errors) cards.push(card('无法读取的部分', ...Object.entries(live.errors).map(([k, v]) => kv(k, v, 'error-text'))));
  }
  $('overview').replaceChildren(...cards);
}

// ---------- actions
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => run(async () => {
  const action = button.dataset.action;
  if (action === 'stop' && !confirm('停止这个频道？它会完成手头的工作后退出。')) return;
  notice({ start: '正在启动…', stop: '正在停止…', restart: '正在重启…' }[action]);
  await api(`/api/channels/${selected}/action`, { action });
  notice({ start: '已启动。', stop: '已停止。', restart: '已重启。' }[action], 'ok');
});
async function run(fn) {
  if (busy || !selected) return; busy = true; setBusy(true);
  try { await fn(); } catch (error) { notice(error.message, 'bad'); }
  finally { busy = false; setBusy(false); await Promise.allSettled([refreshDetail(), refreshChannels(), refreshHost()]); }
}
function setBusy(on) { for (const b of document.querySelectorAll('[data-action], #save-form, #save-yaml, #validate, #reload, #discard')) b.disabled = on; if (!on && detail) renderHead(); }

// ---------- settings form
function display(field, value) {
  if (value === null || value === undefined || value === '') return field.type === 'tri' ? '保持状态文件' : field.key === 'table.language' ? '跟随频道' : '空';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '空';
  return `${value}${field.unit ? ` ${field.unit}` : ''}`;
}
function current(field) {
  if (dirty.has(field.key)) return dirty.get(field.key);
  const v = config?.values?.[field.key]?.set;
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? String(v) : String(v);
}
function input(field) {
  const value = current(field), id = `f-${field.key.replace('.', '-')}`;
  const change = event => {
    const v = event.target.value, saved = (() => { const s = config?.values?.[field.key]?.set; return s === undefined ? '' : Array.isArray(s) ? s.join(', ') : String(s); })();
    if (v === saved) dirty.delete(field.key); else dirty.set(field.key, v);
    renderSavebar(); event.target.closest('.field')?.classList.toggle('changed', dirty.has(field.key));
  };
  if (field.type === 'bool' || field.type === 'tri' || field.type === 'enum') {
    const eff = config?.values?.[field.key]?.default;
    const opts = field.type === 'enum'
      ? field.options.map(o => [o, o === '' ? `默认（${display(field, eff)}）` : o])
      : [['', field.type === 'tri' ? '保持状态文件' : `默认（${display(field, eff)}）`], ['true', '开'], ['false', '关']];
    const sel = h('select', { id, onchange: change }, ...opts.map(([v, label]) => h('option', { value: v, text: label })));
    sel.value = value; return sel;
  }
  return h('input', { id, type: field.type === 'int' ? 'number' : 'text', value, min: field.min, max: field.max, step: field.type === 'int' ? 1 : undefined,
    placeholder: `默认：${display(field, config?.values?.[field.key]?.default)}`, oninput: change, autocomplete: 'off', spellcheck: 'false' });
}
function renderForm() {
  if (!schema || !config) return;
  const q = $('filter').value.trim().toLowerCase(), onlySet = $('only-set').checked;
  const groups = schema.groups.map(g => {
    const fields = schema.fields.filter(x => x.group === g.id).filter(x => !q || x.label.toLowerCase().includes(q) || x.key.includes(q) || x.help.toLowerCase().includes(q))
      .filter(x => !onlySet || config.values[x.key]?.set !== undefined || dirty.has(x.key));
    if (!fields.length) return null;
    const setCount = fields.filter(x => config.values[x.key]?.set !== undefined).length;
    return h('details', { class: 'group', open: q || onlySet || g.id === 'table' ? true : undefined },
      h('summary', {}, h('span', { text: g.title }), setCount ? h('span', { class: 'count', text: `${setCount} 项已设置` }) : null),
      h('p', { class: 'muted small', text: g.help }),
      ...fields.map(field => {
        const v = config.values[field.key] ?? {};
        return h('div', { class: `field${v.set !== undefined ? ' set' : ''}${dirty.has(field.key) ? ' changed' : ''}` },
          h('label', { for: `f-${field.key.replace('.', '-')}` }, h('span', { text: field.label }), h('code', { text: field.key })),
          h('div', { class: 'control' }, input(field),
            v.set !== undefined || dirty.has(field.key) ? h('button', { type: 'button', class: 'quiet small', title: '删除这个键，使用默认值', onclick: () => {
              if (v.set === undefined) dirty.delete(field.key); else dirty.set(field.key, '');
              renderForm(); renderSavebar();
            }, text: '恢复默认' }) : null),
          h('p', { class: 'help', text: `${field.help} 当前生效：${display(field, v.effective)}${v.set !== undefined && String(v.default) !== String(v.effective) ? `；默认：${display(field, v.default)}` : ''}` }));
      }));
  }).filter(Boolean);
  $('form').replaceChildren(...(groups.length ? groups : [h('p', { class: 'muted', text: '没有符合条件的设置。' })]));
}
$('filter').oninput = renderForm; $('only-set').onchange = renderForm;
function renderSavebar() {
  $('savebar').hidden = dirty.size === 0;
  $('dirty-count').hidden = dirty.size === 0; $('dirty-count').textContent = dirty.size;
  const names = [...dirty.keys()].map(k => schema.fields.find(x => x.key === k)?.label ?? k);
  $('savebar-text').textContent = `${dirty.size} 项修改：${names.slice(0, 4).join('、')}${names.length > 4 ? ' 等' : ''}`;
}
$('discard').onclick = () => { dirty.clear(); renderForm(); renderSavebar(); };
$('save-form').onclick = () => run(async () => {
  const changes = Object.fromEntries([...dirty].map(([k, v]) => [k, v === '' ? null : v]));
  const field = k => schema.fields.find(x => x.key === k);
  for (const [k, v] of Object.entries(changes)) if (v !== null && field(k)?.type === 'int') changes[k] = Number(v);
  const saved = await api(`/api/channels/${selected}/form`, { changes, revision: config.revision });
  config = { yaml: saved.yaml, revision: saved.revision, values: saved.values };
  $('yaml').value = saved.yaml; dirty.clear(); renderForm(); renderSavebar();
  notice(saved.restarted ? '已保存。频道正在以新设置重启。' : '已保存。频道未运行，下次启动时生效。', 'ok');
});

// ---------- YAML
$('validate').onclick = async () => {
  try { await api(`/api/channels/${selected}/validate`, { yaml: $('yaml').value }); $('yaml-result').textContent = '✓ 配置有效'; $('yaml-result').className = 'small ok-text'; }
  catch (error) { $('yaml-result').textContent = `✗ ${error.message}`; $('yaml-result').className = 'small error-text'; }
};
$('save-yaml').onclick = () => run(async () => {
  if (dirty.size && !confirm('设置页还有未保存的修改，保存 YAML 会丢弃它们。继续？')) return;
  const saved = await api(`/api/channels/${selected}/config`, { yaml: $('yaml').value, revision: config.revision });
  config = { yaml: saved.yaml, revision: saved.revision, values: saved.values };
  dirty.clear(); renderForm(); renderSavebar(); $('yaml-result').textContent = '';
  notice(saved.restarted ? '已保存。频道正在以新配置重启。' : '已保存。频道未运行，下次启动时生效。', 'ok');
});
$('reload').onclick = () => { if (confirmDiscard()) loadConfig().then(() => notice('配置已重新载入。')).catch(e => notice(e.message, 'bad')); };
$('yaml').addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const t = event.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); }
});

// ---------- logs
// One request at a time, and only lines newer than the last one shown: polls that overlap (a slow host or proxy, a tab
// switch during a poll) would otherwise append the same lines again.
let logLoading = null;
function refreshLogs() {
  if (!selected) return Promise.resolve();
  if (logLoading) return logLoading;
  const id = selected;
  logLoading = (async () => {
    const data = await api(`/api/channels/${id}/logs?after=${logSeq}`);
    if (id !== selected) return;                                 // another channel was chosen meanwhile
    if (data.last < logSeq) { logSeq = 0; logLines = []; }       // the host restarted
    const fresh = data.lines.filter(l => l.seq > logSeq);
    if (!fresh.length) return;
    logSeq = Math.max(logSeq, ...fresh.map(l => l.seq)); logLines.push(...fresh); if (logLines.length > 1500) logLines.splice(0, logLines.length - 1500);
    renderLogs();
  })().finally(() => { logLoading = null; });
  return logLoading;
}
function renderLogs() {
  const q = $('log-filter').value.trim().toLowerCase(), errorsOnly = $('log-errors').checked, bad = /error|fail|refus|exception|denied|exited|bad_request|timed? ?out|✗/i;
  const shown = logLines.filter(l => (!q || l.text.toLowerCase().includes(q)) && (!errorsOnly || bad.test(l.text)));
  const log = $('log');
  log.replaceChildren(...shown.map(l => h('div', { class: bad.test(l.text) ? 'line bad' : l.text.startsWith('[host]') ? 'line host' : 'line' },
    h('span', { class: 'at', text: new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false }) }), l.text.replace(/^\d\d:\d\d:\d\d /, ''))));
  if (!shown.length) log.append(h('div', { class: 'line muted', text: logLines.length ? '没有符合条件的日志。' : '暂无日志。' }));
  if ($('log-follow').checked) log.scrollTop = log.scrollHeight;
}
$('log-filter').oninput = renderLogs; $('log-errors').onchange = renderLogs;
$('log-clear').onclick = () => { logLines = []; renderLogs(); };

// ---------- polling
window.addEventListener('beforeunload', event => { if (token && unsaved()) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => {
  if (!token || busy) return;
  refreshChannels().catch(error => notice(error.message, 'bad'));
  if (selected && tab === 'overview') refreshDetail().catch(() => {});
  else if (selected && detail) api(`/api/channels/${selected}/status`).then(d => { detail = d; renderHead(); }).catch(() => {});
}, 4000);
setInterval(() => { if (token && !busy && selected && tab === 'logs') refreshLogs().catch(() => {}); }, 2500);
setInterval(() => { if (token && !busy) refreshHost().catch(() => {}); }, 30000);

// ---------- hosting tasks: create, auto-start / prepare switches, remove
let platform = null;
const CREATE_FIELDS = ['table.language', 'table.coplayers', 'table.level', 'modes.casual', 'timelines.scene_forks', 'autonomy.enabled', 'planner.enabled'];
const source = () => document.querySelector('input[name=source]:checked').value;
function createRule() {
  if (source() === 'new') return $('c-rule').value;
  return platform?.channels.find(c => c.id === $('c-channel').value)?.rule ?? null;
}
function renderCreateSettings() {
  const keep = Object.fromEntries([...document.querySelectorAll('#c-settings [data-key]')].map(el => [el.dataset.key, el.value]));
  const fields = CREATE_FIELDS.map(k => schema.fields.find(x => x.key === k)).filter(Boolean).filter(x => x.key !== 'table.level' || createRule() === 'dnd2024');
  $('c-settings').replaceChildren(...fields.map(field => {
    const def = platform?.defaults?.[field.key]?.default, id = `c-${field.key.replace('.', '-')}`;
    let control;
    if (field.type === 'int' || field.type === 'string') control = h('input', { id, 'data-key': field.key, type: field.type === 'int' ? 'number' : 'text', min: field.min, max: field.max, placeholder: `默认：${display(field, def)}`, autocomplete: 'off' });
    else {
      const opts = field.type === 'enum' ? field.options.map(o => [o, o === '' ? `默认（${display(field, def)}）` : o])
        : [['', field.type === 'tri' ? '默认（关）' : `默认（${display(field, def)}）`], ['true', '开'], ['false', '关']];
      control = h('select', { id, 'data-key': field.key }, ...opts.map(([v, label]) => h('option', { value: v, text: label })));
    }
    if (keep[field.key] !== undefined) control.value = keep[field.key];
    if (field.key === 'modes.casual') control.addEventListener('change', explainCasual);
    return h('div', { class: 'field' }, h('label', { for: id }, h('span', { text: field.label }), h('code', { text: field.key })),
      h('div', { class: 'control' }, control), h('p', { class: 'help', text: field.help }));
  }));
  explainCasual();
}
function explainCasual() {
  const casual = $('c-modes-casual')?.value === 'true';
  $('c-rule-help').textContent = `规则系统之后可在平台的 GM 工作区中更改。${casual ? '日常模式会把新频道设为“隔离”知识模式，让每位玩家的手机保持私密。' : '新频道使用“公开”知识模式；开启日常模式则为“隔离”。'}${$('c-rule').value === 'pbta' ? ' PbtA 频道需要先在 GM 工作区审核规则草案，审核前不会开始主持。' : ''}`;
}
function renderPlatform() {
  $('create-account').textContent = platform?.account ?? '';
  const free = platform.channels.filter(c => !c.hosted);
  $('c-channel').replaceChildren(
    h('option', { value: '', text: free.length ? '选择频道…' : '（没有可接入的频道）' }),
    ...platform.channels.map(c => h('option', { value: c.id, disabled: c.hosted ? true : undefined,
      text: `${c.name} — ${c.server} · ${RULES[c.rule] ?? c.rule} · ${c.knowledge === 'isolated' ? '隔离' : '公开'}${c.hosted ? '（已在主持）' : ''}` })));
  $('c-channel-help').textContent = platform.channels.length
    ? `GM 账户是这些频道的 GM。${free.length ? '' : '它们都已在主持中。'}要接入其他频道，先在网页端把 ${platform.account} 设为该频道的 GM。`
    : `${platform.account} 还不是任何频道的 GM。在网页端把它设为某个频道的 GM，或在这里新建频道。`;
  const current = $('c-server').value;
  $('c-server').replaceChildren(h('option', { value: '', text: '＋ 新建服务器' }), ...platform.servers.map(x => h('option', { value: x.id, text: x.name })));
  $('c-server').value = platform.servers.some(x => x.id === current) ? current : '';
  $('c-server-name-row').hidden = Boolean($('c-server').value);
  renderCreateSettings();
}
async function loadPlatform() {
  $('create-status').textContent = '正在读取平台上的频道…';
  try { platform = await api('/api/platform'); renderPlatform(); $('create-status').textContent = ''; }
  catch (error) { $('create-status').textContent = `无法读取平台：${error.message}`; $('create-status').className = 'small error-text'; throw error; }
}
$('new-task').onclick = async () => {
  if (busy || !confirmDiscard()) return;
  selected = ''; dirty.clear(); detail = null; config = null;
  $('empty').hidden = true; $('channel').hidden = true; $('create').hidden = false; $('create-result').hidden = true; resetCreate();
  $('create-status').className = 'muted small';
  await refreshChannels().catch(() => {});
  await loadPlatform().catch(() => {});
};
// A fresh form for the next task: no settings, switches back on, names cleared (the source and server stay).
function resetCreate() {
  for (const id of ['c-name', 'c-era', 'c-server-name']) $(id).value = '';
  for (const id of ['c-enabled', 'c-prepare', 'c-start']) $(id).checked = true;
  $('c-settings').replaceChildren(); renderCreateSettings();
}
$('create-cancel').onclick = () => { $('create').hidden = true; $('empty').hidden = false; };
$('c-refresh').onclick = () => loadPlatform().catch(() => {});
for (const radio of document.querySelectorAll('input[name=source]')) radio.onchange = () => {
  $('source-existing').hidden = source() !== 'existing'; $('source-new').hidden = source() !== 'new'; renderCreateSettings();
};
$('c-channel').onchange = renderCreateSettings; $('c-rule').onchange = renderCreateSettings;
$('c-server').onchange = () => { $('c-server-name-row').hidden = Boolean($('c-server').value); };
$('create-submit').onclick = async () => {
  if (busy) return;
  const settings = {};
  for (const el of document.querySelectorAll('#c-settings [data-key]')) if (el.value !== '') settings[el.dataset.key] = el.value;
  const body = { source: source(), settings, enabled: $('c-enabled').checked, prepare_on_start: $('c-prepare').checked, start: $('c-start').checked };
  if (body.source === 'existing') body.channel_id = $('c-channel').value;
  else Object.assign(body, { server_id: $('c-server').value, server_name: $('c-server-name').value, channel_name: $('c-name').value, rule_system: $('c-rule').value, era: $('c-era').value });
  if (body.source === 'existing' && !body.channel_id) { notice('请选择一个频道。', 'bad'); return; }
  if (body.source === 'new' && !confirm(`在平台上新建频道「${body.channel_name || '（未命名）'}」？`)) return;
  busy = true; $('create-submit').disabled = true; $('create-status').className = 'muted small'; $('create-result').hidden = true;
  $('create-status').textContent = body.source === 'new' ? '正在平台上创建频道…' : '正在接入…';
  try {
    const made = await api('/api/channels', body);
    $('create-status').textContent = '';
    const result = $('create-result');
    result.replaceChildren(...[
      h('div', {}, '已', made.created ? '新建并' : '', '接入 ', h('strong', { text: made.name }), `（${RULES[made.rule] ?? made.rule}），配置文件 `, h('code', { text: made.config }), body.start ? '，正在启动。' : '。'),
      made.invite ? h('div', {}, '服务器邀请码：', h('strong', { class: 'mono', text: made.invite }), '（玩家用它加入服务器）') : null,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => select(made.id), text: '查看频道' }))].filter(Boolean));
    result.hidden = false;
    resetCreate();
    notice('主持任务已创建。', 'ok');
    await Promise.allSettled([refreshChannels(), refreshHost(), loadPlatform()]);
  } catch (error) { $('create-status').textContent = `✗ ${error.message}`; $('create-status').className = 'small error-text'; }
  finally { busy = false; $('create-submit').disabled = false; }
};
for (const [id, key] of [['r-enabled', 'enabled'], ['r-prepare', 'prepare_on_start']]) $(id).onchange = () => run(async () => {
  const saved = await api(`/api/channels/${selected}/registry`, { [key]: $(id).checked });
  notice(key === 'enabled' ? (saved.enabled ? '这个频道会随主机自动启动。' : '这个频道不再随主机自动启动。') : (saved.prepareOnStart ? '启动时会准备频道。' : '启动时不再准备频道。'), 'ok');
});
$('remove').onclick = () => {
  if (busy || !selected) return;
  const name = detail?.live?.channel?.name || selected;
  if (!confirm(`移除主持任务「${name}」？\n频道会停止并从公共配置中删去。平台上的频道、配置文件与状态都会保留。`)) return;
  run(async () => {
    const removed = await api(`/api/channels/${selected}/remove`, { confirm: selected });
    selected = ''; detail = null; config = null; dirty.clear();
    $('channel').hidden = true; $('empty').hidden = false;
    notice(`已移除。配置文件 ${removed.config} 保留。`, 'ok');
  });
};
