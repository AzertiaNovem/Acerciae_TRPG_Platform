// Visual-novel look templates. A presentation stores `settings.template` = { base, ...overrides }.
// The backend validates every value (PresentationService::validateVnTemplate); this module re-checks
// defensively because published presentations may predate a rule, then fills gaps from the preset.
// Nothing here reaches CSS except enumerated class names, clamped numbers and #RRGGBB colours.

export type VnBase = 'adv' | 'nvl' | 'dossier' | 'cinematic';
export type VnFont = 'sans' | 'serif' | 'mono';
export type VnNameStyle = 'tag' | 'inline' | 'hidden';
export type VnColorGrade = 'none' | 'sepia' | 'mono' | 'cold' | 'warm';
export type VnDiceStyle = 'burst' | 'stamp' | 'inline' | 'hide';
export type VnSceneCard = 'fade' | 'caption' | 'none';
export type VnPortraitFraming = 'upper' | 'full';

export interface VnTemplate {
  base: VnBase;
  font: VnFont;
  text_scale: number;      // 0.8–1.5
  box_opacity: number;     // 0–1, the text box background
  accent_color: string;    // #RRGGBB, default name tag / highlight colour
  name_style: VnNameStyle;
  color_grade: VnColorGrade;
  letterbox: boolean;
  dim_inactive: boolean;   // darken standees that are not speaking
  portrait_framing: VnPortraitFraming;   // upper: standees sit low, only their upper half shows; full: the whole figure
  dice_style: VnDiceStyle;
  scene_card: VnSceneCard;
  character_colors: Record<string, string>;  // character id → #RRGGBB name colour
}

export type VnTemplateInput = Partial<VnTemplate> & { base?: string };

export const VN_BASES: VnBase[] = ['adv', 'nvl', 'dossier', 'cinematic'];

// Labels and blurbs are English source strings; the UI passes them through tr().
export const VN_BASE_INFO: Record<VnBase, { label: string; blurb: string }> = {
  adv: { label: 'Classic ADV', blurb: 'Text box at the bottom with a name tag; standees in front.' },
  nvl: { label: 'Novel page', blurb: 'The scene builds up as a full-screen page of prose.' },
  dossier: { label: 'Case file', blurb: 'Typewritten paper slip over a sepia scene, rolls stamped in red.' },
  cinematic: { label: 'Cinematic', blurb: 'Letterboxed, subtitles without a box.' },
};

export const VN_PRESETS: Record<VnBase, Omit<VnTemplate, 'base' | 'character_colors'>> = {
  adv: { font: 'sans', text_scale: 1, box_opacity: 0.82, accent_color: '#7c9cff', name_style: 'tag', color_grade: 'none', letterbox: false, dim_inactive: true, portrait_framing: 'upper', dice_style: 'burst', scene_card: 'fade' },
  nvl: { font: 'serif', text_scale: 1, box_opacity: 0.72, accent_color: '#e8c987', name_style: 'inline', color_grade: 'none', letterbox: false, dim_inactive: true, portrait_framing: 'upper', dice_style: 'inline', scene_card: 'caption' },
  dossier: { font: 'mono', text_scale: 0.95, box_opacity: 0.96, accent_color: '#9b2226', name_style: 'tag', color_grade: 'sepia', letterbox: false, dim_inactive: true, portrait_framing: 'upper', dice_style: 'stamp', scene_card: 'caption' },
  cinematic: { font: 'serif', text_scale: 1.1, box_opacity: 0, accent_color: '#f2e6c9', name_style: 'inline', color_grade: 'cold', letterbox: true, dim_inactive: true, portrait_framing: 'upper', dice_style: 'inline', scene_card: 'fade' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** Merge a stored template over its preset. Invalid values fall back to the preset instead of failing playback. */
export function resolveVnTemplate(input: unknown): VnTemplate {
  const t = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const base = pick(t.base, VN_BASES, 'adv');
  const p = VN_PRESETS[base];
  const colors: Record<string, string> = {};
  if (t.character_colors && typeof t.character_colors === 'object') {
    for (const [k, v] of Object.entries(t.character_colors as Record<string, unknown>)) if (isHexColor(v)) colors[k] = v;
  }
  return {
    base,
    font: pick(t.font, ['sans', 'serif', 'mono'] as const, p.font),
    text_scale: clamp(t.text_scale, 0.8, 1.5, p.text_scale),
    box_opacity: clamp(t.box_opacity, 0, 1, p.box_opacity),
    accent_color: isHexColor(t.accent_color) ? t.accent_color : p.accent_color,
    name_style: pick(t.name_style, ['tag', 'inline', 'hidden'] as const, p.name_style),
    color_grade: pick(t.color_grade, ['none', 'sepia', 'mono', 'cold', 'warm'] as const, p.color_grade),
    letterbox: bool(t.letterbox, p.letterbox),
    dim_inactive: bool(t.dim_inactive, p.dim_inactive),
    portrait_framing: pick(t.portrait_framing, ['upper', 'full'] as const, p.portrait_framing),
    dice_style: pick(t.dice_style, ['burst', 'stamp', 'inline', 'hide'] as const, p.dice_style),
    scene_card: pick(t.scene_card, ['fade', 'caption', 'none'] as const, p.scene_card),
    character_colors: colors,
  };
}

/** Only the keys that differ from the preset are stored, so a later preset refresh still reaches old presentations. */
export function templateOverrides(t: VnTemplate): VnTemplateInput {
  const p = VN_PRESETS[t.base];
  const out: VnTemplateInput = { base: t.base };
  for (const k of Object.keys(p) as (keyof typeof p)[]) if (t[k] !== p[k]) (out as any)[k] = t[k];
  if (Object.keys(t.character_colors).length) out.character_colors = t.character_colors;
  return out;
}

export const FONT_STACK: Record<VnFont, string> = {
  sans: "var(--font)",
  serif: "'Noto Serif SC', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif",
  mono: "'Courier Prime', 'Noto Sans Mono CJK SC', 'Courier New', ui-monospace, monospace",
};

/** Readable ink for a name tag on top of the given background colour. */
export function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#14110d' : '#fbf7ef';
}

/** CSS custom properties the stage reads. Values are already validated. */
export function templateStyle(t: VnTemplate): Record<string, string> {
  return {
    '--vn-font': FONT_STACK[t.font],
    '--vn-text-scale': String(t.text_scale),
    '--vn-box-alpha': String(t.box_opacity),
    '--vn-accent': t.accent_color,
    '--vn-accent-ink': inkFor(t.accent_color),
  };
}

/** Name colour for a speaker: the line's own override, then the template's colour for that character,
 *  then the character's visual profile colour, then the accent. */
export function speakerColor(t: VnTemplate, characterId: string | null | undefined, profileColor?: string | null, lineColor?: string | null): string {
  if (isHexColor(lineColor)) return lineColor;
  if (characterId && t.character_colors[characterId]) return t.character_colors[characterId];
  if (isHexColor(profileColor)) return profileColor;
  return t.accent_color;
}
