import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { t, currentLocale } from '../i18n';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { sessionEpoch, isStale } from '../store/session';
import type { Message } from '../types';

export default function ChatReference({channelId,messageId}:{channelId:string;messageId:string}) {
  const epoch = sessionEpoch();
  const key = `${epoch}:${channelId}:${messageId}`;
  const cached = useChat(s => Object.values(s.byWindow).flat().find(m => m.id === messageId && m.channel_id === channelId));
  const [resolved,setResolved]=useState<{key:string;message:Message|null}|null>(null);
  const unavailable = resolved?.key === key && resolved.message === null;
  const message = unavailable ? null : (resolved?.key === key ? resolved.message : cached);
  const [busy,setBusy]=useState(false);
  useEffect(() => {
    let active = true;
    // Render an already-loaded original immediately, then check the current view's access.
    api.message(channelId,messageId).then(
      message => { if (active && !isStale(epoch)) setResolved({key,message}); },
      error => {
        if (!active || isStale(epoch)) return;
        const denied = error instanceof ApiError && [401,403,404].includes(error.status);
        const previous = Object.values(useChat.getState().byWindow).flat().find(m => m.id === messageId && m.channel_id === channelId);
        setResolved({key,message:denied ? null : previous ?? null});
      },
    );
    return () => { active = false; };
  },[channelId,messageId,epoch,key]);
  const jump=async()=>{
    // Recheck permission at navigation time; a cached excerpt cannot authorize access.
    const epoch=sessionEpoch(); setBusy(true);
    try {
      const original=await api.message(channelId,messageId);
      if(isStale(epoch))return;
      useChat.getState().push(original);
      useNav.getState().selectWindow(original.chat_window_id);
      useChat.getState().requestJump(original.id);
    } catch {if(!isStale(epoch))setResolved({key,message:null});} finally {if(!isStale(epoch))setBusy(false);}
  };
  return <div className="chat-reference">
    {!message && !unavailable && <span className="tiny muted" role="status">{t('Loading…')}</span>}
    {unavailable && <span className="tiny muted">{t('Reference unavailable for your current view.')}</span>}
    {message && <><div className="row small"><span className="grow">{message.character_name??message.author_name} · {new Date(message.created_at).toLocaleString(currentLocale())}</span><button className="ghost small" onClick={jump} disabled={busy}>{t('Go to original message')}</button></div><blockquote>{message.content}</blockquote>{message.dice?.text && <p className="small">{message.dice.text}</p>}</>}
  </div>;
}
