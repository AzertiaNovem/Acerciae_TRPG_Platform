import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/app.css';
import './styles/glass.css';
import './styles/parchment.css';
import { isDesktop } from './lib/platform';
import { restoreToken } from './api/client';

// The desktop app saves API files with a native dialog and opens other links in the user's browser.
if (isDesktop) { document.documentElement.classList.add('desktop'); import('./lib/desktop').then((d) => d.installLinkHandling()); }

// The desktop app keeps the session in the system keychain: read it before anything asks who is signed in.
const ready = isDesktop ? restoreToken().catch(() => undefined) : Promise.resolve();
ready.then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
));
