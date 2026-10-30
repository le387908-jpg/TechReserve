import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Unregister any existing service workers and clear caches safely
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().catch(() => {});
      }
    })
    .catch(() => {});
}

// Clear caches to ensure no corrupted SW or data is interfering
if (typeof window !== 'undefined' && 'caches' in window) {
  caches
    .keys()
    .then((names) => {
      for (const name of names) {
        caches.delete(name).catch(() => {});
      }
    })
    .catch(() => {});
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
