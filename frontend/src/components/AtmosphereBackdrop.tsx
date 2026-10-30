import { useEffect, useState } from 'react';
import { api, ensureFileToken } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { contextSocket } from '../api/ws';
import { t } from '../i18n';
import { atmosphereVariant } from '../lib/atmosphere';

// One channel backdrop across all its chat windows; personal opt-out unmounts and releases the image.
export default function AtmosphereBackdrop() {
  const channel = useNav(s => s.channelId);
  const serverEnabled = useNav(s => !!s.serverSettings?.features.atmosphere);
  const channelEnabled = useNav(s => s.channel?.atmosphere_enabled !== false);
  const personalEnabled = useAuth(s => !!s.user?.atmosphere_enabled);
  const enabled = serverEnabled && channelEnabled && personalEnabled;
  const [backdrop, setBackdrop] = useState<{ channel: string; url: string; mock: boolean } | null>(null);
  const [portrait, setPortrait] = useState(() => matchMedia('(orientation: portrait)').matches);
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)'); const change = () => setDark(query.matches);
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const query = matchMedia('(orientation: portrait)'); const change = () => setPortrait(query.matches);
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    setBackdrop(null);
    if (!channel || !enabled) return;
    let cancelled = false, sequence = 0;
    const load = async () => {
      const seq = ++sequence;
      try {
        const current = await api.atmosphere(channel);
        const id = current.assets?.[atmosphereVariant(dark, portrait)];
        if (!current.enabled || !id) { if (!cancelled && seq === sequence) setBackdrop(null); return; }
        await ensureFileToken();
        if (!cancelled && seq === sequence) setBackdrop({ channel, url: api.atmosphereImage(channel, id), mock: !!current.mock });
      } catch { if (!cancelled && seq === sequence) setBackdrop(null); }
    };
    void load(); const timer = setInterval(load, 30000);
    const off = contextSocket.on(m => { if (m.type === '_open' || (m.channel_id === channel && (m.type === 'studio.atmosphere.updated' || m.type === 'server.settings'))) void load(); });
    return () => { cancelled = true; off(); clearInterval(timer); };
  }, [channel, enabled, portrait, dark]);
  if (!enabled || !backdrop || backdrop.channel !== channel) return null;
  return <div className="atmosphere-backdrop" aria-hidden="true">
    <img src={backdrop.url} alt="" onError={() => setBackdrop(null)} />
    {backdrop.mock && <span className="atmosphere-mock">{t('Mock background')}</span>}
  </div>;
}
