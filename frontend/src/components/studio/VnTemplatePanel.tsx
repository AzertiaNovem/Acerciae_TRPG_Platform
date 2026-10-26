import { t as tr } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { Presentation } from '../../types';
import { isHexColor, resolveVnTemplate, templateOverrides, VN_BASE_INFO, VN_BASES, VN_PRESETS, type VnBase, type VnTemplate } from './vn/templates';

// Look template for one presentation. Choosing a preset resets the overrides; per-character name colours stay.
// Edits apply to the live preview at once and are saved shortly after the last change.
export default function VnTemplatePanel({ presentation, characters, canEdit, onPreview, onSave }: {
  presentation: Presentation;
  characters: { id: string; name: string }[];
  canEdit: boolean;
  onPreview: (template: Record<string, unknown>) => void;
  onSave: (template: Record<string, unknown>, presentationId: string) => Promise<void>;
}) {
  const [tpl, setTpl] = useState<VnTemplate>(() => resolveVnTemplate(presentation.settings?.template));
  const timer = useRef<number | null>(null);
  const pending = useRef<{ id: string; template: Record<string, unknown> } | null>(null);
  const save = useRef(onSave); save.current = onSave;
  const flush = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; const p = pending.current; pending.current = null; if (p) save.current(p.template, p.id).catch(() => undefined); };
  useEffect(() => { setTpl(resolveVnTemplate(presentation.settings?.template)); }, [presentation.id]);
  useEffect(() => flush, [presentation.id]);   // leaving the editor or switching presentations saves the last change

  const apply = (next: VnTemplate) => {
    setTpl(next);
    const stored = templateOverrides(next) as Record<string, unknown>;
    onPreview(stored);
    pending.current = { id: presentation.id, template: stored };
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  };
  const set = <K extends keyof VnTemplate>(k: K, v: VnTemplate[K]) => apply({ ...tpl, [k]: v });
  const choose = (base: VnBase) => apply({ ...resolveVnTemplate({ base }), character_colors: tpl.character_colors });
  const setColor = (id: string, v: string | null) => { const cc = { ...tpl.character_colors }; if (v && isHexColor(v)) cc[id] = v; else delete cc[id]; apply({ ...tpl, character_colors: cc }); };
  const customised = Object.keys(templateOverrides(tpl)).some((k) => k !== 'base' && k !== 'character_colors');

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row"><h3 style={{ margin: 0 }}>{tr("Look template")}</h3><span className="grow" />{customised && canEdit && <button className="ghost small" onClick={() => choose(tpl.base)}>{tr("Reset to preset")}</button>}</div>
      <div className="vn-tpl-gallery" style={{ marginTop: 8 }}>
        {VN_BASES.map((b) => (
          <button key={b} className={`vn-tpl-card t-${b} ${tpl.base === b ? 'active' : ''}`} onClick={() => canEdit && choose(b)} disabled={!canEdit} aria-pressed={tpl.base === b}>
            <div className="thumb" aria-hidden>
              <div className="fig" />
              <div className="box" />
              {b !== 'nvl' && b !== 'cinematic' && <div className="tag" style={{ background: VN_PRESETS[b].accent_color }} />}
              {b === 'nvl'
                ? <><div className="ln" style={{ top: '18%', width: '62%', left: '19%' }} /><div className="ln" style={{ top: '30%', width: '55%', left: '19%' }} /><div className="ln" style={{ top: '42%', width: '60%', left: '19%' }} /></>
                : <><div className="ln" style={{ bottom: '17%', width: b === 'cinematic' ? '50%' : '70%', left: b === 'cinematic' ? '25%' : '10%', zIndex: 2 }} /><div className="ln" style={{ bottom: '10%', width: b === 'cinematic' ? '36%' : '55%', left: b === 'cinematic' ? '32%' : '10%', zIndex: 2, opacity: b === 'cinematic' ? 0 : 1 }} /></>}
            </div>
            <span className="name">{tr(VN_BASE_INFO[b].label)}</span>
            <span className="blurb">{tr(VN_BASE_INFO[b].blurb)}</span>
          </button>
        ))}
      </div>
      <div className="vn-tpl-fields tiny">
        <label>{tr("Typeface")}<select value={tpl.font} onChange={(e) => set('font', e.target.value as VnTemplate['font'])} disabled={!canEdit}><option value="sans">{tr("Sans")}</option><option value="serif">{tr("Serif")}</option><option value="mono">{tr("Typewriter")}</option></select></label>
        <label>{tr("Text size")} {Math.round(tpl.text_scale * 100)}%<input type="range" min={0.8} max={1.5} step={0.05} value={tpl.text_scale} onChange={(e) => set('text_scale', +e.target.value)} disabled={!canEdit} /></label>
        <label>{tr("Text box opacity")} {Math.round(tpl.box_opacity * 100)}%<input type="range" min={0} max={1} step={0.05} value={tpl.box_opacity} onChange={(e) => set('box_opacity', +e.target.value)} disabled={!canEdit} /></label>
        <label>{tr("Accent colour")}<input type="color" value={tpl.accent_color} onChange={(e) => set('accent_color', e.target.value)} disabled={!canEdit} /></label>
        <label>{tr("Speaker names")}<select value={tpl.name_style} onChange={(e) => set('name_style', e.target.value as VnTemplate['name_style'])} disabled={!canEdit}><option value="tag">{tr("Name tag")}</option><option value="inline">{tr("Above the line")}</option><option value="hidden">{tr("Hidden")}</option></select></label>
        <label>{tr("Colour grade")}<select value={tpl.color_grade} onChange={(e) => set('color_grade', e.target.value as VnTemplate['color_grade'])} disabled={!canEdit}><option value="none">{tr("None")}</option><option value="sepia">{tr("Sepia")}</option><option value="mono">{tr("Black and white")}</option><option value="cold">{tr("Cold")}</option><option value="warm">{tr("Warm")}</option></select></label>
        <label>{tr("Dice rolls")}<select value={tpl.dice_style} onChange={(e) => set('dice_style', e.target.value as VnTemplate['dice_style'])} disabled={!canEdit}><option value="burst">{tr("Burst")}</option><option value="stamp">{tr("Stamp")}</option><option value="inline">{tr("In the text box")}</option><option value="hide">{tr("Hidden")}</option></select></label>
        <label>{tr("Scene titles")}<select value={tpl.scene_card} onChange={(e) => set('scene_card', e.target.value as VnTemplate['scene_card'])} disabled={!canEdit}><option value="fade">{tr("Title card")}</option><option value="caption">{tr("Corner caption")}</option><option value="none">{tr("None")}</option></select></label>
        <label className="row" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={tpl.letterbox} onChange={(e) => set('letterbox', e.target.checked)} disabled={!canEdit} />{tr("Letterbox bars")}</label>
        <label className="row" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={tpl.dim_inactive} onChange={(e) => set('dim_inactive', e.target.checked)} disabled={!canEdit} />{tr("Dim characters who are not speaking")}</label>
      </div>
      {characters.length > 0 && (
        <>
          <div className="tiny" style={{ marginTop: 10 }}><b>{tr("Name colours")}</b> <span className="muted">{tr("Unset names use the character's profile colour, then the accent.")}</span></div>
          <div className="vn-tpl-fields tiny">
            {characters.map((c) => (
              <label key={c.id} className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="color" value={tpl.character_colors[c.id] ?? tpl.accent_color} onChange={(e) => setColor(c.id, e.target.value)} disabled={!canEdit} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                {tpl.character_colors[c.id] && canEdit && <button className="ghost small" onClick={() => setColor(c.id, null)} title={tr("clear")}>✕</button>}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
