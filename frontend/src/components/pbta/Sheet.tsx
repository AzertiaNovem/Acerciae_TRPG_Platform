import { t as tr } from '../../i18n';
import { useState } from 'react';
import { api } from '../../api/client';
import { useUi } from '../../store/ui';
import { useNav } from '../../store/nav';
import { useAuth } from '../../store/auth';
import type { Pack, Sheet } from './types';

export default function PbtaSheet({
  pack,
  sheet,
  editable,
  dirty,
  characterId,
  change,
}: {
  pack: Pack;
  sheet?: Sheet;
  editable: boolean;
  dirty: boolean;
  characterId: string;
  change: (card: Sheet) => void;
}) {
  const card = sheet ?? { book: '', stats: {}, resources: {}, conditions: {} };
  const { channelId, windowId, windows, channel, serverSettings } = useNav();
  const user = useAuth((s) => s.user);
  const win = windows.find((w) => w.id === windowId);
  const canSpeak = channel?.my_role === 'gm' || win?.members?.some((m) => m.user_id === user?.id);
  const [bonus, setBonus] = useState(0);
  const [busy, setBusy] = useState(false);
  const toast = useUi((s) => s.toast);
  async function perform(id: string, rolled: boolean) {
    if (!channelId || !windowId || busy || dirty || !canSpeak) return;
    setBusy(true);
    try {
      await api.postMessage(channelId, windowId, {
        character_id: characterId,
        content: '.move ' + id + (rolled && bonus ? ' ' + bonus : ''),
        kind: 'ic',
        visibility: 'window',
      });
      toast(tr('Sent to {window}', { window: win?.name ?? '' }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="col">
      <h3>{pack.name} · PbtA</h3>
      <label className="field">
        {tr('Playbook')}
        <select
          disabled={!editable}
          value={card.book}
          onChange={(e) => change({ ...card, book: e.target.value })}
        >
          <option value="" disabled>
            {tr('Choose a playbook')}
          </option>
          {pack.books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      {(['stats', 'resources', 'conditions'] as const).map((k, i) => (
        <fieldset key={k}>
          <legend>{[tr('Stats'), tr('Resources and experience'), tr('Conditions')][i]}</legend>
          <div className="char-grid">
            {pack[k].map((d) => (
              <label className="cell" key={d.id}>
                {d.name}
                {k === 'conditions' ? (
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={!!card.conditions[d.id]}
                    onChange={(e) => {
                      const conditions = { ...card.conditions };
                      if (e.target.checked) conditions[d.id] = true;
                      else delete conditions[d.id];
                      change({ ...card, conditions });
                    }}
                  />
                ) : (
                  <input
                    type="number"
                    step={1}
                    min={-9999}
                    max={9999}
                    disabled={!editable}
                    placeholder="0"
                    value={card[k][d.id] ?? ''}
                    onChange={(e) => {
                      const values = { ...card[k] };
                      if (e.target.value === '') delete values[d.id];
                      else values[d.id] = Number(e.target.value);
                      change({ ...card, [k]: values });
                    }}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <h4>{tr('Moves')}</h4>
      {editable && (
        <label className="field">
          {tr('Move modifier')}
          <input
            type="number"
            min={-99}
            max={99}
            step={1}
            value={bonus}
            onChange={(e) => setBonus(Number(e.target.value))}
          />
        </label>
      )}
      {dirty && <small>{tr('Save the sheet to use a move.')}</small>}
      {pack.moves
        .filter((m) => !m.book || m.book === card.book)
        .map((m) => (
          <details key={m.id} className="card">
            <summary>{m.name}</summary>
            <p>{m.trigger}</p>
            {m.stat && (
              <>
                <small>2d6 + {pack.stats.find((s) => s.id === m.stat)?.name}</small>
                {pack.bands.map((b) => (
                  <p key={b.id}>
                    {b.name}（{b.min ?? '−∞'} … {b.max ?? '∞'}） · {m.outcomes[b.id]}
                  </p>
                ))}
              </>
            )}
            {editable && (
              <button
                disabled={
                  busy || dirty || !card.book || !win || !canSpeak || serverSettings?.features?.dice === false
                }
                onClick={() => perform(m.id, !!m.stat)}
              >
                {m.stat ? tr('Roll dice') : tr('Use move')} · {win?.name ?? tr('Choose a chat window')}
              </button>
            )}
            <small> .move {m.id}</small>
          </details>
        ))}
      {pack.gmMoves?.length > 0 && (
        <details>
          <summary>{tr('GM reference moves')}</summary>
          {pack.gmMoves.map((m) => (
            <p key={m.id}>
              {m.name} · {m.text}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
