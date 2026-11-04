/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { useAuthStore } from './useAuthStore';
import { isUserDeleted, isUserInactive } from '../types';
import { buildAuthenticatedJsonHeaders } from '../services/apiClient';
import { savePendingOfflineCheckIn } from '../services/offlineRecoveryService';
import { useConnectivityStore } from './useConnectivityStore';

export type CheckInOutcome = 'CONFIRMED' | 'QUEUED_OFFLINE' | 'ERROR' | null;

interface CheckInState {
  isProcessing: boolean;
  lastOutcome: CheckInOutcome;
  message: {
    type: 'success' | 'pending' | 'error' | null;
    text: string | null;
  };

  processCheckIn: (qrData: string, reservationId?: string) => Promise<boolean>;
  clearMessage: () => void;
}

const VALID_INSTITUTIONAL_PREFIXES = [
  'SALA-',
  'LAB-',
  'BIB-',
  'AUD-',
  'VID-',
  'CAD-',
  'DES-',
  'MAQ-',
  'BRA-',
  'QUI-',
];

function extractAndValidateRoomToken(qrData: string): string {
  const safeQr = String(qrData || '').trim();
  if (!safeQr || safeQr.length > 256) {
    throw new Error('Identificador da sala não encontrado no código.');
  }

  let roomToken = safeQr;
  if (safeQr.toUpperCase().startsWith('TECHRESERVE:')) {
    const parts = safeQr.split(':');
    roomToken = (parts[2] ? safeQr.substring(12).split(':').pop() || parts[1] : parts[1] || '').trim();
  }

  if (!roomToken) {
    throw new Error('Identificador da sala não encontrado no código.');
  }

  const upperToken = roomToken.toUpperCase();
  const hasInstitutionalPrefix = VALID_INSTITUTIONAL_PREFIXES.some((prefix) =>
    upperToken.startsWith(prefix)
  );
  const looksLikeFirestoreDocId = /^[a-zA-Z0-9_-]{10,64}$/.test(roomToken);

  if (!hasInstitutionalPrefix && !looksLikeFirestoreDocId) {
    throw new Error(
      'Código QR inválido. Certifique-se de escanear o código da sala (ex: SALA-001, LAB-001).'
    );
  }

  return safeQr;
}

export const useCheckInStore = create<CheckInState>((set) => ({
  isProcessing: false,
  lastOutcome: null,
  message: {
    type: null,
    text: null,
  },

  clearMessage: () =>
    set({
      lastOutcome: null,
      message: { type: null, text: null },
    }),

  processCheckIn: async (qrData: string, reservationId?: string) => {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({
        lastOutcome: 'ERROR',
        message: {
          type: 'error',
          text: 'Você precisa estar logado para realizar check-in.',
        },
      });
      return false;
    }

    if (isUserDeleted(user) || isUserInactive(user)) {
      set({
        lastOutcome: 'ERROR',
        message: {
          type: 'error',
          text: 'Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações',
        },
      });
      return false;
    }

    let safeQr: string;
    try {
      safeQr = extractAndValidateRoomToken(qrData);
    } catch (validationErr) {
      set({
        isProcessing: false,
        lastOutcome: 'ERROR',
        message: {
          type: 'error',
          text:
            validationErr instanceof Error
              ? validationErr.message
              : 'Código QR inválido para check-in.',
        },
      });
      return false;
    }

    set({ isProcessing: true, lastOutcome: null, message: { type: null, text: null } });

    const queueOfflineScan = async () => {
      await savePendingOfflineCheckIn({
        uid: user.id,
        reservationId,
        qrData: safeQr,
        clientScannedAt: Date.now(),
      });
      await useConnectivityStore.getState().notifyOfflineDetected(user.id);
      set({
        isProcessing: false,
        lastOutcome: 'QUEUED_OFFLINE',
        message: {
          type: 'pending',
          text: 'Sem conexão no momento. A leitura do QR Code foi salva localmente como pendente e será validada no servidor assim que a internet voltar.',
        },
      });
      return true;
    };

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return queueOfflineScan();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const headers = await buildAuthenticatedJsonHeaders();
      const response = await fetch('/api/checkin', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          qrData: safeQr,
          ...(reservationId ? { reservationId } : {}),
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        code?: string;
        message?: string;
      };

      if (response.ok && body?.success) {
        set({
          isProcessing: false,
          lastOutcome: 'CONFIRMED',
          message: {
            type: 'success',
            text: body.message || 'Check-in realizado com sucesso!',
          },
        });
        return true;
      }

      if (response.status >= 502 && response.status <= 504) {
        return queueOfflineScan();
      }

      set({
        isProcessing: false,
        lastOutcome: 'ERROR',
        message: {
          type: 'error',
          text: body?.message || 'Não foi possível validar o check-in para esta reserva.',
        },
      });
      return false;
    } catch (err) {
      const isNetworkOrTimeout =
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        err instanceof TypeError ||
        (err instanceof DOMException && err.name === 'AbortError');

      if (isNetworkOrTimeout) {
        return queueOfflineScan();
      }

      set({
        isProcessing: false,
        lastOutcome: 'ERROR',
        message: {
          type: 'error',
          text: err instanceof Error ? err.message : 'Erro ao processar check-in.',
        },
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  },
}));
