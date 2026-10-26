import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import type { LogEvent } from '../../types';

const TYPES = ['dialogue', 'action', 'narration', 'dice_roll', 'system', 'ooc', 'scene_change', 'media', 'secret'];

// Organises the canonical log: classification, speaker identity, scene boundaries. Content is immutable here.
export default function LogEditor() {
  const { channelId, characters } = useNav();
  const { project, events, scenes, reloadEvents } = useStudio();
  const toast = useUi((s) => s.toast);
  const [filter, setFilter] = useState<{ type: string; speaker: string; scene: string; q: string }>({ type: '', speaker: '', scene: '', q: '' });
  const [suggestions, setSuggestions] = useState<{ from_seq: number; reason: string; title: string }[] | null>(null);
  const speakers = useMemo(() => { const m = new Map<string, string>(); for (const e of events) m.set(e.speaker_key, e.speaker_display_name); return [...m.entries()]; }, [events]);
  if (!project || !channelId) return <div className="card muted">Select a log project in the Library first.</div>;
  const visible = events.filter((e) => (!filter.type || e.event_type === filter.type) && (!filter.speaker || e.speaker_key === filter.speaker) && (!filter.scene || e.scene_key === filter.scene) && (!filter.q || e.content.toLowerCase().includes(filter.q.toLowerCase())));
  const patch = async (e: LogEvent, body: Partial<LogEvent>) => { try { await api.studioUpdateEvent(channelId, project.id, e.event_id, body); await reloadEvents(channelId); } catch (err: any) { toast(err.message, 'error'); } };
  const split = async (e: LogEvent) => { const title = prompt('Title of the new scene starting here', e.scene_title || ''); if (title === null) return; await api.studioSplitScene(channelId, project.id, e.sequence_number, title); await reloadEvents(channelId); };
  const rename = async (key: string, cur: string) => { const t = prompt('Scene title', cur); if (t === null) return; await api.studioRenameScene(channelId, project.id, key, t); await reloadEvents(channelId); };
  const merge = async (key: string) => { const into = prompt('Merge into scene key (see list)'); if (!into) return; await api.studioMergeScene(channelId, project.id, key, into); await reloadEvents(channelId); };
  const bulkSpeaker = async (speakerKey: string, characterId: string) => {
    const cmap = { ...(project.character_map ?? {}) }; cmap[speakerKey] = { ...(cmap[speakerKey] ?? {}), character_id: characterId || null, display_name: characters.find((c) => c.id === characterId)?.name ?? cmap[speakerKey]?.display_name };
    await api.studioUpdateProject(channelId, project.id, { character_map: cmap }); await reloadEvents(channelId);
  };
  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>Scenes <span className="pill">{scenes.length}</span></h3>
          <div className="tiny muted">Scene boundaries drive chapters, backgrounds and PDF sections. Split at any event, merge, rename. Suggestions come from the AI scene memory and time gaps and are never applied automatically.</div>
          <table className="simple" style={{ marginTop: 6 }}><tbody>{scenes.map((s) => <tr key={s.scene_key}><td><b>{s.scene_title || <span className="muted">(untitled)</span>}</b><div className="tiny muted">{s.scene_key} · #{s.from_seq}–{s.to_seq} · {s.n} events</div></td><td className="row"><button className="ghost small" onClick={() => setFilter({ ...filter, scene: s.scene_key })}>filter</button><button className="ghost small" onClick={() => rename(s.scene_key, s.scene_title)}>rename</button><button className="ghost small" onClick={() => merge(s.scene_key)}>merge…</button></td></tr>)}</tbody></table>
          <button className="small" style={{ marginTop: 6 }} onClick={async () => setSuggestions(await api.studioSuggestScenes(channelId, project.id))}>Suggest scene splits</button>
          {suggestions && <div style={{ marginTop: 6 }}>{suggestions.length === 0 && <div className="tiny muted">No suggestions.</div>}{suggestions.map((s, i) => <div key={i} className="row tiny"><span>#{s.from_seq}: {s.reason}{s.title ? ` — ${s.title}` : ''}</span><button className="ghost small" onClick={async () => { await api.studioSplitScene(channelId, project.id, s.from_seq, s.title || 'Scene'); await reloadEvents(channelId); }}>apply</button></div>)}</div>}
        </div>
        <div className="card">
          <h3>Speakers</h3>
          <table className="simple"><tbody>{speakers.map(([k, name]) => <tr key={k}><td>{name}<div className="tiny muted">{k}</div></td><td><select value={project.character_map?.[k]?.character_id ?? events.find((e) => e.speaker_key === k)?.speaker_character_id ?? ''} onChange={(e) => bulkSpeaker(k, e.target.value)}><option value="">— no character —</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'npc' ? ' (NPC)' : ''}</option>)}</select></td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Events <span className="pill">{visible.length}/{events.length}</span></h3><span className="grow" />
          <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">all types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select value={filter.speaker} onChange={(e) => setFilter({ ...filter, speaker: e.target.value })}><option value="">all speakers</option>{speakers.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          <select value={filter.scene} onChange={(e) => setFilter({ ...filter, scene: e.target.value })}><option value="">all scenes</option>{scenes.map((s) => <option key={s.scene_key} value={s.scene_key}>{s.scene_title || s.scene_key}</option>)}</select>
          <input placeholder="search text" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        </div>
        <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>#</th><th>type</th><th>speaker</th><th>content (verbatim)</th><th>vis</th><th /></tr></thead><tbody>
          {visible.slice(0, 600).map((e) => (
            <tr key={e.event_id}>
              <td className="tiny muted">{e.sequence_number}</td>
              <td><select value={e.event_type} onChange={(ev) => patch(e, { event_type: ev.target.value as any })} style={{ fontSize: 11 }}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
              <td className="small">{e.speaker_display_name}<div className="tiny muted">{e.speaker_role}</div></td>
              <td className="small" style={{ whiteSpace: 'pre-wrap', maxWidth: 520 }}>{e.content}{e.dice?.total != null && <span className="pill" style={{ marginLeft: 4 }}>{e.dice.expression}={e.dice.total} {e.dice.outcome}</span>}{e.unrecognised && <span className="pill danger" style={{ marginLeft: 4 }}>raw</span>}</td>
              <td><select value={e.visibility_scope} onChange={(ev) => patch(e, { visibility_scope: ev.target.value as any })} style={{ fontSize: 11 }}><option value="public">public</option><option value="character">character</option><option value="gm">gm</option></select></td>
              <td><button className="ghost small" title="start a new scene here" onClick={() => split(e)}>✂ scene</button></td>
            </tr>
          ))}
        </tbody></table>
        {visible.length > 600 && <div className="tiny muted">Showing the first 600 matching events; narrow the filter to see more.</div>}
      </div>
    </div>
  );
}
