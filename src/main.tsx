import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const isProductionBuild = Boolean(
  (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD
);

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  if (isProductionBuild) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          console.warn('[PWA] Falha não crítica ao registrar Service Worker:', err);
        });
    });
  } else {
    // Em desenvolvimento local (Vite), remove Service Workers antigos para evitar cache de módulos
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const registration of registrations) {
          registration.unregister().catch(() => {});
        }
      })
      .catch(() => {});
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary variant="fullscreen">
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}
