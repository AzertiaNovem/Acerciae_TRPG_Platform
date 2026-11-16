// GM-only read view. All story/model strings are text nodes, never HTML.
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n; };
const field = (label, value) => { const p = node('p'); p.append(node('span', `${label} `, 'muted'), node('span', value)); return p; };
const when = at => new Date(at).toLocaleString();

export function renderWorld(root, data) {
  const oldSubject = root.querySelector('[name=subject]')?.value ?? '', oldTarget = root.querySelector('[name=target]')?.value ?? '';
  if (!data) { root.replaceChildren(node('p', '暂无状态快照。主持运行后可查看。', 'muted')); return; }
  if (!data.on) { root.replaceChildren(node('p', '世界状态仅在即兴模式下启用。', 'muted')); return; }
  const names = new Map(data.characters.map(c => [c.id, c.name]));
  const who = id => names.get(id) || id || '世界';
  const title = v => v.target ? `${who(v.subject)} → ${who(v.target)}` : who(v.subject);
  const valueText = value => typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  const conditionText = when => (when.all ?? when.any).map(c => `${data.definitions[c.metric]?.label ?? c.metric} ${{'>=':'≥','<=':'≤','==':'=','!=':'≠'}[c.op] ?? c.op} ${valueText(c.value)}`).join(when.all ? ' 且 ' : ' 或 ');
  const filter = (name, all, value) => {
    const select = node('select'); select.name = name; select.setAttribute('aria-label', all);
    const opt = node('option', all); opt.value = ''; select.append(opt);
    for (const c of data.characters) { const o = node('option', c.name); o.value = c.id; select.append(o); }
    select.value = value; return select;
  };
  const subject = filter('subject', '全部主体', oldSubject), target = filter('target', '全部对象', oldTarget);
  const controls = node('div', null, 'settings-bar'); controls.append(subject, target);
  const content = node('div', null, 'grid'), notice = node('p', `${data.stale ? '上次快照' : '当前状态'} · ${when(data.at)} · v${data.revision}`, 'muted small');
  root.replaceChildren(notice, controls);
  if (data.pending || data.recallPending) root.append(node('p', `状态变更正在等待恢复。${data.pending?.error || '恢复确认前暂停提交新变更。'}`, 'banner error'));
  if (!data.inventoryAvailable) root.append(node('p', data.inventoryError || '背包同步不可用，请更新平台。', 'banner error'));
  root.append(content);
  const card = (heading, ...children) => { const n = node('section', null, 'card'); n.append(node('h3', heading), ...children.filter(Boolean)); return n; };
  let page = 0;
  const draw = () => {
    const matches = v => (!subject.value || v.subject === subject.value) && (!target.value || v.target === target.value);
    const rows = data.values.filter(matches), cards = [];
    if (!rows.length) cards.push(card('当前数值', node('p', '尚未记录匹配的状态。随着剧情需要，GM 会逐步建立。', 'muted')));
    const groups = new Map();
    for (const v of rows.slice(page*40, (page+1)*40)) {
      const key = JSON.stringify([v.subject, v.target]); if (!groups.has(key)) groups.set(key, { label: title(v), entries: [] });
      const d = data.definitions[v.metric];
      const detail = node('details'); detail.append(node('summary', `${d.label} · ${JSON.stringify(v.value)}${d.type === 'number' ? ` / ${d.min}–${d.max}` : ''}`),
        field('含义', d.description), field('变化规则', d.changeRule), d.maxChangePerScene ? field('每场景变化上限', d.maxChangePerScene) : node('span'), field('最近原因', v.reason), field('更新于', when(v.at)));
      for (const t of d.thresholds ?? []) detail.append(field('解锁条件', `${conditionText(t.when)} → ${t.event}`));
      groups.get(key).entries.push(detail);
    }
    for (const {label, entries} of groups.values()) cards.push(card(label, ...entries));
    if (!subject.value && !target.value) {
      const unused = Object.values(data.definitions).filter(d => !data.values.some(v => v.metric === d.id));
      if (unused.length) cards.push(card('已定义，尚未记录数值', ...unused.map(d => field(d.label, `${d.description}；初始值 ${valueText(d.initial)}；${d.changeRule}`))));
    }
    if (rows.length > 40) {
      const next = node('button', '下一页'), prev = node('button', '上一页'); prev.disabled = page===0; next.disabled = (page+1)*40>=rows.length;
      prev.onclick=()=>{page--;draw();}; next.onclick=()=>{page++;draw();};
      cards.push(card(`第 ${page+1} 页 · 共 ${rows.length} 项`, prev, next));
    }
    const events = data.events.filter(e => e.status === 'pending' && matches(e));
    cards.push(card('已解锁，等待剧情落实', ...events.map(e => field(title(e), e.text)), !events.length && node('p', '没有待演事件。', 'muted')));
    for (const c of data.inventory.filter(c => !subject.value || c.id === subject.value)) cards.push(card(`${c.name} · 背包`,
      ...c.items.map(i => field(`${i.name} × ${i.qty}`, i.note)), !c.items.length && node('p', '没有记录物品。', 'muted')));
    cards.push(card('最近变更', ...data.audit.filter(matches).slice(0,30).map(a => field(`${when(a.at)} · ${title(a)}`, `${a.metric ? (data.definitions[a.metric]?.label ?? a.metric)+' ' : ''}${a.type === 'set' ? `${JSON.stringify(a.before)} → ${JSON.stringify(a.after)} · ` : ''}${a.reason}`))));
    content.replaceChildren(...cards);
  };
  subject.onchange = target.onchange = () => { page=0; draw(); }; draw();
}
