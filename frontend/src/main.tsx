import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/app.css';
import { isDesktop } from './lib/platform';

// The desktop app saves API files with a native dialog and opens other links in the user's browser.
if (isDesktop) { document.documentElement.classList.add('desktop'); import('./lib/desktop').then((d) => d.installLinkHandling()); }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
