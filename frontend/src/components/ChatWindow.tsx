import { t as tr } from '../i18n';
import { useNav } from '../store/nav';
import MessageList from './MessageList';
import MessageComposer from './MessageComposer';
import RecallPanel from './RecallPanel';
import { useUi } from '../store/ui';
import ContextBubbleDock from './ContextBubbleDock';

export default function ChatWindow() {
  const { windows, windowId, channel, scenes } = useNav();
  const win = windows.find((w) => w.id === windowId);
  const recall = useUi((s) => s.recall);
  if (!win || !channel) return null;
  const scene = scenes.find((s) => s.id === win.active_scene_id);
  return (
    <>
      <div className="chat-header">
        <h2>{win.name}</h2>
        <span className="pill">{tr(win.kind)}</span>
        {scene && <span className="scene-chip" title={scene.location}>{scene.title}{scene.location ? ` · ${scene.location}` : ''}{scene.narrative_time ? ` · ${scene.narrative_time}` : ''}</span>}
        <span className="grow" />
        <span className="tiny muted" title={tr("Participants")}>{(win.members ?? []).map((m) => m.character_name ?? m.display_name).join(' · ')}</span>
        <span className="pill" title={tr("Knowledge mode")}>{channel.my_role === 'gm' ? tr("GM only") : `${tr("Player group")}: ${channel.player_group_name ?? "…"}`}</span>
      </div>
      <div className="chat-body">
        <MessageList />
        <ContextBubbleDock />
      </div>
      <div style={{ position: 'relative' }}>
        {recall && <RecallPanel />}
        <MessageComposer />
      </div>
    </>
  );
}
