import { cleanText } from '../hypertext.mjs';
const clean = (s, max = 120) => cleanText(s, { max, multiline: false });
export const command = (s, action) => `/forge ${s.id} ${s.revision} ${action}`;
// Fixed native controls, never model-authored scripts. One question per card keeps even expanded say text under 500.
export function questionCard(s, q, index) {
  const prefix = `开局共创 · ${q.id}：`;
  return { content: `${q.id} ${clean(q.text, 900)}\n${q.options.map((o, i) => `${i + 1}. ${clean(o, 120)}`).join('\n')}\n也可直接在此窗口回答。`,
    hypertext: { v: 1, title: `开局共创 · ${q.id}`, runs_per_viewer: 5,
      state: { pick: { type: 'enum', values: [...q.options.map((x, i) => ({ value: `o${i}`, label: clean(x, 120) })), { value: 'suggest', label: '请你提案' }] }, custom: { type: 'text', max: 250 } },
      body: [ { type: 'text', text: clean(q.text, 1800) },
        { type: 'choice', id: 'choice', bind: 'pick', display: 'list' },
        { type: 'input', id: 'custom', label: '补充或自定义（较长回答直接发消息）', bind: 'custom' },
        { type: 'button', id: 'send', label: '提交回答', act: { say: `${prefix}{{pick}} / {{custom}}`, say_kind: 'ooc' },
          enable_if: { any: [{ not: { key: 'pick', empty: true } }, { not: { key: 'custom', empty: true } }] } } ] } };
}
export function actionsFor(s) {
  return s.phase === 'cancelled' ? [['resume','继续筹备']] : s.phase === 'ready' ? [['start','开始正式游戏']] : s.phase === 'applying' ? [['view','查看已确认草案'], ['apply','继续启用'], ['save','保存进度']] : s.phase === 'review'
    ? [['view','查看完整草案'], ['join','加入共创'], ['approve','确认世界、规则和我的角色'], ['test quick','快速试跑'], ['test standard','标准试跑'], ['test deep','深入试跑'], ['apply','全员确认后启用'], ['save','保存草案'], ['cancel','暂停筹备']]
    : [['join','加入共创'], ['next','继续提问'], ['compile','生成完整草案'], ['save','保存草案'], ['cancel','暂停筹备']];
}
export const announcement = (s,label) => `开局共创：${label}（第 ${s.revision} 版）`;
export function controlsCard(s) {
  const actions = actionsFor(s);
  return { content: `开局共创 v${s.revision} · ${s.phase}\n${actions.map(([a,b]) => `${b}：${command(s,a)}`).join('\n')}`,
    hypertext: { v: 1, title: `开局共创 v${s.revision}`, body: actions.map(([a,b],i) => ({ type: 'button', id: `b${i}`, label: b, act: { say: announcement(s,b), say_kind: 'ooc' } })) } };
}

// Interpret only lines actually posted through this card. No private viewer state is read.
export function bindingFor(s,body) {
  const q=s.questions.find(q=>body.hypertext.title===`开局共创 · ${q.id}`);
  return {revision:s.revision,...(q?{question:q.id,prefix:`开局共创 · ${q.id}：`}:{actions:Object.fromEntries(actionsFor(s).map(([a,b])=>[announcement(s,b),a]))})};
}
