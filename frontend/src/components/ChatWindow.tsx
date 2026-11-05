import AtmosphereBackdrop from './AtmosphereBackdrop';
import { t as tr } from '../i18n';
import { useNav } from '../store/nav';
import MessageList from './MessageList';
import MessageComposer from './MessageComposer';
import ConsistencyResultPanel from './ConsistencyResultPanel';
import InspirationDraftPanel from './InspirationDraftPanel';
import { useUi } from '../store/ui';
import ContextBubbleDock from './ContextBubbleDock';
import ReadAloudButton from './ReadAloudButton';
import InitiativePanel from './InitiativePanel';
import WindowTools from './WindowTools';
import { useAuth } from '../store/auth';

export default function ChatWindow() {
  const { windows, windowId, channel, scenes } = useNav();
  const win = windows.find((w) => w.id === windowId);
  const userId = useAuth(s => s.user?.id);
  const paused = win?.members?.find(m => m.user_id === userId)?.visibility_paused;
  const consistency = useUi((s) => s.consistency);
  const inspiration = useUi((s) => s.inspiration);
  if (!win || !channel) return null;
  const scene = scenes.find((s) => s.id === (channel.current_scene_id ?? win.active_scene_id));
  return (
    <>
      <div className="chat-header">
        <h2>{win.name}</h2>
        <span className="pill">{tr(win.kind)}</span>
        {scene && <span className="scene-chip" title={scene.summary || scene.location}>{scene.title}{scene.location && scene.location !== scene.title ? ` · ${scene.location}` : ''}{scene.narrative_time ? ` · ${scene.narrative_time}` : ''}</span>}
        {channel.story_status === 'ended' && <span className="pill ok" title={tr("Every member can read the whole story in the Log Studio.")}>{tr("Story ended")}</span>}
        <span className="grow" />
        {channel.my_role === 'gm' && <WindowTools key={win.id} win={win} />}
        <ReadAloudButton />
        <span className="tiny muted" title={tr("Participants")}>{(win.members ?? []).filter(m => !m.visibility_paused).map((m) => m.character_name ?? m.display_name).join(' · ')}</span>
        <span className="pill" title={tr("Knowledge mode")}>{channel.my_role === 'gm' ? tr("GM only") : `${tr("Player group")}: ${channel.player_group_name ?? "…"}`}</span>
      </div>
      {channel.rule_system === 'dnd2024' && <InitiativePanel key={win.id} channelId={channel.id} windowId={win.id} isGm={channel.my_role === 'gm'} />}
      <div className="chat-body">
        <AtmosphereBackdrop />
        <MessageList />
        <ContextBubbleDock />
      </div>
      <div style={{ position: 'relative' }}>
        {consistency && <ConsistencyResultPanel />}
        {inspiration && !consistency && <InspirationDraftPanel />}
        {win.archived_at ? <div className="section small muted">{tr('Archived window. You can read its history, restore it, or fork a new scene.')}</div> : paused ? <div className="section small muted">{tr('Your participation is paused. Earlier visible history remains available.')}</div> : <MessageComposer />}
      </div>
    </>
  );
}
