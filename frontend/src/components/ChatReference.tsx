import { useState } from 'react';
import { api } from '../api/client';
import { t, currentLocale } from '../i18n';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { sessionEpoch, isStale } from '../store/session';
import type { Message } from '../types';

export default function ChatReference({channelId,messageId}:{channelId:string;messageId:string}) {
  const [message,setMessage]=useState<Message|null>(null);
  const [unavailable,setUnavailable]=useState(false);
  const [busy,setBusy]=useState(false);
  const open=async()=>{
    const epoch=sessionEpoch(); setBusy(true);
    try {const m=await api.message(channelId,messageId);if(isStale(epoch))return;setMessage(m);setUnavailable(false);}
    catch {setMessage(null);setUnavailable(true);} finally {setBusy(false);}
  };
  const jump=async()=>{
    // Recheck permission at navigation time; a cached excerpt cannot authorize access.
    const epoch=sessionEpoch(); setBusy(true);
    try {
      const original=await api.message(channelId,messageId);
      if(isStale(epoch))return;
      useChat.getState().push(original);
      useNav.getState().selectWindow(original.chat_window_id);
      useChat.getState().requestJump(original.id);
    } catch {setMessage(null);setUnavailable(true);} finally {setBusy(false);}
  };
  return <div className="chat-reference">
    {!message && <button className="ghost small" onClick={open} disabled={busy}>{t('View chat reference')}</button>}
    {unavailable && <span className="tiny muted">{t('Reference unavailable for your current view.')}</span>}
    {message && <><div className="row small"><span className="grow">{message.character_name??message.author_name} · {new Date(message.created_at).toLocaleString(currentLocale())}</span><button className="ghost small" onClick={jump} disabled={busy}>{t('Go to original message')}</button></div><blockquote>{message.content}</blockquote>{message.dice?.text && <p className="small">{message.dice.text}</p>}</>}
  </div>;
}
