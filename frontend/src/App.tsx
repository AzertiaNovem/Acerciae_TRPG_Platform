import { useEffect, useState } from 'react';
import { useAuth } from './store/auth';
import { useNav } from './store/nav';
import { useUi } from './store/ui';
import { useRealtime } from './hooks/useRealtime';
import LoginScreen from './components/LoginScreen';
import ServerSidebar from './components/ServerSidebar';
import ChannelSidebar from './components/ChannelSidebar';
import ChatWindow from './components/ChatWindow';
import GMWorkspace from './components/GMWorkspace';
import EvidenceModal from './components/EvidenceModal';

function Shell() {
  useRealtime();
  const { channelId, windowId, gmWorkspaceOpen, channel, loadServers } = useNav();
  const toasts = useUi((s) => s.toasts);
  const aiActivity = useUi((s) => s.aiActivity);
  const platformMode = useAuth((s) => s.llmMode);
  const serverMode = useNav((s) => s.serverSettings?.llm_mode);
  const llmMode = serverMode ?? platformMode;   // a server with its own key runs live even when the platform has none
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => { loadServers().catch(() => undefined); }, [loadServers]);
  return (
    <div className="app">
      <ServerSidebar onPick={() => setSidebarOpen(true)} />
      <ChannelSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main">
        {llmMode === 'mock' && <div className="mode-banner">MOCK LLM MODE — no LLM API key for this server or the platform; the background chronicler runs on rule-based extraction so every flow is demonstrable end to end.</div>}
        {aiActivity && <div className="ai-activity">✎ {aiActivity}</div>}
        {channelId && gmWorkspaceOpen && channel?.my_role === 'gm' ? <GMWorkspace /> : channelId && windowId ? <ChatWindow /> : (
          <div style={{ padding: 40 }} className="muted">Pick a server and channel, or create one from the left.</div>
        )}
      </div>
      <EvidenceModal />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}</div>)}</div>
    </div>
  );
}

export default function App() {
  const { user, loading, bootstrap } = useAuth();
  useEffect(() => { bootstrap(); }, [bootstrap]);
  if (loading) return <div className="login"><div className="muted">Loading…</div></div>;
  if (!user) return <LoginScreen />;
  return <Shell />;
}
