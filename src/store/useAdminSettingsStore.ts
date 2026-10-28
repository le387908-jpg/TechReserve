/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { AdminAuthConfig } from '../types';
import { ADMIN_AUTH_CODE } from '../constants';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { useAuthStore } from './useAuthStore';
import { useLogStore } from './useLogStore';

interface AdminSettingsState {
  authConfig: AdminAuthConfig;
  loading: boolean;
  initialized: boolean;

  fetchAdminAuthConfig: () => () => void;
  saveAdminAuthConfig: (data: { codeAuth: string; allowAdminSignup: boolean }) => Promise<void>;
  generateSecureCode: () => string;
}

const DEFAULT_AUTH_CONFIG: AdminAuthConfig = {
  codeAuth: ADMIN_AUTH_CODE,
  allowAdminSignup: true,
  updatedAt: 0,
  updatedBy: 'SISTEMA',
  updatedByName: 'Padrão Institucional',
};

export const useAdminSettingsStore = create<AdminSettingsState>((set) => ({
  authConfig: DEFAULT_AUTH_CONFIG,
  loading: false,
  initialized: false,

  fetchAdminAuthConfig: () => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      return () => {};
    }

    set({ loading: true });
    const ref = doc(db, 'settings', 'admin_auth');

    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as AdminAuthConfig;
          set({
            authConfig: {
              ...DEFAULT_AUTH_CONFIG,
              ...data,
            },
            loading: false,
            initialized: true,
          });
        } else {
          set({
            authConfig: DEFAULT_AUTH_CONFIG,
            loading: false,
            initialized: true,
          });
        }
      },
      (err) => {
        console.warn('Could not read admin_auth settings:', err);
        set({ loading: false, initialized: true });
      }
    );

    return unsubscribe;
  },

  saveAdminAuthConfig: async ({ codeAuth, allowAdminSignup }) => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      throw new Error('Apenas administradores podem alterar o código de autorização.');
    }

    const cleanCode = codeAuth.trim();
    if (cleanCode.length < 4 || cleanCode.length > 64) {
      throw new Error('O código de autorização (code-auth) deve ter entre 4 e 64 caracteres.');
    }

    const now = Date.now();
    const payload: AdminAuthConfig = {
      codeAuth: cleanCode,
      allowAdminSignup,
      updatedAt: now,
      updatedBy: user.id,
      updatedByName: user.nome,
    };

    try {
      await withRetry(() => setDoc(doc(db, 'settings', 'admin_auth'), payload));
      set({ authConfig: payload });

      const masked = cleanCode.length > 2 ? `${'*'.repeat(cleanCode.length - 2)}${cleanCode.slice(-2)}` : '****';
      await useLogStore.getState().addLog({
        acao: 'ATUALIZAR_CODE_AUTH',
        usuarioId: user.id,
        usuarioNome: user.nome,
        entidade: 'SISTEMA',
        detalhes: `Código de autorização administrativa (code-auth: ${masked}) atualizado. Novos cadastros ADM: ${
          allowAdminSignup ? 'Habilitados' : 'Bloqueados'
        }.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/admin_auth');
    }
  },

  generateSecureCode: () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let randomPart = '';
    for (let i = 0; i < 6; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `ADM-${randomPart}`;
  },
}));
