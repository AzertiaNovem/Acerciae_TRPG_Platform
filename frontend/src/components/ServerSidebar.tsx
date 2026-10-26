import { useState } from 'react';
import { useNav } from '../store/nav';
import { api } from '../api/client';

export default function ServerSidebar({ onPick }: { onPick: () => void }) {
  const { servers, serverId, selectServer, loadServers } = useNav();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = async () => { if (!name.trim()) return; const s = await api.createServer(name.trim()); setName(''); setCreating(false); await loadServers(); await selectServer(s.id); };
  return (
    <div className="server-sidebar">
      {servers.map((s) => (
        <div key={s.id} className={`server-icon ${s.id === serverId ? 'active' : ''}`} title={s.name} onClick={() => { selectServer(s.id); onPick(); }}>{s.name.slice(0, 2).toUpperCase()}</div>
      ))}
      <div className="server-icon add" title="Create server" onClick={() => setCreating(true)}>+</div>
      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal col" onClick={(e) => e.stopPropagation()}>
            <h3>New server</h3>
            <input placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && create()} />
            <div className="row"><button className="primary" onClick={create}>Create</button><button className="ghost" onClick={() => setCreating(false)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
