import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useUi } from '../../store/ui';
import type { MediaAsset } from '../../types';
import VisualStylePanel from './VisualStylePanel';

const TYPES = ['background', 'standee', 'portrait', 'illustration', 'cover', 'bgm', 'sfx', 'audio'];

// Upload, categorise, approve and reuse backgrounds, standees and audio. Large files live in object storage;
// delivery goes through a permission-checked endpoint.
export default function AssetLibrary() {
  const { channelId, channel, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const isGm = channel?.my_role === 'gm';
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [filter, setFilter] = useState<{ type: string; approval: string }>({ type: '', approval: '' });
  const [form, setForm] = useState({ asset_type: 'background', name: '', character_id: '', expression: 'default', tags: '', license: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { if (channelId) api.mediaList(channelId, filter.type || undefined, undefined, filter.approval || undefined).then(setAssets).catch(() => undefined); };
  useEffect(load, [channelId, filter.type, filter.approval]);
  const upload = async () => {
    if (!channelId || !file) return; setBusy(true);
    try { await api.mediaUpload(channelId, file, { asset_type: form.asset_type, name: form.name || file.name, character_id: form.character_id, expression: form.expression, tags: form.tags, license_metadata: JSON.stringify({ note: form.license }) }); toast('Asset uploaded'); setFile(null); setForm({ ...form, name: '' }); load(); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const setApproval = async (a: MediaAsset, approval_status: MediaAsset['approval_status']) => { if (!channelId) return; await api.mediaUpdate(channelId, a.id, { approval_status }); load(); };
  const isImage = (a: MediaAsset) => a.mime.startsWith('image/');
  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>Upload asset</h3>
          <div className="tiny muted">Images: PNG/JPEG/WebP/GIF (20 MB). Audio: WAV/MP3/OGG/FLAC/M4A (50 MB). Content is sniffed; the declared type is not trusted. Standees should have transparent backgrounds.</div>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <select value={form.asset_type} onChange={(e) => setForm({ ...form, asset_type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {(form.asset_type === 'standee' || form.asset_type === 'portrait') && <><select value={form.character_id} onChange={(e) => setForm({ ...form, character_id: e.target.value })}><option value="">character…</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input placeholder="expression (default, smile, fear…)" value={form.expression} onChange={(e) => setForm({ ...form, expression: e.target.value })} style={{ width: 170 }} /></>}
            <input placeholder="tags, comma separated" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            <input placeholder="licence / source note" value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
            <input type="file" accept="image/*,audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="primary" onClick={upload} disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload'}</button>
          </div>
        </div>
        <VisualStylePanel />
      </div>
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>Assets <span className="pill">{assets.length}</span></h3><span className="grow" />
          <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">all types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          {isGm && <select value={filter.approval} onChange={(e) => setFilter({ ...filter, approval: e.target.value })}><option value="">all states</option><option value="candidate">candidates (review)</option><option value="approved">approved</option><option value="rejected">rejected</option></select>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginTop: 10 }}>
          {assets.map((a) => (
            <div key={a.id} className="node" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {isImage(a) ? <img src={api.mediaUrl(channelId!, a.id, a.version)} alt={a.name} style={{ width: '100%', height: 110, objectFit: a.asset_type === 'standee' ? 'contain' : 'cover', borderRadius: 6, background: '#0b0e14' }} /> : <audio controls src={api.mediaUrl(channelId!, a.id, a.version)} style={{ width: '100%' }} />}
              <div className="small" style={{ fontWeight: 600 }}>{a.name}</div>
              <div className="tiny muted">{a.asset_type} · v{a.version} · {Math.round(a.bytes / 1024)} KB{a.width ? ` · ${a.width}×${a.height}` : ''}{a.character_id ? ` · ${characters.find((c) => c.id === a.character_id)?.name ?? ''}${a.expression ? ` (${a.expression})` : ''}` : ''}</div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <span className={`pill ${a.source_type === 'generated' ? 'ai' : a.source_type === 'mock' ? 'danger' : ''}`}>{a.source_type === 'mock' ? 'MOCK (not real art)' : a.source_type}</span>
                <span className={`pill ${a.approval_status === 'approved' ? 'ok' : a.approval_status === 'rejected' ? 'danger' : ''}`}>{a.approval_status}</span>
                {a.visibility_scope === 'gm' && <span className="pill gm">GM</span>}
              </div>
              {isGm && a.approval_status !== 'approved' && <div className="row"><button className="small primary" onClick={() => setApproval(a, 'approved')}>approve</button><button className="small" onClick={() => setApproval(a, 'rejected')}>reject</button></div>}
              {isGm && <button className="ghost small" onClick={async () => { if (!channelId || !confirm('Delete this asset?')) return; try { await api.mediaDelete(channelId, a.id); load(); } catch (e: any) { toast(e.message, 'error'); } }}>delete</button>}
            </div>
          ))}
          {assets.length === 0 && <div className="muted small">No assets yet.</div>}
        </div>
      </div>
    </div>
  );
}
