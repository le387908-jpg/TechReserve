/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { AdminAuthConfig, WhatsAppIntegrationSettings } from '../types';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { computeAdminCodeHashClient } from '../services/apiClient';
import { useAuthStore } from './useAuthStore';
import { useLogStore } from './useLogStore';

interface SaveWhatsAppIntegrationInput {
  instanceName?: string;
  provider?: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK';
  whatsappConnected?: boolean;
  isConfigured?: boolean;
  silentLog?: boolean;
}

interface AdminSettingsState {
  authConfig: AdminAuthConfig;
  loading: boolean;
  initialized: boolean;

  whatsappIntegration: WhatsAppIntegrationSettings;
  whatsappExistsInFirestore: boolean;
  whatsappInitialized: boolean;

  fetchAdminAuthConfig: () => () => void;
  saveAdminAuthConfig: (data: { codeAuth?: string; allowAdminSignup: boolean }) => Promise<void>;
  fetchWhatsAppIntegration: () => () => void;
  saveWhatsAppIntegration: (data: SaveWhatsAppIntegrationInput) => Promise<void>;
  generateSecureCode: () => string;
}

const DEFAULT_AUTH_CONFIG: AdminAuthConfig = {
  codeHash: '',
  codeMask: 'Não definido',
  allowAdminSignup: false,
  updatedAt: 0,
  updatedBy: 'SISTEMA',
  updatedByName: 'Segurança Institucional',
};

const DEFAULT_WHATSAPP_INTEGRATION: WhatsAppIntegrationSettings = {
  whatsappConnected: false,
  isConfigured: false,
  instanceName: 'techreserve',
  provider: 'EVOLUTION',
  updatedAt: 0,
  updatedBy: 'SISTEMA',
  updatedByName: 'Padrão Institucional',
};

export const useAdminSettingsStore = create<AdminSettingsState>((set, get) => ({
  authConfig: DEFAULT_AUTH_CONFIG,
  loading: false,
  initialized: false,

  whatsappIntegration: DEFAULT_WHATSAPP_INTEGRATION,
  whatsappExistsInFirestore: false,
  whatsappInitialized: false,

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
          const fallbackMask =
            data.codeMask ||
            (data.codeAuth && data.codeAuth.length >= 2
              ? `${'*'.repeat(Math.max(4, data.codeAuth.length - 2))}${data.codeAuth.slice(-2)}`
              : data.codeHash
              ? '********'
              : 'Não definido');
          set({
            authConfig: {
              ...DEFAULT_AUTH_CONFIG,
              allowAdminSignup: data.allowAdminSignup ?? false,
              codeHash: data.codeHash || '',
              codeMask: fallbackMask,
              updatedAt: data.updatedAt || 0,
              updatedBy: data.updatedBy || 'SISTEMA',
              updatedByName: data.updatedByName || 'Administrador',
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

    const current = get().authConfig;
    const cleanCode = String(codeAuth || '').trim();

    let nextHash = current.codeHash || '';
    let nextMask = current.codeMask || 'Não definido';

    if (cleanCode) {
      if (cleanCode.length < 6 || cleanCode.length > 64) {
        throw new Error(
          'O novo código de autorização (code-auth) deve ter entre 6 e 64 caracteres.'
        );
      }
      nextHash = await computeAdminCodeHashClient(cleanCode);
      nextMask = `${'*'.repeat(Math.max(4, cleanCode.length - 2))}${cleanCode.slice(-2)}`;
    } else if (!nextHash && allowAdminSignup) {
      throw new Error(
        'Defina ou gere um novo código code-auth (mínimo 6 caracteres) antes de habilitar cadastros administrativos.'
      );
    }

    const now = Date.now();
    const payload = {
      codeHash: nextHash,
      codeMask: nextMask,
      allowAdminSignup: Boolean(allowAdminSignup),
      updatedAt: now,
      updatedBy: user.id.slice(0, 128),
      updatedByName: (user.nome || 'Administrador').slice(0, 120),
    };

    try {
      await withRetry(() => setDoc(doc(db, 'settings', 'admin_auth'), payload));
      set({ authConfig: payload });

      await useLogStore
        .getState()
        .addLog({
          acao: 'ATUALIZAR_CODE_AUTH',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SISTEMA',
          detalhes: `Credencial administrativa protegida por hash SHA-256 (${nextMask}) atualizada. Novos cadastros ADM: ${
            allowAdminSignup ? 'Habilitados' : 'Bloqueados'
          }.`,
        })
        .catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/admin_auth');
    }
  },

  fetchWhatsAppIntegration: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      return () => {};
    }

    const ref = doc(db, 'settings', 'whatsapp_integration');
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Partial<WhatsAppIntegrationSettings>;
          set({
            whatsappIntegration: {
              ...DEFAULT_WHATSAPP_INTEGRATION,
              ...data,
              whatsappConnected: Boolean(data.whatsappConnected),
              isConfigured: Boolean(data.isConfigured),
              instanceName: String(data.instanceName || 'techreserve').trim() || 'techreserve',
              provider:
                data.provider === 'META_CLOUD' || data.provider === 'WEBHOOK'
                  ? data.provider
                  : 'EVOLUTION',
            },
            whatsappExistsInFirestore: true,
            whatsappInitialized: true,
          });
        } else {
          set({
            whatsappIntegration: DEFAULT_WHATSAPP_INTEGRATION,
            whatsappExistsInFirestore: false,
            whatsappInitialized: true,
          });
        }
      },
      (err) => {
        console.warn('Could not read whatsapp_integration settings:', err);
        set({ whatsappInitialized: true });
      }
    );

    return unsubscribe;
  },

  saveWhatsAppIntegration: async ({
    instanceName,
    provider,
    whatsappConnected = true,
    isConfigured = true,
    silentLog = false,
  }) => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      return;
    }

    const current = get().whatsappIntegration;
    const cleanInstance =
      (instanceName ?? current.instanceName ?? 'techreserve')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 80) || 'techreserve';
    const resolvedProvider = provider || current.provider || 'EVOLUTION';
    const now = Date.now();

    const payload: WhatsAppIntegrationSettings = {
      whatsappConnected: Boolean(whatsappConnected),
      isConfigured: Boolean(isConfigured),
      instanceName: cleanInstance,
      provider: resolvedProvider,
      updatedAt: now,
      updatedBy: user.id.slice(0, 128),
      updatedByName: (user.nome || 'Administrador').slice(0, 120),
    };

    try {
      await withRetry(() => setDoc(doc(db, 'settings', 'whatsapp_integration'), payload));
      set({
        whatsappIntegration: payload,
        whatsappExistsInFirestore: true,
        whatsappInitialized: true,
      });

      if (!silentLog) {
        await useLogStore
          .getState()
          .addLog({
            acao: 'ATUALIZAR_INTEGRACAO_WHATSAPP',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'WHATSAPP',
            detalhes: `Integração WhatsApp (${resolvedProvider} · instância "${cleanInstance}") salva como ativa no Firestore.`,
          })
          .catch(() => {});
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/whatsapp_integration');
    }
  },

  generateSecureCode: () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const randomValues = new Uint32Array(8);
    crypto.getRandomValues(randomValues);
    let randomPart = '';
    for (let i = 0; i < 8; i++) {
      randomPart += chars.charAt(randomValues[i] % chars.length);
    }
    return `ADM-${randomPart}`;
  },
}));
