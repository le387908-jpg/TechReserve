/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { AuthProvider } from './context/AuthContext';
import { ReservationProvider } from './context/ReservationContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getFriendlyErrorMessage } from './services/firebase/utils';
import { AppRoutes } from './routes';

export default function App() {
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('[TechReserve] Rejeição assíncrona não tratada capturada:', event.reason);
      event.preventDefault();

      const msg = getFriendlyErrorMessage(event.reason, '');
      if (msg) {
        toast.error(msg);
      }
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return (
    <ErrorBoundary variant="fullscreen">
      <AuthProvider>
        <ReservationProvider>
          <BrowserRouter>
            <AppRoutes />
            <Toaster position="top-right" richColors />
          </BrowserRouter>
        </ReservationProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
