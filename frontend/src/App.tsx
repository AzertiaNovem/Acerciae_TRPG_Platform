import { t as tr } from './i18n';
import { useLocale } from './i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from './store/auth';
import { useNav } from './store/nav';
import { useUi } from './store/ui';
import { useRealtime } from './hooks/useRealtime';
import LoginScreen from './components/LoginScreen';
import ServerSidebar from './components/ServerSidebar';
import ChannelSidebar from './components/ChannelSidebar';
import ChatWindow from './components/ChatWindow';
import EvidenceModal from './components/EvidenceModal';
import CharacterSpace from './components/CharacterSpace';
import SpectatorView from './components/SpectatorView';
import ErrorBoundary from './components/ErrorBoundary';

// The workspaces (and pdf.js behind the Studio) load on first use, not with the chat.
const GMWorkspace = lazy(() => import('./components/GMWorkspace'));
const StudioWorkspace = lazy(() => import('./components/studio/StudioWorkspace'));
const SharedPublication = lazy(() => import('./components/studio/PublicationViewer'));

function Shell() {
  useRealtime();
  const { channelId, windowId, gmWorkspaceOpen, studioOpen, characterSpaceId, channel, loadServers, spectateChannelId } = useNav();
  const toasts = useUi((s) => s.toasts);
  const aiActivity = useUi((s) => s.aiActivity);
  const llmMode = useNav((s) => s.serverSettings?.llm_mode);   // AI belongs to each server; there is no platform key
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => { loadServers().catch(() => undefined); }, [loadServers]);
  return (
    <div className="app">
      <ServerSidebar onPick={() => setSidebarOpen(true)} />
      <ChannelSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main">
        {llmMode === 'mock' && <div className="mode-banner">{tr("MOCK LLM MODE — this server has no language model configured (a maintainer sets one in Server settings → AI); the background chronicler runs on rule-based extraction so every flow is demonstrable end to end.")}</div>}
        {aiActivity && <div className="ai-activity">✎ {aiActivity}</div>}
        <Suspense fallback={<div style={{ padding: 40 }} className="muted">{tr('Loading…')}</div>}>
        <ErrorBoundary resetKey={[spectateChannelId, channelId, windowId, characterSpaceId, studioOpen, gmWorkspaceOpen].join('|')}>
        {spectateChannelId ? <SpectatorView key={spectateChannelId} channelId={spectateChannelId} /> : channelId && characterSpaceId ? <CharacterSpace key={characterSpaceId} characterId={characterSpaceId} /> : channelId && studioOpen ? <StudioWorkspace key={channelId} /> : channelId && gmWorkspaceOpen && channel?.my_role === 'gm' ? <GMWorkspace /> : channelId && windowId ? <ChatWindow /> : (
          <div style={{ padding: 40 }} className="muted">{tr("Pick a server and channel, or create one from the left.")}</div>
        )}
        </ErrorBoundary>
        </Suspense>
      </div>
      <EvidenceModal />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind ?? ''}`}>{tr(t.text)}</div>)}</div>
    </div>
  );
}

function AuthenticatedApp() {
  const { user, loading, bootstrap } = useAuth();
  useEffect(() => { bootstrap(); }, [bootstrap]);
  if (loading) return <div className="login"><div className="muted">{tr("Loading…")}</div></div>;
  if (!user) return <LoginScreen />;
  return <Shell />;
}

export default function App() {
  const language = useLocale((s) => s.language);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const token = new URLSearchParams(location.search).get("publication");
  return token ? <Suspense fallback={null}><SharedPublication token={token} /></Suspense> : <AuthenticatedApp />;
}
