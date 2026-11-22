import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { activate } from '../lib/a11y';
import { useNav } from '../store/nav';
import { useBotChats } from '../store/botChats';
import { useUi } from '../store/ui';
import { BotTag } from './BotTag';
import type { Bot } from '../types';

// The channel sidebar's private chats with the server's bots (docs/BOTS.md): one per bot, just the person and the bot.
// "+" lists the server's bots to start (or reopen) a chat with.
export default function BotChats({ onPick }: { onPick: () => void }) {
  const nav = useNav();
  const toast = useUi((s) => s.toast);
  const { chats, load, open } = useBotChats();
  const [picking, setPicking] = useState<Bot[] | null>(null);
  const serverId = nav.serverId;
  const feature = nav.serverSettings?.features?.bots === true;
  useEffect(() => { if (serverId) void load(serverId); }, [serverId, load]);
  if (!serverId || (!feature && chats.length === 0)) return null;
  const pick = async () => {
    try { setPicking((await api.bots(serverId)).filter((b) => b.enabled)); } catch (e: any) { toast(e.message, 'error'); }
  };
  const start = async (bot: Bot) => {
    try {
      const chat = await open(serverId, bot.id);
      setPicking(null);
      await nav.selectChannel(chat.channel_id, chat.window_id);
      onPick();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <>
      <div className="section"><span>{tr('Private chats')}</span>
        {feature && <button className="ghost small" title={tr('Chat with a bot')} aria-label={tr('Chat with a bot')} onClick={pick}>+</button>}</div>
      {chats.map((c) => (
        <div key={c.channel_id} className={`item ${c.channel_id === nav.channelId && !nav.spectateChannelId ? 'active' : ''}`}
          {...activate(() => { void nav.selectChannel(c.channel_id, c.window_id); onPick(); })}>
          <span className="muted">✉</span><span className="name">{c.bot_name}</span><BotTag />
        </div>
      ))}
      {picking && (
        <div className="modal-backdrop" onClick={() => setPicking(null)}>
          <div className="modal col" role="dialog" aria-modal="true" aria-label={tr('Chat with a bot')} onClick={(e) => e.stopPropagation()}>
            <h3>{tr('Chat with a bot')}</h3>
            {picking.length === 0 && <p className="muted small">{tr('This server has no bot to chat with yet.')}</p>}
            {picking.map((b) => (
              <div key={b.id} className="pick-row"><span className="grow">{b.name} <BotTag /></span>
                <button className="small primary" onClick={() => start(b)}>{chats.some((c) => c.bot_id === b.id) ? tr('Open') : tr('Chat')}</button></div>
            ))}
            <p className="tiny muted">{tr('Just the two of you: nobody else sees a private chat. The bot remembers it, but never brings it up anywhere else.')}</p>
            <div className="row"><span className="grow" /><button onClick={() => setPicking(null)}>{tr('Close')}</button></div>
          </div>
        </div>
      )}
    </>
  );
}
