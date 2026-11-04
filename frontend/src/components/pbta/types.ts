export interface Definition {
  id: string;
  name: string;
}
export interface Band extends Definition {
  min: number | null;
  max: number | null;
}
export interface Move extends Definition {
  trigger: string;
  book: string;
  stat: string;
  outcomes: Record<string, string>;
}
export interface Pack {
  schemaVersion: 1;
  name: string;
  stats: Definition[];
  books: Definition[];
  resources: Definition[];
  conditions: Definition[];
  bands: Band[];
  moves: Move[];
  gmMoves: (Definition & { text: string })[];
}
export interface Rules {
  pack: Pack;
  revision: number;
}
export interface Sheet {
  book: string;
  stats: Record<string, number>;
  resources: Record<string, number>;
  conditions: Record<string, boolean>;
}
