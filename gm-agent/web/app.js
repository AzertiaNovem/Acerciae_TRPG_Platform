let token = '', selected = '', revision = '', busy = false;
const $ = id => document.getElementById(id);
const notice = text => { $('notice').textContent = text; };
async function api(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
}
async function refresh() {
  const channels = await api('/api/channels');
  const fingerprint = JSON.stringify([channels, selected]);
  if ($('channels').dataset.version === fingerprint) return;
  $('channels').dataset.version = fingerprint; $('channels').replaceChildren();
  const labels = { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', failed: '启动失败 / 已退出' };
  for (const channel of channels) {
    const button = document.createElement('button'); button.className = 'channel';
    button.textContent = `${channel.id} · ${labels[channel.status] ?? channel.status}`;
    button.setAttribute('aria-pressed', String(channel.id === selected));
    button.onclick = () => select(channel.id); $('channels').append(button);
  }
}
async function select(id) {
  if (busy) return;
  if (selected && $('yaml').value !== $('yaml').dataset.saved && !confirm('放弃尚未保存的修改？')) return;
  try {
    const data = await api(`/api/channels/${id}/config`);
    selected = id; revision = data.revision; $('title').textContent = id;
    $('yaml').value = data.yaml; $('yaml').dataset.saved = data.yaml;
    $('yaml').disabled = $('save').disabled = $('reload').disabled = false;
    notice('配置已载入。'); await refresh();
  } catch (error) { notice(error.message); }
}
$('login').onsubmit = async event => { event.preventDefault(); token = $('token').value; try { await refresh(); notice('已连接。请选择频道。'); } catch (error) { notice(error.message); } };
$('reload').onclick = () => select(selected);
async function action(fn) {
  if (busy || !selected) return; busy = true; $('save').disabled = true;
  try { await fn(); await refresh(); } catch (error) { notice(error.message); }
  finally { busy = false; $('save').disabled = false; }
}
$('save').onclick = () => action(async () => {
  const yaml = $('yaml').value;
  await api(`/api/channels/${selected}/config`, { yaml, revision });
  const saved = await api(`/api/channels/${selected}/config`); revision = saved.revision; $('yaml').dataset.saved = yaml;
  notice('已保存。正在运行的频道将使用新配置重新启动。');
});
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => action(async () => { await api(`/api/channels/${selected}/action`, { action: button.dataset.action }); notice('操作已完成。'); });
setInterval(() => { if (token && !busy) refresh().catch(error => notice(error.message)); }, 3000);
