import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// The screen as text, and a way to drive it, for following development without screenshots. Left
// out of release builds.
if (import.meta.env.DEV) void import('./devTools').then(({ startDevTools }) => startDevTools());
