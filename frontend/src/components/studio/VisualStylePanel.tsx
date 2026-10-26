// Visual style profiles (Phase 5 wires generation to these). Kept here so uploads can be tagged with a style.
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useUi } from '../../store/ui';

export default function VisualStylePanel() {
  const { channelId, channel } = useNav();
  const toast = useUi((s) => s.toast);
  const isGm = channel?.my_role === 'gm';
  const [profiles, setProfiles] = useState<any[]>([]);
  const [form, setForm] = useState({ style_name: '', art_direction: '', color_palette: '', lighting_style: '', rendering_style: '', period_setting: '', negative_constraints: '', aspect_ratio: '16:9' });
  const load = () => { if (channelId) api.styleProfiles(channelId).then(setProfiles).catch(() => undefined); };
  useEffect(load, [channelId]);
  const save = async () => { if (!channelId) return; try { await api.createStyleProfile(channelId, { ...form, color_palette: form.color_palette.split(',').map((x) => x.trim()).filter(Boolean) }); toast('Style profile saved'); setForm({ ...form, style_name: '' }); load(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="card">
      <h3>Visual style profiles</h3>
      <div className="tiny muted">One art direction per campaign so generated and uploaded art stays consistent. Example: “1920s investigative horror, semi-realistic painting, cold grey/dark green palette, localized dim yellow light, low saturation, vintage grain.”</div>
      {profiles.map((p) => <div key={p.id} className="node small"><b>{p.style_name}</b> {p.is_default && <span className="pill ok">default</span>} <span className="tiny muted">v{p.version} · {p.aspect_ratio}</span><div className="tiny muted">{p.art_direction}</div>{isGm && !p.is_default && <button className="ghost small" onClick={async () => { await api.updateStyleProfile(channelId!, p.id, { is_default: true }); load(); }}>make default</button>}</div>)}
      {isGm && (
        <div className="col" style={{ marginTop: 8 }}>
          <input placeholder="Style name" value={form.style_name} onChange={(e) => setForm({ ...form, style_name: e.target.value })} />
          <textarea placeholder="Art direction" value={form.art_direction} onChange={(e) => setForm({ ...form, art_direction: e.target.value })} />
          <div className="row"><input placeholder="palette (#hex, #hex)" value={form.color_palette} onChange={(e) => setForm({ ...form, color_palette: e.target.value })} /><input placeholder="lighting" value={form.lighting_style} onChange={(e) => setForm({ ...form, lighting_style: e.target.value })} /><input placeholder="rendering" value={form.rendering_style} onChange={(e) => setForm({ ...form, rendering_style: e.target.value })} /></div>
          <div className="row"><input placeholder="period / setting" value={form.period_setting} onChange={(e) => setForm({ ...form, period_setting: e.target.value })} /><input placeholder="negative constraints" value={form.negative_constraints} onChange={(e) => setForm({ ...form, negative_constraints: e.target.value })} /><select value={form.aspect_ratio} onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })}><option>16:9</option><option>4:3</option><option>21:9</option></select></div>
          <button className="primary small" onClick={save} disabled={!form.style_name}>Save profile</button>
        </div>
      )}
    </div>
  );
}
