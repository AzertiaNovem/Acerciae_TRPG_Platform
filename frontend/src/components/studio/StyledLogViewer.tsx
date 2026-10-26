import { useMemo, useState } from 'react';
import { useStudio } from '../../store/studio';
import type { LogEvent } from '../../types';

const PALETTE = ['#7c9cff', '#5bd1b9', '#f0b35b', '#ef6b73', '#c9a4ff', '#6fcf97', '#ff9f6e', '#9ad0ff'];

export function speakerColor(e: LogEvent, map: Record<string, any> | undefined, cache: Map<string, string>) {
  const mapped = map?.[e.speaker_key]?.color; if (mapped) return mapped;
  if (e.speaker_role === 'gm') return '#d7b26d';
  if (!cache.has(e.speaker_key)) cache.set(e.speaker_key, PALETTE[cache.size % PALETTE.length]);
  return cache.get(e.speaker_key)!;
}
export function fmtTime(e: LogEvent) { if (e.timestamp) return new Date(e.timestamp * 1000).toLocaleTimeString(); return e.time_text || ''; }

// Standard styled log: character colours, scene divisions, dice, timestamps, configurable options.
export default function StyledLogViewer() {
  const { snapshot, openSnapshot } = useStudio();
  const [opts, setOpts] = useState({ ooc: true, time: true, dice: true, raw: false, font: 16 });
  const cache = useMemo(() => new Map<string, string>(), [snapshot?.id]);
  if (!snapshot?.events) return null;
  const events = snapshot.events.filter((e) => (opts.ooc || e.event_type !== 'ooc') && (opts.dice || e.event_type !== 'dice_roll'));
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{snapshot.project_title} — v{snapshot.version} {snapshot.title}</h3><span className="pill">{snapshot.scope}</span><span className="tiny muted">{events.length} of {snapshot.visible_event_count} events</span><span className="grow" />
        <label className="tiny"><input type="checkbox" checked={opts.ooc} onChange={(e) => setOpts({ ...opts, ooc: e.target.checked })} /> OOC</label>
        <label className="tiny"><input type="checkbox" checked={opts.time} onChange={(e) => setOpts({ ...opts, time: e.target.checked })} /> time</label>
        <label className="tiny"><input type="checkbox" checked={opts.dice} onChange={(e) => setOpts({ ...opts, dice: e.target.checked })} /> dice</label>
        <label className="tiny"><input type="checkbox" checked={opts.raw} onChange={(e) => setOpts({ ...opts, raw: e.target.checked })} /> raw</label>
        <input type="range" min={12} max={22} value={opts.font} onChange={(e) => setOpts({ ...opts, font: +e.target.value })} title="font size" />
        <button className="ghost small" onClick={() => openSnapshot('', null)}>✕</button>
      </div>
      <div style={{ fontSize: opts.font, lineHeight: 1.6, marginTop: 10, maxHeight: '70vh', overflow: 'auto' }}>
        {events.map((e) => {
          if (e.event_type === 'scene_change') return <div key={e.event_id} style={{ textAlign: 'center', color: 'var(--fg-2)', margin: '22px 0 10px', borderTop: '1px solid var(--bg-4)', paddingTop: 8, fontVariant: 'small-caps', letterSpacing: '.08em' }}>{e.content}</div>;
          const color = speakerColor(e, snapshot.character_map, cache);
          return (
            <div key={e.event_id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, marginBottom: 6, borderLeft: e.event_type === 'secret' ? '3px solid var(--danger)' : undefined, paddingLeft: e.event_type === 'secret' ? 6 : 0 }}>
              <span style={{ color, fontWeight: 600, whiteSpace: 'nowrap' }}>{e.speaker_display_name}</span>
              <span>
                <span style={{ whiteSpace: 'pre-wrap', fontStyle: e.event_type === 'narration' ? 'italic' : undefined, color: e.event_type === 'ooc' ? 'var(--fg-2)' : undefined, fontFamily: e.event_type === 'dice_roll' ? 'var(--mono)' : undefined, background: e.event_type === 'dice_roll' ? 'var(--bg-3)' : undefined, borderRadius: 6, padding: e.event_type === 'dice_roll' ? '1px 6px' : 0 }}>{opts.raw && e.raw_text ? e.raw_text : e.content}</span>
                {e.dice && e.dice.total != null && <span className="pill" style={{ marginLeft: 6 }}>{e.dice.check_name ? `${e.dice.check_name} ` : ''}{e.dice.expression} = {e.dice.total} {e.dice.outcome}</span>}
                {opts.time && <span className="tiny muted" style={{ marginLeft: 6 }}>{fmtTime(e)}</span>}
                {e.unrecognised && <span className="pill danger" style={{ marginLeft: 6 }}>unrecognised</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
