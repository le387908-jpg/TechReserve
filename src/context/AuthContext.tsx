/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { User } from '../types';
import { SignUpPayload, subscribeToTabAuthState } from '../services/authService';
import { useAuthStore } from '../store/useAuthStore';
import { useReservationStore } from '../store/useReservationStore';
import { usePunishmentStore } from '../store/usePunishmentStore';
import { useLogStore } from '../store/useLogStore';

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  signIn: (email: string, pass: string) => Promise<User>;
  signUp: (data: SignUpPayload) => Promise<User>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  deactivateMyProfile: () => Promise<void>;
  clearError: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Limpa os caches em memória das stores de dados APENAS na aba atual quando o usuário
 * encerra a sessão ou alterna de conta na mesma aba.
 */
function clearCurrentTabDataStores(): void {
  useReservationStore.setState({ reservations: [], loading: false, error: null, scanningResId: null });
  usePunishmentStore.setState({ punishments: [], activePunishment: null, loading: false, error: null });
  useLogStore.setState({ logs: [], loading: false });
}

/**
 * Provedor de Autenticação 100% isolado por aba (`initializeAuth` + `browserSessionPersistence`).
 * - Gerencia exclusivamente o listener `onAuthStateChanged` da aba atual;
 * - Não utiliza `localStorage` nem escuta eventos `window.onstorage` / `BroadcastChannel` para sincronizar sessão;
 * - Permite testar simultaneamente Aluno (Aba A) e Administrador (Aba B) no mesmo navegador.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const initialized = useAuthStore((state) => state.initialized);
  const error = useAuthStore((state) => state.error);
  const syncTabAuthState = useAuthStore((state) => state.syncTabAuthState);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);
  const storeSignOut = useAuthStore((state) => state.signOut);
  const resetPassword = useAuthStore((state) => state.resetPassword);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const deactivateMyProfile = useAuthStore((state) => state.deactivateMyProfile);
  const clearError = useAuthStore((state) => state.clearError);

  const lastTabUidRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToTabAuthState({
      onAuthenticated: (userData) => {
        if (lastTabUidRef.current && lastTabUidRef.current !== userData.id) {
          clearCurrentTabDataStores();
        }
        lastTabUidRef.current = userData.id;
        syncTabAuthState({
          user: userData,
          loading: false,
          initialized: true,
          error: null,
        });
      },
      onUnauthenticated: (reasonError) => {
        lastTabUidRef.current = null;
        clearCurrentTabDataStores();
        syncTabAuthState({
          user: null,
          loading: false,
          initialized: true,
          ...(reasonError ? { error: reasonError } : { error: null }),
        });
      },
      onError: (errorMessage) => {
        syncTabAuthState({
          loading: false,
          initialized: true,
          error: errorMessage,
        });
      },
    });

    const safetyTimeout = window.setTimeout(() => {
      if (!useAuthStore.getState().initialized) {
        syncTabAuthState({ loading: false, initialized: true });
      }
    }, 10000);

    return () => {
      window.clearTimeout(safetyTimeout);
      unsubscribe();
    };
  }, [syncTabAuthState]);

  const signOut = React.useCallback(async () => {
    await storeSignOut();
    lastTabUidRef.current = null;
    clearCurrentTabDataStores();
  }, [storeSignOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      initialized,
      error,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'ADMIN',
      signIn,
      signUp,
      signOut,
      resetPassword,
      updateProfile,
      deactivateMyProfile,
      clearError,
    }),
    [
      user,
      loading,
      initialized,
      error,
      signIn,
      signUp,
      signOut,
      resetPassword,
      updateProfile,
      deactivateMyProfile,
      clearError,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser utilizado dentro de um <AuthProvider>.');
  }
  return context;
}
