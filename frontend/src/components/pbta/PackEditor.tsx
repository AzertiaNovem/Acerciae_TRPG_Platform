import { t as tr } from '../../i18n';
import { useEffect, useState } from 'react';
import { isDesktop } from '../../lib/platform';
import { api } from '../../api/client';
import type { Pack, Definition, Rules } from './types';

type Group = 'stats' | 'books' | 'resources' | 'conditions' | 'bands' | 'moves' | 'gmMoves';
const groups = (): [Group, string][] => [
  ['stats', tr('Stats')],
  ['books', tr('Playbook')],
  ['resources', tr('Resources and experience')],
  ['conditions', tr('Conditions')],
  ['bands', tr('Outcome bands')],
  ['moves', tr('Player moves')],
  ['gmMoves', tr('GM reference moves')],
];
export default function PackEditor({ channel }: { channel: string }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [message, notice] = useState('');
  useEffect(() => {
    let alive = true;
    api
      .pbtaRules(channel)
      .then((r) => {
        if (alive) setRules(r);
      })
      .catch((e) => {
        if (alive) notice(e.message);
      });
    return () => {
      alive = false;
    };
  }, [channel]);
  function change(fn: (p: Pack) => void) {
    if (!rules) return;
    const p = structuredClone(rules.pack);
    fn(p);
    setRules({ ...rules, pack: p });
    setDirty(true);
    notice('');
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    notice('');
    try {
      await fn();
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!rules) return <p>{message || tr('Loading…')}</p>;
  const { pack, revision } = rules;
  function add(k: Group) {
    change((p) => {
      const id = k + '_' + crypto.randomUUID().slice(0, 8);
      const item = { id: id.toLowerCase(), name: tr('New entry') };
      if (k === 'moves') p.moves.push({ ...item, stat: '', book: '', trigger: '', outcomes: {} });
      else if (k === 'gmMoves') p.gmMoves.push({ ...item, text: '' });
      else if (k === 'bands') {
        const last = p.bands[p.bands.length - 1],
          split = (last?.min ?? 0) + 2;
        if (last) last.max = split - 1;
        p.bands.push({ ...item, min: last ? split : null, max: null });
      } else p[k].push(item);
    });
  }
  async function exportPack() {
    if (isDesktop) {
      const { saveTextFile } = await import('../../openstudio/storage');
      await saveTextFile(pack.name + '.json', JSON.stringify(pack, null, 2), {
        name: 'PbtA JSON',
        extensions: ['json'],
      });
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = pack.name + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <details className="card">
      <summary>
        {tr('Rule pack')} · {pack.name} · v{revision}
      </summary>
      <fieldset className="col" disabled={busy}>
        <label className="field">
          {tr('Rule pack')}
          <input
            value={pack.name}
            onChange={(e) =>
              change((p) => {
                p.name = e.target.value;
              })
            }
          />
        </label>
        {groups().map(([k, title]) => (
          <details key={k}>
            <summary>
              {title}（{pack[k].length}）
            </summary>
            {pack[k].map((row: Definition, i) => (
              <div key={row.id} className="card col">
                <label className="field">
                  {tr('Name')}
                  <input
                    value={row.name}
                    onChange={(e) =>
                      change((p) => {
                        p[k][i].name = e.target.value;
                      })
                    }
                  />
                </label>
                <small>{row.id}</small>
                {k === 'gmMoves' && (
                  <label>
                    {tr('Description')}
                    <textarea
                      value={pack.gmMoves[i].text}
                      onChange={(e) =>
                        change((p) => {
                          p.gmMoves[i].text = e.target.value;
                        })
                      }
                    />
                  </label>
                )}
                {k === 'bands' &&
                  (['min', 'max'] as const).map((edge) => (
                    <label key={edge}>
                      {edge === 'min'
                        ? tr('Minimum (inclusive, blank for unlimited)')
                        : tr('Maximum (inclusive, blank for unlimited)')}
                      <input
                        type="number"
                        value={pack.bands[i][edge] ?? ''}
                        onChange={(e) =>
                          change((p) => {
                            p.bands[i][edge] = e.target.value === '' ? null : Number(e.target.value);
                          })
                        }
                      />
                    </label>
                  ))}
                {k === 'moves' && (
                  <>
                    <label>
                      {tr('Trigger and instructions')}
                      <textarea
                        value={pack.moves[i].trigger}
                        onChange={(e) =>
                          change((p) => {
                            p.moves[i].trigger = e.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      {tr('Playbook')}
                      <select
                        value={pack.moves[i].book}
                        onChange={(e) =>
                          change((p) => {
                            p.moves[i].book = e.target.value;
                          })
                        }
                      >
                        <option value="">{tr('Shared move')}</option>
                        {pack.books.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {tr('Stats')}
                      <select
                        value={pack.moves[i].stat}
                        onChange={(e) =>
                          change((p) => {
                            p.moves[i].stat = e.target.value;
                            if (!e.target.value) p.moves[i].outcomes = {};
                          })
                        }
                      >
                        <option value="">{tr('No roll')}</option>
                        {pack.stats.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {pack.moves[i].stat &&
                      pack.bands.map((b) => (
                        <label key={b.id}>
                          {b.name}
                          <textarea
                            value={pack.moves[i].outcomes[b.id] ?? ''}
                            onChange={(e) =>
                              change((p) => {
                                p.moves[i].outcomes[b.id] = e.target.value;
                              })
                            }
                          />
                        </label>
                      ))}
                  </>
                )}
                <button
                  onClick={() =>
                    change((p) => {
                      p[k].splice(i, 1);
                      if (k === 'bands') for (const m of p.moves) delete m.outcomes[row.id];
                    })
                  }
                >
                  {tr('Remove')} {row.name}
                </button>
              </div>
            ))}
            <button onClick={() => add(k)}>
              {tr('Add')} {title}
            </button>
          </details>
        ))}
        <label>
          {tr('Preview JSON import')}
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(async () => {
                if (file.size > 1048576) throw Error(tr('JSON exceeds 1 MiB'));
                const candidate = await api.previewPbta(channel, JSON.parse(await file.text()));
                change((p) => Object.assign(p, candidate));
                notice(tr('Review the imported rules before saving.'));
              });
            }}
          />
        </label>
        <div className="row">
          <button disabled={dirty} onClick={() => run(exportPack)}>
            {'JSON ↓'}
          </button>
          <button
            onClick={() =>
              run(async () => {
                setRules(await api.pbtaRules(channel));
                setDirty(false);
              })
            }
          >
            {tr('Reload saved version')}
          </button>
          <button
            className="primary"
            disabled={!dirty}
            onClick={() =>
              run(async () => {
                setRules(await api.savePbta(channel, { revision, pack }));
                setDirty(false);
                notice(tr('Rule pack saved'));
              })
            }
          >
            {tr('Save rule pack')}
          </button>
        </div>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
