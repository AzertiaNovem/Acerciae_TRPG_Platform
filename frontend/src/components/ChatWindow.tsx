import { useNav } from '../store/nav';
import MessageList from './MessageList';
import MessageComposer from './MessageComposer';
import ConsistencyResultPanel from './ConsistencyResultPanel';
import InspirationDraftPanel from './InspirationDraftPanel';
import { useUi } from '../store/ui';
import ContextBubbleDock from './ContextBubbleDock';

export default function ChatWindow() {
  const { windows, windowId, channel, scenes } = useNav();
  const win = windows.find((w) => w.id === windowId);
  const consistency = useUi((s) => s.consistency);
  const inspiration = useUi((s) => s.inspiration);
  if (!win || !channel) return null;
  const scene = scenes.find((s) => s.id === win.active_scene_id);
  return (
    <>
      <div className="chat-header">
        <h2>{win.name}</h2>
        <span className="pill">{win.kind}</span>
        {scene && <span className="scene-chip" title={scene.location}>{scene.title}{scene.location ? ` · ${scene.location}` : ''}{scene.narrative_time ? ` · ${scene.narrative_time}` : ''}</span>}
        <span className="grow" />
        <span className="tiny muted" title="Participants">{(win.members ?? []).map((m) => m.character_name ?? m.display_name).join(' · ')}</span>
        <span className="pill" title="Knowledge mode">{channel.knowledge_mode === 'isolated' ? 'knowledge: isolated' : 'knowledge: public'}</span>
      </div>
      <div className="chat-body">
        <MessageList />
        <ContextBubbleDock />
      </div>
      <div style={{ position: 'relative' }}>
        {consistency && <ConsistencyResultPanel />}
        {inspiration && !consistency && <InspirationDraftPanel />}
        <MessageComposer />
      </div>
    </>
  );
}
