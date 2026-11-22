// Creation follows the runtime's mode dependencies. Hidden branches are drafts, never submitted settings.
export const FEATURES = [
  { key: 'planner.enabled', title: '剧情规划', help: '即兴故事中规划长期线索与人物关系；模组故事中主要把握节奏。规划会增加模型调用。', children: ['planner.wish_window', 'planner.final_review'] },
  { key: 'autonomy.enabled', title: '自主推进', help: '允许 GM 在短暂冷场时推进，以及让 AI 队友独处的支线继续。玩家长期离开后，共享场景会停下。', children: ['autonomy.max_turns_per_hour', 'autonomy.idle_minutes'] },
  { key: 'timelines.scene_forks', title: '私有场景分叉', help: '适合多人分头行动：主聊天成为大厅，故事在各自的场景窗口进行。每位玩家还需分属独立玩家组。', children: ['timelines.max_active'] },
  { key: 'illustrations.enabled', title: '剧情插画', help: '为剧情中的时刻配图，也可让玩家请求回顾插画。需要平台配置图像服务，绘图费用另计。', children: ['illustrations.max_per_hour', 'illustrations.requests_per_hour', 'illustrations.allow_cloud'] },
];
export const BASICS = ['table.language', 'table.coplayers', 'table.level'];
const PHONE_FIELDS = ['modes.casual_max_delay_minutes', 'modes.casual_ai_texts_per_hour', 'modes.casual_ai_chain', 'calendar.max_days'];
const RULES = { coc7e: 'CoC 7e', dnd2024: 'D&D 2024', pbta: 'PbtA' };
const STEPS = ['频道', '故事模式', '配套功能', '邀请玩家', '确认启动'];
const playerLabel = p => p.display_name && p.display_name !== p.username ? `${p.display_name}（@${p.username}）` : `@${p.username}`;
const isOn = v => v === true || v === 'true';
export function effective(draft, key, defaults = {}, channel = null) {
  if (key === 'modes.casual' && channel?.saved?.forgePhase === 'playing') return Boolean(channel.saved.casual);
  const raw = draft.values[key];
  if (raw !== undefined && raw !== '') return raw;
  if (key === 'modes.casual') return channel?.saved?.casual ?? defaults[key]?.default ?? false;
  return defaults[key]?.default ?? null;
}
export function branches(draft, channel, defaults = {}) {
  const improv = draft.story === 'improv' || (draft.story === 'inherit' && Boolean(channel?.saved?.improv || channel?.saved?.forgePhase));
  const casual = isOn(effective(draft, 'modes.casual', defaults, channel));
  const isolated = draft.source === 'new' ? casual || isOn(effective(draft, 'timelines.scene_forks', defaults)) : channel?.knowledge === 'isolated';
  const pendingForge = Boolean(channel?.saved?.forgePhase && channel.saved.forgePhase !== 'playing');
  const forge = draft.story === 'improv' && draft.world === 'forge' && !channel?.saved?.forgePhase;
  return { improv, casual, isolated, forge, pendingForge, playedForge: channel?.saved?.forgePhase === 'playing',
    forksReason: draft.source === 'existing' && !isolated ? '此频道为公开知识模式，场景内容对所有玩家可见。先在平台改为隔离模式并刷新，才能配置私有场景。' : '' };
}
function featureChildren(feature, draft, channel, defaults) {
  const b = branches(draft, channel, defaults);
  return feature.children.filter(k => k !== 'planner.wish_window' || b.improv)
    .filter(k => k !== 'illustrations.requests_per_hour' || b.improv && isOn(effective(draft, 'planner.enabled', defaults)) && isOn(effective(draft, 'planner.wish_window', defaults)));
}
function phoneFields(draft, channel, defaults) {
  const b = branches(draft, channel, defaults);
  return b.casual ? PHONE_FIELDS.filter(k => k === 'calendar.max_days' || b.isolated) : [];
}
export function availableKeys(draft, channel, defaults = {}) {
  const b = branches(draft, channel, defaults), keys = BASICS.filter(k => k !== 'table.level' || draft.rule === 'dnd2024');
  keys.push('context.daily_token_budget');
  for (const f of FEATURES) {
    if (f.key === 'timelines.scene_forks' && b.forksReason) continue;
    keys.push(f.key);
    if (isOn(effective(draft, f.key, defaults))) keys.push(...featureChildren(f, draft, channel, defaults));
  }
  keys.push(...phoneFields(draft, channel, defaults));
  return keys;
}
export function creationSettings(draft, channel, defaults = {}) {
  const b = branches(draft, channel, defaults), settings = {};
  for (const k of availableKeys(draft, channel, defaults)) {
    const value = draft.values[k];
    if (value !== '' && value !== undefined) settings[k] = value;
  }
  if (draft.story !== 'inherit' || b.pendingForge) settings['modes.improv'] = b.improv;
  settings['forge.enabled'] = b.forge;
  if (!b.playedForge && (draft.source === 'new' || draft.values['modes.casual'] !== undefined && draft.values['modes.casual'] !== '')) settings['modes.casual'] = b.casual;
  if (b.improv && !b.playedForge && !b.pendingForge && draft.story !== 'inherit' && draft.world === 'file') {
    settings['modes.world_file'] = String(draft.values['modes.world_file'] ?? '').trim();
    const secrets = String(draft.values['modes.secrets_file'] ?? '').trim();
    if (secrets) settings['modes.secrets_file'] = secrets;
  }
  // Explicitly turn unavailable defaults off, rather than accidentally inheriting an enabled shared default.
  if (b.forksReason) settings['timelines.scene_forks'] = false;
  return settings;
}

export class CreateWizard {
  constructor({ h, api, getSchema, notice, onBusy, isBusy, onCreated, viewChannel }) {
    Object.assign(this, { h, api, getSchema, notice, onBusy, isBusy, onCreated, viewChannel });
    this.$ = id => document.getElementById(id);
    this.loadId = 0; this.clear();
    const $ = this.$;
    $('create-back').onclick = () => this.go(this.steps()[this.steps().indexOf(this.step) - 1]);
    $('create-next').onclick = () => { if (this.validate(this.step)) this.step === 3 ? this.inviteAndContinue() : this.go(this.steps()[this.steps().indexOf(this.step) + 1]); };
    $('c-player-search').onclick = () => this.searchPlayers();
    $('c-player-query').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); this.searchPlayers(); } };
    $('c-player-query').oninput = () => { this.searchId++; this.matches = []; this.renderPlayers(); };
    $('create-submit').onclick = () => this.submit();
    $('create-cancel').onclick = () => { if (!this.isBusy()) { this.clear(); $('create').hidden = true; $('empty').hidden = false; } };
    $('c-refresh').onclick = () => this.load();
    for (const el of document.querySelectorAll('input[name=source]')) el.onchange = () => {
      this.draft.source = el.value; this.draft.story = ''; this.draft.world = 'forge';
      this.renderSource(); this.changed();
    };
    $('c-channel').onchange = () => { this.draft.story = ''; this.draft.world = this.channel()?.saved?.hasWorld ? 'saved' : 'forge'; this.changed(); };
    $('c-rule').onchange = () => this.changed();
    $('c-server').onchange = () => { $('c-server-name-row').hidden = Boolean($('c-server').value); this.clearError(); };
    for (const id of ['c-name', 'c-server-name', 'c-era']) $(id).oninput = () => this.clearError();
    for (const id of ['c-start', 'c-prepare', 'c-enabled']) $(id).onchange = () => this.renderReview();
  }
  clear() {
    this.searchId = (this.searchId ?? 0) + 1; this.matches = []; this.players = new Map(); this.prepared = null;
    this.loadId++; this.platform = null; this.loading = false; this.done = false; this.step = 0; this.expanded = new Set(); this.wasPlayed = false;
    this.draft = { source: 'existing', story: '', world: 'forge', rule: null, values: {} };
  }
  channel() { return this.draft.source === 'existing' ? this.platform?.channels.find(c => c.id === this.$('c-channel').value) : null; }
  steps() { return this.draft.source === 'new' ? [0, 1, 2, 3, 4] : [0, 1, 2, 4]; }
  async searchPlayers() {
    const q = this.$('c-player-query').value.trim(), request = ++this.searchId;
    if (!q || this.isBusy()) return;
    this.$('c-player-results').textContent = '正在搜索…';
    try {
      const matches = await this.api(`/api/platform/players?q=${encodeURIComponent(q)}`);
      if (request !== this.searchId) return;
      this.matches = matches; this.renderPlayers();
      if (!matches.length) this.$('c-player-results').textContent = '没有找到匹配的账号。';
    } catch (e) { if (request === this.searchId) this.$('c-player-results').textContent = `搜索失败：${e.message}`; }
  }
  renderPlayers() {
    const { h } = this, $ = this.$, busy = this.isBusy();
    $('c-player-results').replaceChildren(...this.matches.map(p => h('button', { type: 'button', disabled: busy || this.players.has(p.id) || this.players.size >= 32,
      text: `${this.players.has(p.id) ? '已选' : '选择'} ${playerLabel(p)}`, onclick: () => { this.players.set(p.id, p); this.renderPlayers(); } })));
    $('c-players').replaceChildren(...[...this.players.values()].map(p => h('div', { class: 'row' }, h('span', { text: playerLabel(p) }), p.joined ? h('span', { text: '已在频道' }) : h('button', { type: 'button', text: '移除', disabled: busy, onclick: () => { this.players.delete(p.id); this.renderPlayers(); } }), p.error ? h('span', { class: 'error-text', text: p.error }) : null)));
    $('c-invite-help').textContent = this.prepared ? `平台频道「${this.prepared.name}」已建好。取消向导也会保留频道及已加入的玩家，可从「接入已有频道」继续。` : '也可以先跳过。空频道启用 Forge 时，会等第一位玩家加入才发共创卡。';
    $('c-player-query').disabled = $('c-player-search').disabled = busy;
    if (this.step === 3) $('create-next').textContent = this.players.size ? '邀请并继续' : '跳过邀请';
  }
  async inviteAndContinue() {
    if (this.isBusy()) return;
    if (!this.players.size) { this.go(4); return; }
    this.onBusy(true); this.renderSteps(); this.renderPlayers();
    this.$('create-status').textContent = '正在确认玩家的频道成员资格…';
    let ready = false;
    try {
      this.prepared ??= await this.api('/api/platform/prepare', this.taskBody());
      const result = await this.api('/api/platform/invite', { channel_id: this.prepared.id, player_ids: [...this.players.keys()] });
      for (const p of result) Object.assign(this.players.get(p.id), p);
      ready = [...this.players.values()].every(p => p.joined);
      if (!ready) this.error('部分玩家未能加入。请查看名单中的原因，重试或移除未加入的账号。');
    } catch (e) { this.error(`邀请失败：${e.message}`); }
    finally { this.onBusy(false); this.renderSteps(); this.renderPlayers(); }
    if (ready) this.go(4);
  }
  defaults() { return this.platform?.defaults ?? {}; }
  get(key) { return effective(this.draft, key, this.defaults(), this.channel()); }
  branch() { return branches(this.draft, this.channel(), this.defaults()); }
  clearError() { if (!this.loading && !this.isBusy()) { this.$('create-status').textContent = ''; this.$('create-status').className = 'small muted'; } }
  changed() { this.clearError(); this.redraw(); }
  field(key, { label, help, required = false } = {}) {
    const f = this.getSchema()?.fields.find(f => f.key === key);
    if (!f) return null;
    const { h } = this, id = `c-${key.replaceAll('.', '-')}`, def = effective({ ...this.draft, values: {} }, key, this.defaults(), this.channel());
    const show = v => v === true ? '开启' : v === false ? '关闭' : v === null || v === '' ? '跟随频道' : String(v);
    let el;
    if (['bool', 'tri', 'enum'].includes(f.type)) {
      const choices = f.type === 'enum' ? f.options.filter(Boolean).map(v => [v, v]) : [['true', '开启'], ['false', '关闭']];
      el = h('select', { id, 'data-key': key, 'aria-describedby': id + '-help' },
        h('option', { value: '', text: `${key === 'modes.casual' && this.draft.source === 'existing' ? '沿用本机状态' : '默认'}（${show(def)}）` }),
        ...choices.map(([value, text]) => h('option', { value, text })));
      el.onchange = () => { this.draft.values[key] = el.value; if (isOn(el.value)) this.expanded.add(key); this.changed(); };
    } else {
      el = h('input', { id, 'data-key': key, 'aria-describedby': id + '-help', type: f.type === 'int' ? 'number' : 'text',
        min: f.min, max: f.max, step: f.type === 'int' ? 1 : undefined, maxlength: f.type === 'string' ? 500 : undefined,
        required, placeholder: required ? '' : `默认：${show(def)}`, autocomplete: 'off' });
      el.oninput = () => { this.draft.values[key] = el.value; this.clearError(); };
    }
    el.value = this.draft.values[key] ?? '';
    return h('div', { class: 'field' }, h('label', { for: id, text: label ?? f.label }), h('div', { class: 'control' }, el), h('p', { id: id + '-help', class: 'help', text: help ?? f.help }));
  }
  choices(name, label, choices, selected, change) {
    const { h } = this;
    return h('fieldset', { class: 'wizard-choices' }, h('legend', { text: label }), ...choices.map(c => {
      const id = `c-${name}-${c.value}`, radio = h('input', { id, type: 'radio', name, value: c.value, disabled: c.disabled, 'aria-describedby': id + '-help' });
      radio.checked = c.value === selected;
      radio.onchange = () => { change(c.value); this.changed(); };
      return h('label', { class: `wizard-choice${c.disabled ? ' unavailable' : ''}`, for: id }, radio,
        h('span', {}, h('strong', { text: c.title }), h('span', { id: id + '-help', class: 'help', text: c.help })));
    }));
  }
  renderSource() {
    this.$('source-existing').hidden = this.draft.source !== 'existing'; this.$('source-new').hidden = this.draft.source !== 'new';
    for (const radio of document.querySelectorAll('input[name=source]')) radio.checked = radio.value === this.draft.source;
    this.$('c-server-name-row').hidden = Boolean(this.$('c-server').value);
  }
  renderModes() {
    const { h } = this, $ = this.$, b = this.branch(), saved = this.channel()?.saved;
    const choices = [
      ...(this.draft.source === 'existing' ? [{ value: 'inherit', title: '沿用本机已有模式', help: saved ? `本机记录：${saved.improv ? '即兴故事' : '模组故事'}${saved.forgePhase && saved.forgePhase !== 'playing' ? '，有未结束的开局共创' : ''}。保留故事与角色的进展。` : '本机还没有这个频道的故事记录，将按模组模式接入。' }] : []),
      { value: 'module', title: '模组故事', help: b.pendingForge ? '此频道有未结束的开局共创，请先沿用已有模式完成共创。' : b.playedForge ? '此频道已通过共创开局，请沿用已确认的世界。' : '以平台上导入的模组、线索和场景为依据，GM 跟随玩家行动主持。', disabled: b.pendingForge || b.playedForge },
      { value: 'improv', title: '即兴故事', help: '从世界和人物关系出发，由 GM 与玩家共同发展剧情。可以先共创开局，或带入已有世界。' },
    ];
    $('c-story').replaceChildren(this.choices('story', '故事从哪里来？', choices, this.draft.story, v => { this.draft.story = v; }));
    const world = [];
    if (b.pendingForge) world.push(h('p', { class: 'wizard-note', text: '启动后恢复本机已保留的共创草案；世界和角色继续在共创窗口中修改。' }));
    if (this.draft.story === 'improv' && !b.pendingForge) {
      world.push(this.choices('world', '如何准备世界？', [
        { value: 'forge', title: '一起共创开局 · Forge', help: saved?.forgePhase === 'playing' ? '这个频道已经结束共创并正式开局，请沿用已有世界。' : '在准备窗口交流想法、完善世界与角色。全体参与者确认，再显式开始游戏；会产生额外模型调用。', disabled: saved?.forgePhase === 'playing' },
        ...(saved?.hasWorld ? [{ value: 'saved', title: '沿用已保存的世界', help: '使用这台主机保存的世界设定与秘密，继续现有故事。' }] : []),
        { value: 'file', title: '使用已有世界文件', help: b.playedForge ? '此频道已通过共创开局，接入时不会重新导入世界文件。' : '适合已经准备好世界设定的主持人。填写运行 GM 主机上的文件位置。', disabled: b.playedForge },
      ], this.draft.world, v => { this.draft.world = v; }));
      if (this.draft.world === 'file') world.push(this.field('modes.world_file', { required: true, help: '必填。运行 GM 的主机上的文件；相对位置以新频道配置文件所在目录为起点。' }), this.field('modes.secrets_file', { help: '可选。仅 GM 使用的秘密文件，与公开世界分开。' }));
    }
    if (b.improv) world.push(h('div', { class: 'wizard-note', text: '即兴模式自带私密世界账本：NPC 对每位玩家和 AI 队友的态度分别记录，GM 可维护数值、剧情条件及物品。剧情规划可参考这些状态；AI 队友仍保持即兴发挥。' }));
    $('c-world').replaceChildren(...world.filter(Boolean));
    $('c-casual').replaceChildren(...(this.draft.story ? [b.playedForge ? h('p', { class: 'wizard-note', text: `此频道已通过共创开局，将沿用既有的日常模式（${b.casual ? '开启' : '关闭'}），接入时不重新准备世界和角色。` }) : this.field('modes.casual', { label: '日常模式：手机、短信与故事日历', help: '可叠加在模组或即兴故事上。选择即兴并开启日常模式后，下一步还可开启日常托管。' }),
      b.casual ? h('p', { class: 'wizard-note', text: this.draft.source === 'new' ? '新频道将使用隔离知识模式。玩家加入后需各自在独立玩家组中，手机内容才能保持私密。' : b.isolated ? '频道已使用隔离知识模式；还需每位玩家各在独立玩家组中，手机才能启用。' : '此频道为公开知识模式：故事日历可用，但私密手机不能启用。请在平台改为隔离模式、让玩家各在独立组中，再返回第一步刷新。' }) : null].filter(Boolean) : []));
    $('c-rule-help').textContent = `规则系统之后可在平台 GM 工作区更改。${this.draft.rule === 'pbta' ? 'PbtA 在主持前需要确认规则；下一步会解释对应的准备流程。' : ''}`;
  }
  renderFeatures() {
    const { h } = this, $ = this.$, b = this.branch();
    $('c-features-intro').textContent = `${b.improv ? '即兴故事' : '模组故事'}${b.casual ? ' · 日常模式' : ''}。开启功能后展开相关选项；返回上一步修改模式时，只会应用仍适用的设置。`;
    $('c-basics').replaceChildren(...BASICS.filter(k => k !== 'table.level' || this.draft.rule === 'dnd2024').map(k => this.field(k)).filter(Boolean));
    const cards = FEATURES.map(f => {
      const reason = f.key === 'timelines.scene_forks' ? b.forksReason : '';
      const on = !reason && isOn(this.get(f.key));
      return h('section', { class: `wizard-feature${reason ? ' unavailable' : ''}`, 'data-feature': f.key },
        h('div', { class: 'wizard-feature-head' }, h('h4', { text: f.title }), h('span', { class: `chip${on ? ' ok' : ''}`, text: reason ? '需先满足条件' : on ? '已开启' : '可选开启' })),
        h('p', { text: f.help }), reason ? h('p', { class: 'wizard-note', text: reason }) : this.field(f.key, { label: f.title, help: on ? '下方可调整此功能的行为。' : '开启后可以继续设置。' }),
        on ? h('details', { class: 'wizard-dependent', open: this.expanded.has(f.key), ontoggle: e => { if (e.target.isConnected) { if (e.target.open) this.expanded.add(f.key); else this.expanded.delete(f.key); } } }, h('summary', { text: '调整细项' }), ...featureChildren(f, this.draft, this.channel(), this.defaults()).map(k => this.field(k)), f.key === 'daily.enabled' ? h('p', { text: '日常托管在正式开局后生效；私密手机需每位玩家各在独立组中。关闭自主推进不会关闭日常托管，两者分别控制。' }) : null) : null);
    });
    if (b.casual) cards.push(h('details', { class: 'wizard-feature wizard-phone', open: this.expanded.has('phone'), ontoggle: e => { if (e.target.isConnected) { if (e.target.open) this.expanded.add('phone'); else this.expanded.delete('phone'); } } }, h('summary', { text: b.isolated ? '调整短信和日历的节奏' : '调整故事日历的节奏' }), ...phoneFields(this.draft, this.channel(), this.defaults()).map(k => this.field(k))));
    $('c-features').replaceChildren(...cards);
    $('c-budget').replaceChildren(h('h4', { text: '控制日常用量' }), this.field('context.daily_token_budget'), h('p', { text: '规划、短信和插画会增加调用。更细的模型分配、写作风格与节奏可在创建后的“设置”中调整。' }));
  }
  renderReview() {
    const { h } = this, $ = this.$, b = this.branch(), settings = creationSettings(this.draft, this.channel(), this.defaults());
    if (b.playedForge) { if (!this.wasPlayed) this.prepareBefore = $('c-prepare').checked; $('c-prepare').checked = false; }
    else if (this.wasPlayed) $('c-prepare').checked = this.prepareBefore;
    $('c-prepare').disabled = b.playedForge; this.wasPlayed = b.playedForge;
    const row = (name, value) => h('div', { class: 'kv' }, h('span', { text: name }), h('span', { text: value }));
    const items = [row('频道', this.draft.source === 'new' ? $('c-name').value.trim() : this.channel()?.name ?? '尚未选择'), row('规则', RULES[this.draft.rule] ?? ''),
      ...(this.draft.source === 'new' ? [row('受邀玩家', [...this.players.values()].map(playerLabel).join('、') || '未邀请玩家')] : []),
      row('故事模式', `${this.draft.story === 'inherit' ? '沿用 · ' : ''}${b.improv ? '即兴故事' : '模组故事'}`),
      row('世界准备', b.pendingForge ? '继续已保留的开局共创' : b.forge ? '先共创开局，全体确认后再开始' : settings['modes.world_file'] || (b.improv ? '沿用本机已有世界' : '使用频道的模组知识')),
      row('日常模式', b.casual ? '开启' : '关闭'), row('知识可见性', b.isolated ? '隔离；手机和私有场景还需独立玩家组' : '公开'),
      ...BASICS.filter(k => k !== 'table.level' || this.draft.rule === 'dnd2024').map(k => row(this.getSchema().fields.find(f => f.key === k).label, String(this.get(k) ?? '跟随频道'))),
      ...FEATURES.map(f => row(f.title, f.key === 'timelines.scene_forks' && b.forksReason ? '未开启（当前条件不适用）' : isOn(this.get(f.key)) ? '开启' : '关闭')),
      row('每日令牌预算', Number(this.get('context.daily_token_budget')) === 0 ? '不限' : String(this.get('context.daily_token_budget'))),
    ];
    const notices = [];
    if (b.forge || b.pendingForge) notices.push('启动后先进入或恢复开局共创。正式游戏和普通自主推进会等到确认并开始游戏后再运行。');
    if (this.draft.rule === 'pbta') notices.push(b.forge || b.pendingForge ? 'PbtA 的规则、职业与角色卡会随共创一起确认。' : 'PbtA 需要先在平台 GM 工作区审核规则草案；审核前主持会等待。');
    if (!b.improv) notices.push('模组内容在平台 GM 工作区管理；此向导不会自动选择或导入模组。');
    if (this.channel()?.hasModule && b.improv) notices.push('频道仍绑定模组：即兴主持会忽略模组线索。');
    $('c-review').replaceChildren(h('div', { class: 'wizard-review' }, ...items), ...notices.map(text => h('p', { class: 'wizard-note', text })));
    const preparing = $('c-prepare').checked;
    $('c-start-help').textContent = b.playedForge ? '直接恢复已经共创确认的故事与角色；无需重复准备。' : !preparing ? '跳过准备适合沿用已有模式的频道；不会补齐 AI 队友，也不会应用新的世界与日常模式。' : !$('c-start').checked ? '先保存主持任务；手动启动后才会准备频道或进入共创。' : b.forge || b.pendingForge ? '会启动共创准备窗口，等待玩家参与；不会直接替玩家开始正式故事。' : '创建后准备频道并开始监听消息。';
  }
  redraw() {
    const focused = document.activeElement?.id;
    this.draft.rule = this.draft.source === 'new' ? this.$('c-rule').value : this.channel()?.rule;
    this.renderModes(); this.renderFeatures(); this.renderReview(); this.renderSteps();
    if (focused) this.$(focused)?.focus({ preventScroll: true });
  }
  renderSteps() {
    const { h } = this, $ = this.$;
    const steps = this.steps(), first = this.prepared ? 3 : 0;
    $('create-steps').replaceChildren(...steps.map((i, n) => h('button', { type: 'button', disabled: i < first || i > this.step || this.loading || this.isBusy() || this.done, 'aria-current': i === this.step ? 'step' : undefined, onclick: () => this.go(i), text: `${n + 1} · ${STEPS[i]}` })));
    $('create-heading-4').textContent = `${steps.length} · 确认并启动`;
    for (const panel of document.querySelectorAll('[data-create-step]')) panel.hidden = Number(panel.dataset.createStep) !== this.step;
    $('create-flow').hidden = this.done;
    $('create-back').hidden = this.step === first;
    $('create-next').hidden = this.step === 4;
    $('create-next').textContent = '下一步';
    if (this.step === 3) this.renderPlayers();
    $('c-refresh').disabled = this.loading || this.isBusy() || Boolean(this.prepared);
    $('create-submit').hidden = this.step !== 4;
    for (const id of ['create-back', 'create-next', 'create-submit']) $(id).disabled = this.loading || this.isBusy() || !this.platform;
  }
  go(step) {
    if (this.loading || this.isBusy() || !this.steps().includes(step) || this.prepared && step < 3) return;
    this.step = step; this.$('create-status').textContent = ''; this.redraw();
    this.$(`create-heading-${step}`).focus();
  }
  error(message, id) {
    this.$('create-status').textContent = message; this.$('create-status').className = 'small error-text';
    if (id) this.$(id)?.focus();
    return false;
  }
  validate(step) {
    const $ = this.$, b = this.branch();
    if (!this.platform || this.loading) return this.error('请先成功读取平台上的频道。');
    if (step === 0) {
      if (this.draft.source === 'existing' && (!this.channel() || this.channel().hosted)) return this.error('请选择一个尚未接入的频道。', 'c-channel');
      if (this.draft.source === 'new') {
        if (!$('c-name').value.trim()) return this.error('请填写频道名称。', 'c-name');
        if (!$('c-server').value && !$('c-server-name').value.trim()) return this.error('请填写新服务器名称，或选择已有服务器。', 'c-server-name');
      }
    }
    if (step === 1) {
      if (!this.draft.story) return this.error('请先选择故事模式。');
      if ((b.pendingForge || b.playedForge) && this.draft.story === 'module') return this.error('此频道有开局共创记录，请沿用已有模式。');
      if (b.playedForge && this.draft.story === 'improv' && this.draft.world !== 'saved') return this.error('此频道已正式开局，请沿用已确认的世界。');
      if (this.draft.story === 'improv' && !b.pendingForge) {
        if (this.draft.world === 'saved' && !this.channel()?.saved?.hasWorld) return this.error('本机没有可沿用的世界，请选择共创或世界文件。');
        if (this.draft.world === 'forge' && this.channel()?.saved?.forgePhase === 'playing') return this.error('此频道已正式开局，请选择沿用已有世界。');
        if (this.draft.world === 'file' && !String(this.draft.values['modes.world_file'] ?? '').trim()) return this.error('请填写世界设定文件的位置，或选择共创开局。', 'c-modes-world_file');
      }
    }
    if (step === 4 && !b.playedForge && !$('c-prepare').checked && (this.draft.story !== 'inherit' || this.draft.values['modes.casual'] !== undefined && this.draft.values['modes.casual'] !== '')) return this.error('所选模式需要在启动时应用，请开启“启动时准备频道”。', 'c-prepare');
    const panel = document.querySelector(`[data-create-step="${step}"]`);
    for (const input of panel.querySelectorAll('input, select')) if (!input.disabled && !input.checkValidity()) { const details = input.closest('details'); if (details) details.open = true; input.reportValidity(); return false; }
    return true;
  }
  async open() {
    this.clear(); const $ = this.$;
    for (const id of ['c-name', 'c-era', 'c-server-name', 'c-player-query']) $(id).value = '';
    for (const id of ['c-enabled', 'c-prepare', 'c-start']) { $(id).checked = true; $(id).disabled = false; }
    $('create-result').hidden = true; $('create-cancel').textContent = '取消'; this.renderSource(); this.redraw();
    await this.load();
  }
  async load() {
    const request = ++this.loadId, $ = this.$;
    this.loading = true; $('c-refresh').disabled = true; $('create-status').className = 'small muted'; $('create-status').textContent = '正在读取可主持的频道…'; this.renderSteps();
    const selected = $('c-channel').value, server = $('c-server').value;
    try {
      const platform = await this.api('/api/platform');
      if (request !== this.loadId) return;
      this.platform = platform;
      const { h } = this, free = platform.channels.filter(c => !c.hosted);
      $('create-account').textContent = platform.account;
      $('c-channel').replaceChildren(h('option', { value: '', text: free.length ? '选择频道…' : '没有可接入的频道' }), ...platform.channels.map(c => h('option', { value: c.id, disabled: c.hosted, text: `${c.name} — ${c.server} · ${RULES[c.rule] ?? c.rule}${c.hosted ? '（已在主持）' : ''}` })));
      $('c-channel').value = free.some(c => c.id === selected) ? selected : '';
      $('c-channel-help').textContent = free.length ? '这里列出该账户担任 GM 的频道。接入后会沿用平台中的角色和聊天。' : '没有可接入的频道。可在平台将此账户设为频道 GM 后刷新，或选择新建频道。';
      $('c-server').replaceChildren(h('option', { value: '', text: '新建服务器' }), ...platform.servers.map(s => h('option', { value: s.id, text: s.name })));
      $('c-server').value = platform.servers.some(s => s.id === server) ? server : '';
      this.renderSource(); $('create-status').textContent = '';
    } catch (e) { if (request === this.loadId) { this.platform = null; this.error(`无法读取平台：${e.message}。可点击“刷新”重试。`); } }
    finally { if (request === this.loadId) { this.loading = false; $('c-refresh').disabled = false; this.redraw(); } }
  }
  taskBody() {
    const $ = this.$, body = { source: this.draft.source, settings: creationSettings(this.draft, this.channel(), this.defaults()), enabled: $('c-enabled').checked, prepare_on_start: $('c-prepare').checked, start: $('c-start').checked };
    if (this.prepared) {
      if ($('c-era').value.trim()) body.settings['channel.era'] = $('c-era').value.trim();
      return { ...body, source: 'existing', channel_id: this.prepared.id, expected_players: [...this.players.keys()] };
    }
    if (body.source === 'existing') return { ...body, channel_id: $('c-channel').value };
    return { ...body, server_id: $('c-server').value, server_name: $('c-server-name').value.trim(), channel_name: $('c-name').value.trim(), rule_system: this.draft.rule, era: $('c-era').value.trim() };
  }
  async submit() {
    if (this.isBusy() || this.loading || this.done || this.step !== 4) return;
    for (const step of this.steps()) {
      // Validate in the visible panel so native validity feedback and focus work after going back.
      this.step = step; this.renderSteps();
      if (!this.validate(step)) return;
    }
    const $ = this.$, body = this.taskBody();
    this.onBusy(true); this.renderSteps();
    // Freeze all draft controls while the request is in flight, including source and startup switches.
    const controls = [...document.querySelectorAll('#create input, #create select, #create button')].map(el => [el, el.disabled]);
    for (const [el] of controls) el.disabled = true;
    $('create-status').className = 'small muted'; $('create-status').textContent = body.source === 'new' ? '正在创建频道和主持任务…' : '正在接入频道…';
    try {
      const made = await this.api('/api/channels', body), { h } = this;
      this.done = true; $('create-status').textContent = ''; $('create-cancel').textContent = '完成';
      const invite = made.invite ?? this.prepared?.invite;
      $('create-result').replaceChildren(h('p', { text: `已${made.created || this.prepared ? '新建并' : ''}接入「${made.name}」。${body.start ? this.branch().forge || this.branch().pendingForge ? '正在进入开局共创。' : '正在准备并启动主持。' : '任务已保存，可稍后手动启动。'}` }),
        invite ? h('p', { text: `服务器邀请码：${invite}` }) : null, h('button', { type: 'button', class: 'primary', onclick: () => this.viewChannel(made.id), text: '查看频道' }));
      // The form gives way to the result at once, not after the lists below are reloaded.
      $('create-result').hidden = false; $('create-flow').hidden = true; this.notice('主持任务已创建。', 'ok');
      await this.onCreated();
    } catch (e) { this.error(`创建失败：${e.message}`); }
    finally { for (const [el, disabled] of controls) el.disabled = disabled; this.onBusy(false); this.renderSteps(); }
  }
}
