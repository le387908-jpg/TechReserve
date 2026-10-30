/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { User } from '../types';
import {
  SignUpPayload,
  deactivateCurrentUserProfile,
  loginWithEmail,
  logoutTabSession,
  registerWithEmail,
  sendPasswordReset,
  updateUserProfileInFirestore,
} from '../services/authService';

export interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;

  syncTabAuthState: (patch: Partial<Pick<AuthState, 'user' | 'loading' | 'initialized' | 'error'>>) => void;
  signIn: (email: string, pass: string) => Promise<User>;
  signUp: (data: SignUpPayload) => Promise<User>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  deactivateMyProfile: () => Promise<void>;
  clearError: () => void;
  setInitialized: (val: boolean) => void;
}

/**
 * Store em memória estritamente local à aba atual (sem middleware `persist`, sem `localStorage`
 * e sem `BroadcastChannel` / `storage` listeners). Sincronizado pelo `<AuthProvider>` via `onAuthStateChanged`.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  initialized: false,
  error: null,

  syncTabAuthState: (patch) => set((state) => ({ ...state, ...patch })),
  setInitialized: (val: boolean) => set({ initialized: val }),
  clearError: () => set({ error: null }),

  signIn: async (email, pass) => {
    set({ loading: true, error: null });
    try {
      const userData = await loginWithEmail(email, pass);
      set({ user: userData, loading: false, initialized: true, error: null });
      return userData;
    } catch (err: any) {
      const message = err?.message || 'E-mail ou senha incorretos.';
      set({ error: message, loading: false });
      throw new Error(message);
    }
  },

  signUp: async (payload) => {
    set({ loading: true, error: null });
    try {
      const userData = await registerWithEmail(payload);
      set({ user: userData, loading: false, initialized: true, error: null });
      return userData;
    } catch (err: any) {
      const message = err?.message || 'Erro ao realizar cadastro.';
      set({ error: message, loading: false });
      throw new Error(message);
    }
  },

  signOut: async () => {
    set({ loading: true, error: null });
    try {
      await logoutTabSession();
    } finally {
      set({ user: null, loading: false, initialized: true, error: null });
    }
  },

  resetPassword: async (email) => {
    await sendPasswordReset(email);
  },

  updateProfile: async (data) => {
    const currentUser = get().user;
    if (!currentUser) return;

    const updatedUser = await updateUserProfileInFirestore(currentUser, data);
    set({ user: updatedUser });
  },

  deactivateMyProfile: async () => {
    const currentUser = get().user;
    if (!currentUser) return;

    await deactivateCurrentUserProfile(currentUser);
    set({ user: null, loading: false });
  },
}));
