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
// out of release builds. The phone suite builds the page with VITE_GLAZE_DEV_TOOLS=1 for a
// development build of the app, as a phone loads the built page, not Vite's (ADR 11).
if (import.meta.env.DEV || import.meta.env.VITE_GLAZE_DEV_TOOLS === '1') void import('./devTools').then(({ startDevTools }) => startDevTools());
