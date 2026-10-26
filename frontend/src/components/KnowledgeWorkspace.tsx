import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { t } from '../i18n';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { EntryCard } from './ContextDocumentViewer';
import DocumentRevisionViewer from './DocumentRevisionViewer';
import type { DocumentSummary, DocumentFull, PlayerGroup, ChannelMember } from '../types';

export function PlayerGroups() {
  const { channelId, refreshWindows } = useNav();
  const toast = useUi(s => s.toast);
  const [groups, setGroups] = useState<PlayerGroup[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setGroups([]); setMembers([]);
    if (channelId) Promise.all([api.playerGroups(channelId), api.channelMembers(channelId)]).then(([g,m]) => { if(live) { setGroups(g); setMembers(m); } }).catch(e => toast(e.message,'error'));
    return () => { live=false; };
  }, [channelId, toast]);
  const create = async () => {
    if(!channelId || !name.trim()) return;
    setBusy(true);
    try { await api.createPlayerGroup(channelId,name.trim()); setGroups(await api.playerGroups(channelId)); setName(''); }
    catch(e: any) { toast(e.message,'error'); } finally { setBusy(false); }
  };
  const move = async (user: string, target: string) => {
    if(!channelId) return;
    setBusy(true);
    try { setGroups(await api.movePlayer(channelId,target,user)); await refreshWindows(); toast(t('Player memory is rebuilding from chat.')); }
    catch(e: any) { toast(e.message,'error'); } finally { setBusy(false); }
  };
  return <section className="card">
    <h3>{t('Player groups')}</h3>
    <p className="small muted">{t('Group members share their readable chat and an independent AI journal. Moving a player rebuilds both groups from chat.')}</p>
    <div className="row"><input aria-label={t('Group name')} placeholder={t('Group name')} value={name} maxLength={100} onChange={e=>setName(e.target.value)} /><button onClick={create} disabled={busy || !name.trim()}>{t('Create group')}</button></div>
    {members.filter(m=>m.role==='player').map(m=><label className="pick-row" key={m.id}><span className="grow">{m.display_name}</span><select aria-label={`${t('Player group')}: ${m.display_name}`} disabled={busy} value={groups.find(g=>g.members.some(p=>p.user_id===m.id))?.id ?? ''} onChange={e=>move(m.id,e.target.value)}><option value="" disabled>{t('Loading…')}</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>)}
    <p className="tiny muted">{t('KP memory is never copied into a player group. Reveal information through chat.')}</p>
  </section>;
}

export default function KnowledgeWorkspace() {
  const { channelId } = useNav();
  const toast = useUi(s=>s.toast);
  const [docs,setDocs] = useState<DocumentSummary[]>([]);
  const [selected,setSelected] = useState('');
  const [doc,setDoc] = useState<DocumentFull | null>(null);
  const [query,setQuery] = useState('');
  const [status,setStatus] = useState('');
  const [history,setHistory] = useState(false);
  useEffect(()=>{
    let live=true;
    setDocs([]); setSelected(''); setDoc(null);
    const load=()=>channelId && api.documents(channelId).then(d=>{ if(live) {setDocs(d);setSelected(old=>d.some(x=>x.id===old)?old:d[0]?.id ?? '');} }).catch(e=>toast(e.message,'error'));
    load(); const timer=setInterval(load,10000);
    return ()=>{live=false;clearInterval(timer);};
  },[channelId,toast]);
  useEffect(()=>{
    let live=true; setDoc(null);
    if(channelId && selected) api.document(channelId,selected,'all').then(d=>{if(live)setDoc(d);}).catch(e=>toast(e.message,'error'));
    return ()=>{live=false;};
  },[channelId,selected,docs,toast]);
  const reload=()=>{if(channelId && selected)api.document(channelId,selected,'all').then(setDoc).catch(e=>toast(e.message,'error'));};
  const entries=(doc?.entries??[]).filter(e=>(!status || e.status===status) && (!query || `${e.summary} ${e.content_md} ${e.scene_title??''} ${e.section}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const sections=[...new Set(entries.map(e=>e.section||e.status))];
  return <div className="knowledge-workspace">
    <p className="muted small">{t('KP memory is private. Each player group has a separate journal based only on chat.')}</p>
    <div className="knowledge-categories" role="tablist" aria-label={t('Knowledge')}>
      {docs.map(d=><button role="tab" aria-selected={selected===d.id} key={d.id} className={`card ${selected===d.id?'selected':''}`} onClick={()=>{setSelected(d.id);setHistory(false);}}><strong>{t(d.title)}</strong><span className="pill gm">{d.entry_count}</span><span className="tiny muted">{d.preview||t('Nothing recorded yet')}</span></button>)}
    </div>
    <section className="card">
      <div className="row"><h3 className="grow">{doc ? t(doc.title):t('Loading…')}</h3><button onClick={()=>setHistory(!history)}>{history?t('entries'):t('Revision history')}</button></div>
      {doc && history ? <DocumentRevisionViewer documentId={doc.id} isGm onRolledBack={reload}/> : <>
        <div className="row"><input aria-label={t('Search')} placeholder={t('search facts')} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={t('status')} value={status} onChange={e=>setStatus(e.target.value)}><option value="">{t('All statuses')}</option>{['confirmed','attempted','npc_claim','hypothesis','ai_inferred','gm_secret','pending_review','resolved'].map(s=><option key={s} value={s}>{t(s)}</option>)}</select></div>
        {sections.map(section=><section key={section}><h4>{t(section)}</h4>{entries.filter(e=>(e.section||e.status)===section).map(e=><EntryCard key={e.id} e={e} focused={false} isGm onChanged={reload}/>)}</section>)}
        {doc && !entries.length && <p className="muted small">{t('Nothing recorded yet')}</p>}
      </>}
    </section>
    <PlayerGroups/>
  </div>;
}
