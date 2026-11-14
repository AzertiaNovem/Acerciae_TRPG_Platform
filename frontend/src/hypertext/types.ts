// Interactive messages (messages.kind = 'hypertext'), card format v1: the public document a GM account posts through
// REST, as the server stores it (normalized, plus closes_at and reply stubs), and the engine's input and output. The
// same shapes are ported to Kotlin (core/Hypertext.kt) and Swift (AcerciaeCore/Hypertext.swift); the fixtures
// mobile/contracts/fixtures/hypertext*.json pin them. Docs: docs/HYPERTEXT.md.

export interface EnumValue { value: string; label: string }
export type StateDecl =
  | { type: 'bool' }
  | { type: 'int'; min: number; max: number; default?: number }
  | { type: 'enum'; values: EnumValue[]; default?: string | null }
  | { type: 'set'; values: EnumValue[]; max: number }
  | { type: 'text'; max: number };
export type StateValue = boolean | number | string | null | string[];
/** One viewer's state: every declared key, nothing else. */
export type State = Record<string, StateValue>;

/** Conditions (`show_if`, `enable_if`): typed at post time, depth ≤3, ≤8 leaves. */
export type Cond =
  | { key: string; eq: boolean | number | string | null }
  | { key: string; in: (number | string)[] }
  | { key: string; has: string }
  | { key: string; gte: number }
  | { key: string; lte: number }
  | { key: string; empty: boolean }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

/** A button's declarative action, run natively without the engine: set first, then say (from the new state), then reply. */
export interface Act { set?: Record<string, StateValue>; say?: string; say_kind?: SayKind; reply?: string }

interface Base { id?: string; show_if?: Cond }
interface Control extends Base { id: string; enable_if?: Cond; on?: string }
export interface TextNode extends Base { type: 'text'; text: string; style: 'body' | 'muted' | 'heading' | 'strong'; tone: 'neutral' | 'good' | 'bad' | 'warn' }
export interface CheckboxNode extends Control { type: 'checkbox'; label: string; bind: string }
export interface ChoiceNode extends Control { type: 'choice'; label?: string; bind: string; display: 'list' | 'buttons' | 'menu'; options?: string[] }
export interface InputNode extends Control { type: 'input'; label?: string; placeholder?: string; bind: string; submit_label?: string }
export interface ButtonNode extends Control { type: 'button'; label: string; style: 'primary' | 'secondary' | 'danger'; act?: Act }
export interface DividerNode extends Base { type: 'divider' }
export type Leaf = TextNode | CheckboxNode | ChoiceNode | InputNode | ButtonNode | DividerNode;
export interface RowNode extends Base { type: 'row'; children: Leaf[] }
export interface GroupNode extends Base { type: 'group'; title?: string; children: (RowNode | Leaf)[] }
export type Node = Leaf | RowNode | GroupNode;
export type ControlNode = CheckboxNode | ChoiceNode | InputNode | ButtonNode;

/** Public stub of a private reply template: the text, kind, character and limits never leave the server. */
export type SlotDecl = { type: 'int'; min: number; max: number } | { type: 'enum'; values: string[] };
export interface ReplyStub { id: string; slots: Record<string, SlotDecl>; audience: 'card' | 'viewer' | 'gm'; group: string | null }

export interface Doc {
  v: 1;
  title: string;
  state: Record<string, StateDecl>;
  body: Node[];
  script: string | null;
  actors: string[] | null;
  runs_per_viewer: number;
  closes_at: string | null;
  replies: ReplyStub[];
}

/** Why every control is disabled; null when the viewer may act. */
export type LockReason = null | 'closed' | 'recalled' | 'not_actor' | 'spectator' | 'history' | 'archived' | 'paused' | 'loading';
export interface Lock { reason: LockReason }
export interface ResolvedOption { value: string; label: string; selected: boolean; disabled: boolean }
/** One node as drawn, in document order (containers before their children). */
export interface Resolved {
  node: Node;
  text?: string;                  // a text node, interpolated
  label?: string;                 // a control's label or a group's title, interpolated
  caption?: string;               // a button's declarative say, as it would be posted
  value?: StateValue;             // the bound state value
  options?: ResolvedOption[];     // a choice's options, in display order
  visible: boolean;
  disabled: boolean;
}

/** UI actions on a control. Toggle: checkbox. Select: a choice option (an enum selects, a set toggles). Submit: an input
 *  (fires its handler). Commit: an input's draft written on blur, which fires no handler. Click: a button. */
export type Action = { type: 'toggle' } | { type: 'select'; value: string } | { type: 'submit'; value: string } | { type: 'commit'; value: string } | { type: 'click' };
export type EventType = 'change' | 'submit' | 'click';
export interface HxEvent { type: EventType; node: string; value: StateValue }

export type SayKind = 'ic' | 'ooc';
export type Effect = { type: 'say'; text: string; kind: SayKind } | { type: 'reply'; id: string; slots: Record<string, string | number> };

export interface Viewer { gm: boolean; actor: boolean; character: string | null }
/** One run of a card's script: the handler named by the control's `on`, the state after the binding change. */
export interface EngineInput { doc: Doc; state: State; handler: string; event: HxEvent; viewer: Viewer }

export type ErrorCode = 'script_error' | 'no_handler' | 'budget' | 'memory' | 'stack' | 'timeout' | 'invalid_state' | 'invalid_effect' | 'engine_unavailable' | 'engine';
export interface EngineError { code: ErrorCode; message: string; line?: number }
/** What a free-text say needs before it is sent: the viewer's confirmation (sheet: the command changes their sheet). */
export interface Confirm { text: string; kind: SayKind; sheet?: true }
export type RunResult =
  | { ok: true; state: State; effects: Effect[]; notices: string[]; logs: string[]; confirm: Confirm | null; changed: boolean }
  | { ok: false; error: EngineError; logs?: string[] };
