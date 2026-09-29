import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { removeLegacyEntries, smallStore } from './small-store.ts';
import './styles.css';
// Snapshots and caches moved from the small-key store to IndexedDB; remove the copies earlier versions left.
removeLegacyEntries(smallStore());
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
