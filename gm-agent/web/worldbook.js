// 世界书 and 队友意图: forms over two files in the state directory (host-manager.mjs). They can be edited whether the
// channel is running or not; a running table reads the change at its next turn. Every text is set with textContent
// or value, never as HTML.
'use strict';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = Boolean(v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const BY = { web: '网页', agent: '主持程序', forge: '开局共创' };
const when = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const count = (input, max) => {
  const c = el('span', { class: 'muted small counter' });
  const update = () => { const n = input.value.trim().length; c.textContent = `${n} / ${max}`; c.classList.toggle('bad-text', n > max); };
  input.addEventListener('input', update); update();
  return c;
};
// A save that lost to an edit made elsewhere says so and offers the fresh copy.
const conflictText = '已在别处修改（另一个浏览器或主持程序）。重新载入后再修改并保存。';

export function worldbookEditor(root, { api, notice }) {
  let channel = '', loaded = null, entries = [], saving = false, filter = '', serial = 0, view = { bible: null, hidden: null };
  const plain = () => ({
    bible: view.bible?.value ?? '', hidden: view.hidden?.value ?? '',
    entries: entries.map(e => ({ ...(e.id ? { id: e.id } : {}), title: e.title.trim(), keys: e.keys.split(/[,，、;；\n]/).map(k => k.trim()).filter(Boolean), body: e.body, secret: e.secret, enabled: e.enabled })),
  });
  const dirty = () => Boolean(loaded) && JSON.stringify(plain()) !== loaded.snapshot;
  const savebar = el('div', { class: 'savebar', hidden: true });
  const refreshBar = () => { savebar.hidden = !dirty(); };

  function entryBlock(e) {
    const title = el('input', { type: 'text', value: e.title, maxlength: loaded.limits.title + 20, 'aria-label': '标题', oninput: () => { e.title = title.value; summary(); refreshBar(); } });
    const keys = el('input', { type: 'text', value: e.keys, placeholder: '逗号分隔，例如：港务协会, 协会大楼', 'aria-label': '关键词', oninput: () => { e.keys = keys.value; summary(); refreshBar(); } });
    const body = el('textarea', { class: 'wb-text', rows: 6, value: e.body, 'aria-label': '正文', oninput: () => { e.body = body.value; refreshBar(); } });
    const secret = el('input', { type: 'checkbox', checked: e.secret, onchange: () => { e.secret = secret.checked; summary(); refreshBar(); } });
    const enabled = el('input', { type: 'checkbox', checked: e.enabled, onchange: () => { e.enabled = enabled.checked; summary(); refreshBar(); } });
    const head = el('summary');
    const summary = () => head.replaceChildren(...[el('span', { text: e.title.trim() || '（未命名词条）' }),
      e.secret ? el('span', { class: 'tag', text: '秘密' }) : null, !e.enabled ? el('span', { class: 'tag', text: '停用' }) : null,
      e.id ? null : el('span', { class: 'tag', text: '新' }), el('span', { class: 'muted small', text: e.keys.trim() ? `关键词：${e.keys}` : '' })].filter(Boolean));
    summary();
    const remove = el('button', { type: 'button', class: 'danger', text: '删除词条', onclick: () => {
      if (!confirm(`删除词条“${e.title.trim() || '未命名'}”？保存后生效。`)) return;
      entries = entries.filter(x => x !== e); draw(); refreshBar();
    } });
    return el('details', { class: 'group wb-entry', open: e.open || null, ontoggle: ev => { e.open = ev.target.open; } }, head,
      el('div', { class: 'field' }, el('label', {}, el('span', { text: '标题' })), el('div', { class: 'control' }, title)),
      el('div', { class: 'field' }, el('label', {}, el('span', { text: '关键词' }), el('code', { text: `最多 ${loaded.limits.keys} 个` })), el('div', { class: 'control' }, keys),
        el('p', { class: 'help', text: '标题或任一关键词出现在聊天里时，这个词条就会被使用。拉丁字母按整词匹配，中文按包含匹配；单个字符的关键词会被忽略。' })),
      el('div', { class: 'field' }, el('label', {}, el('span', { text: '可见范围' })), el('div', { class: 'control' },
        el('label', { class: 'check' }, secret, ' 秘密（只给 GM、NPC 与剧情规划）'), el('label', { class: 'check' }, enabled, ' 启用'))),
      el('div', { class: 'wb-body' }, el('div', { class: 'row' }, el('strong', { text: '正文' }), count(body, loaded.limits.body)), body),
      el('div', { class: 'row' }, remove));
  }

  let list = null, total = null;
  function draw() {
    const shown = entries.filter(e => !filter || `${e.title} ${e.keys}`.toLowerCase().includes(filter));
    list.replaceChildren(...shown.map(entryBlock), ...(shown.length ? [] : [el('p', { class: 'muted', text: entries.length ? '没有匹配的词条。' : '还没有词条。世界圣经之外的地点、组织、人物与风俗，都可以写成词条，需要时才会用到。' })]));
    total.textContent = `${entries.length} / ${loaded.limits.entries}`;
  }

  function render(data) {
    loaded = { ...data, snapshot: '' };
    entries = data.entries.map(e => ({ id: e.id, title: e.title, keys: e.keys.join(', '), body: e.body, secret: e.secret, enabled: e.enabled, open: false }));
    view.bible = el('textarea', { class: 'wb-text', rows: 12, value: data.bible, 'aria-label': '世界圣经', oninput: refreshBar });
    view.hidden = el('textarea', { class: 'wb-text', rows: 8, value: data.hidden, 'aria-label': '隐藏设定', oninput: refreshBar });
    list = el('div', { class: 'wb-list' }); total = el('span', { class: 'muted small' });
    const search = el('input', { type: 'search', placeholder: '按标题或关键词筛选', 'aria-label': '筛选词条', value: filter, oninput: () => { filter = search.value.trim().toLowerCase(); draw(); } });
    const add = el('button', { type: 'button', class: 'primary', text: '＋ 新词条', onclick: () => {
      if (entries.length >= loaded.limits.entries) return notice(`词条最多 ${loaded.limits.entries} 个。`, 'bad');
      filter = ''; search.value = ''; entries.push({ title: '', keys: '', body: '', secret: false, enabled: true, open: true }); draw(); refreshBar();
      list.lastElementChild?.querySelector('input')?.focus();
    } });
    const status = data.exists
      ? `文件 ${data.file} · 第 ${data.revision} 版 · ${when(data.updatedAt)}${data.updatedBy ? ` · 来自${BY[data.updatedBy] ?? data.updatedBy}` : ''}`
      : `文件 ${data.file} 尚未创建。下面是频道当前的世界设定；保存后创建世界书。`;
    root.replaceChildren(
      el('section', { class: 'card' }, el('h3', { text: '世界书' }),
        el('p', { class: 'muted small', text: status }),
        data.improv ? null : el('p', { class: 'banner error', text: '本频道未开启即兴模式，世界书暂不生效。' }),
        el('p', { text: '世界圣经每回合都交给 GM、NPC 与 AI 队友；隐藏设定只给 GM 一方。词条只在需要时使用：标题或关键词出现在该窗口最近的聊天里时（AI 队友只看自己亲历的部分），或 GM 用 worldbook_read 主动查阅时。秘密词条只给 GM、NPC 与剧情规划，AI 队友永远读不到。' }),
        el('p', { class: 'muted small', text: '世界书不会发到聊天里，只保存在运行主持程序的这台机器上。运行中的频道会在下一回合读到修改。' })),
      el('section', { class: 'card' }, el('div', { class: 'row' }, el('h3', { text: '世界圣经（总是使用，所有人都知道）' }), count(view.bible, data.limits.bible)), view.bible),
      el('section', { class: 'card' }, el('div', { class: 'row' }, el('h3', { text: '隐藏设定（总是使用，只给 GM 一方）' }), count(view.hidden, data.limits.hidden)), view.hidden),
      el('section', { class: 'card' }, el('div', { class: 'row' }, el('h3', { text: '词条（需要时才使用）' }), total),
        el('div', { class: 'settings-bar' }, search, add), list),
      savebar);
    draw();
    loaded.snapshot = JSON.stringify(plain());
    refreshBar();
  }

  const discard = el('button', { type: 'button', class: 'quiet', text: '放弃修改', onclick: () => { if (confirm('放弃对世界书的修改？')) load(channel, { force: true }); } });
  const save = el('button', { type: 'button', class: 'primary', text: '保存世界书', onclick: async () => {
    if (saving || !loaded) return;
    saving = true; save.disabled = true;
    try {
      const data = await api(`/api/channels/${channel}/worldbook`, { revision: loaded.revision, book: plain() });
      render(data); notice(`世界书已保存（第 ${data.revision} 版）。`, 'ok');
    } catch (error) { notice(error.status === 409 ? conflictText : `未保存：${error.message}`, 'bad'); }
    finally { saving = false; save.disabled = false; }
  } });
  savebar.append(el('span', { text: '世界书有未保存的修改' }), el('div', {}, discard, save));

  async function load(id, { force = false } = {}) {
    if (!force && id === channel && loaded) return;
    const mine = ++serial;
    channel = id; loaded = null;
    root.replaceChildren(el('p', { class: 'muted', text: '正在读取世界书…' }));
    try { const data = await api(`/api/channels/${id}/worldbook`); if (mine === serial) render(data); }
    catch (error) { if (mine === serial) root.replaceChildren(el('p', { class: 'banner error', text: `无法读取世界书：${error.message}` })); }
  }
  return { load, dirty, reset: () => { channel = ''; loaded = null; filter = ''; root.replaceChildren(); } };
}

export function intentionsEditor(root, { api, notice }) {
  let channel = '', loaded = null, inputs = new Map(), saving = false, serial = 0;
  const changes = () => Object.fromEntries([...inputs].filter(([id, input]) => input.value.trim() !== (loaded.coplayers.find(c => c.id === id)?.intention ?? '')).map(([id, input]) => [id, input.value]));
  const dirty = () => Boolean(loaded) && Object.keys(changes()).length > 0;
  const savebar = el('div', { class: 'savebar', hidden: true });
  const refreshBar = () => { savebar.hidden = !dirty(); };

  function render(data) {
    loaded = data; inputs = new Map();
    const rows = data.coplayers.map(c => {
      const input = el('textarea', { class: 'wb-text', rows: 3, value: c.intention, placeholder: '例如：追求米娜，同时努力维持社团的团结。', 'aria-label': `${c.name} 的意图`, oninput: refreshBar });
      inputs.set(c.id, input);
      return el('section', { class: 'card' }, el('div', { class: 'row' }, el('h3', { text: c.name }), count(input, data.limit)),
        input, el('p', { class: 'muted small', text: c.intention ? `设定于 ${when(c.at)}。清空并保存即可取消。` : '未设定。' }));
    });
    root.replaceChildren(
      el('section', { class: 'card' }, el('h3', { text: '队友意图' }),
        el('p', { text: '为 AI 队友手动设定一个长期意图，例如“追求某人，同时努力维持组织团结”。队友会在合适的时候，以自己的选择一步步去追求它。' }),
        el('p', { class: 'muted small', text: '只有该队友本人读取；GM、剧情规划和其他队友都不知道。意图不会自动完成或改变，需要时在这里修改或清空。它不会越过牌桌规则：不替玩家角色做决定，不逼迫被动在场的角色。' }),
        el('p', { class: 'muted small', text: `文件 ${data.file}${data.revision ? ` · 第 ${data.revision} 版` : ' · 尚未创建'}` })),
      ...(rows.length ? rows : [el('p', { class: 'muted', text: '本频道还没有 AI 队友。启动并准备频道后，队友会出现在这里。' })]),
      savebar);
    refreshBar();
  }

  const discard = el('button', { type: 'button', class: 'quiet', text: '放弃修改', onclick: () => { if (confirm('放弃对意图的修改？')) load(channel, { force: true }); } });
  const save = el('button', { type: 'button', class: 'primary', text: '保存意图', onclick: async () => {
    if (saving || !loaded) return;
    saving = true; save.disabled = true;
    try {
      const data = await api(`/api/channels/${channel}/intentions`, { revision: loaded.revision, changes: changes() });
      render(data); notice('意图已保存。运行中的频道会在队友下一次行动时读到。', 'ok');
    } catch (error) { notice(error.status === 409 ? conflictText : `未保存：${error.message}`, 'bad'); }
    finally { saving = false; save.disabled = false; }
  } });
  savebar.append(el('span', { text: '意图有未保存的修改' }), el('div', {}, discard, save));

  async function load(id, { force = false } = {}) {
    if (!force && id === channel && loaded) return;
    const mine = ++serial;
    channel = id; loaded = null;
    root.replaceChildren(el('p', { class: 'muted', text: '正在读取意图…' }));
    try { const data = await api(`/api/channels/${id}/intentions`); if (mine === serial) render(data); }
    catch (error) { if (mine === serial) root.replaceChildren(el('p', { class: 'banner error', text: `无法读取意图：${error.message}` })); }
  }
  return { load, dirty, reset: () => { channel = ''; loaded = null; root.replaceChildren(); } };
}
