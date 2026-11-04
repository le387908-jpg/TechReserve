/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { doc, getDocFromServer } from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '../services/firebase/config';
import { buildAuthenticatedJsonHeaders } from '../services/apiClient';
import {
  clearOfflineInterruptedFlagForUser,
  getPendingOfflineCheckInsForUser,
  getPreservedReservationsForUser,
  markUserReservationsOfflineInterrupted,
  removePendingOfflineCheckIn,
  removePreservedReservation,
  updatePendingOfflineCheckInFailure,
} from '../services/offlineRecoveryService';

export type ConnectionRecoveryState =
  | 'CONECTADO'
  | 'SEM_CONEXAO'
  | 'RECONECTANDO'
  | 'SINCRONIZANDO'
  | 'RESERVA_RECUPERADA'
  | 'FALHA_SINCRONIZACAO';

export const CONNECTION_MESSAGES = {
  OFFLINE_WITH_RESERVATION:
    'Sem conexão com a internet. Sua reserva ativa foi preservada localmente.',
  OFFLINE_GENERAL:
    'Sem conexão com a internet. A reconexão automática será realizada assim que o sinal voltar.',
  RECONNECTING: 'Reconectando ao servidor TechReserve...',
  SYNCING: 'Conexão restabelecida. Sincronizando dados da reserva...',
  RECOVERED: 'Reserva recuperada com sucesso.',
  SYNC_FAILED: 'Não foi possível sincronizar agora. Tentando novamente automaticamente.',
} as const;

interface ConnectivityState {
  status: ConnectionRecoveryState;
  statusMessage: string | null;
  isReachable: boolean;
  serverClockOffsetMs: number;
  preservedCount: number;
  pendingCheckInsCount: number;
  lastSyncedAt: number | null;
  retryAttempt: number;

  getOfficialNow: () => number;
  refreshPendingCounts: (uid: string) => Promise<void>;
  notifyOfflineDetected: (uid?: string) => Promise<void>;
  synchronizeAfterReconnect: (
    uid: string,
    reason?: 'ONLINE_EVENT' | 'STARTUP' | 'MANUAL' | 'RETRY' | 'VISIBILITY',
    onReconcileReservation?: (reservaId: string, serverData: Record<string, unknown> | null) => void
  ) => Promise<boolean>;
}

let syncMutexInFlight = false;
let retryTimerId: ReturnType<typeof setTimeout> | null = null;
let recoveredBannerTimerId: ReturnType<typeof setTimeout> | null = null;

function clearScheduledRetry(): void {
  if (retryTimerId) {
    clearTimeout(retryTimerId);
    retryTimerId = null;
  }
}

function clearRecoveredBannerTimer(): void {
  if (recoveredBannerTimerId) {
    clearTimeout(recoveredBannerTimerId);
    recoveredBannerTimerId = null;
  }
}

async function probeRealServerConnectivity(): Promise<{
  reachable: boolean;
  clockOffsetMs?: number;
}> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { reachable: false };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const clientBefore = Date.now();
    const healthRes = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const clientAfter = Date.now();

    if (!healthRes.ok) {
      return { reachable: false };
    }

    let clockOffsetMs: number | undefined;
    const json = (await healthRes.json().catch(() => null)) as {
      ok?: boolean;
      serverTime?: number;
    } | null;

    if (json && typeof json.serverTime === 'number' && json.serverTime > 0) {
      const midpoint = Math.round((clientBefore + clientAfter) / 2);
      clockOffsetMs = json.serverTime - midpoint;
    }

    // Valida também comunicação direta com o servidor Cloud Firestore (sem usar cache local)
    await getDocFromServer(doc(db, 'test', 'connection'));

    return { reachable: true, clockOffsetMs };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const useConnectivityStore = create<ConnectivityState>((set, get) => ({
  status:
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'SEM_CONEXAO'
      : 'CONECTADO',
  statusMessage:
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? CONNECTION_MESSAGES.OFFLINE_GENERAL
      : null,
  isReachable: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  serverClockOffsetMs: 0,
  preservedCount: 0,
  pendingCheckInsCount: 0,
  lastSyncedAt: null,
  retryAttempt: 0,

  getOfficialNow: () => Date.now() + get().serverClockOffsetMs,

  refreshPendingCounts: async (uid: string) => {
    if (!uid) {
      set({ preservedCount: 0, pendingCheckInsCount: 0 });
      return;
    }
    const [preserved, pending] = await Promise.all([
      getPreservedReservationsForUser(uid),
      getPendingOfflineCheckInsForUser(uid),
    ]);
    set({
      preservedCount: preserved.length,
      pendingCheckInsCount: pending.length,
    });
  },

  notifyOfflineDetected: async (uid?: string) => {
    clearRecoveredBannerTimer();
    let count = get().preservedCount;
    if (uid) {
      count = await markUserReservationsOfflineInterrupted(uid);
      const pending = await getPendingOfflineCheckInsForUser(uid);
      set({
        preservedCount: count,
        pendingCheckInsCount: pending.length,
      });
    }

    set({
      status: 'SEM_CONEXAO',
      isReachable: false,
      statusMessage:
        count > 0
          ? CONNECTION_MESSAGES.OFFLINE_WITH_RESERVATION
          : CONNECTION_MESSAGES.OFFLINE_GENERAL,
    });
  },

  synchronizeAfterReconnect: async (
    uid,
    reason = 'ONLINE_EVENT',
    onReconcileReservation
  ) => {
    if (!uid) return false;
    if (syncMutexInFlight) return false;

    syncMutexInFlight = true;
    clearScheduledRetry();
    clearRecoveredBannerTimer();

    const scheduleAutomaticRetry = () => {
      const nextAttempt = get().retryAttempt + 1;
      const delayMs = Math.min(45000, 3000 * Math.pow(2, Math.min(4, nextAttempt - 1)));
      set({
        status: 'FALHA_SINCRONIZACAO',
        isReachable: false,
        statusMessage: CONNECTION_MESSAGES.SYNC_FAILED,
        retryAttempt: nextAttempt,
      });

      clearScheduledRetry();
      retryTimerId = setTimeout(() => {
        void get().synchronizeAfterReconnect(uid, 'RETRY', onReconcileReservation);
      }, delayMs);
    };

    try {
      const [preservedBefore, pendingBefore] = await Promise.all([
        getPreservedReservationsForUser(uid),
        getPendingOfflineCheckInsForUser(uid),
      ]);

      const hadInterruptedReservations = preservedBefore.some(
        (r) => r.wasOfflineInterrupted
      );
      const hasWorkToRecover =
        hadInterruptedReservations ||
        pendingBefore.length > 0 ||
        reason !== 'STARTUP';

      if (reason === 'STARTUP' && !hadInterruptedReservations && pendingBefore.length === 0) {
        const silentProbe = await probeRealServerConnectivity();
        if (silentProbe.reachable) {
          set({
            status: 'CONECTADO',
            statusMessage: null,
            isReachable: true,
            ...(typeof silentProbe.clockOffsetMs === 'number'
              ? { serverClockOffsetMs: silentProbe.clockOffsetMs }
              : {}),
            preservedCount: preservedBefore.length,
            pendingCheckInsCount: 0,
            retryAttempt: 0,
            lastSyncedAt: Date.now(),
          });
          return true;
        }
        await get().notifyOfflineDetected(uid);
        return false;
      }

      if (hasWorkToRecover) {
        set({
          status: 'RECONECTANDO',
          statusMessage: CONNECTION_MESSAGES.RECONNECTING,
        });
      }

      const probe = await probeRealServerConnectivity();
      if (!probe.reachable) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          await get().notifyOfflineDetected(uid);
        } else {
          scheduleAutomaticRetry();
        }
        return false;
      }

      if (typeof probe.clockOffsetMs === 'number') {
        set({ serverClockOffsetMs: probe.clockOffsetMs });
      }

      set({
        status: 'SINCRONIZANDO',
        isReachable: true,
        statusMessage: CONNECTION_MESSAGES.SYNCING,
      });

      // 1. Sincroniza leituras de QR Code pendentes capturadas durante queda de rede (idempotente)
      let transientCheckInError = false;
      for (const pendingItem of pendingBefore) {
        try {
          const headers = await buildAuthenticatedJsonHeaders();
          const res = await fetch('/api/checkin', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              qrData: pendingItem.qrData,
              reservationId: pendingItem.reservationId,
              clientScannedAt: pendingItem.clientScannedAt,
            }),
          });

          const data = (await res.json().catch(() => ({}))) as {
            success?: boolean;
            code?: string;
            message?: string;
            salaNome?: string;
          };

          if (res.ok && data.success) {
            await removePendingOfflineCheckIn(pendingItem.key);
            toast.success(
              `Check-in validado no servidor após reconexão${
                data.salaNome ? ` (${data.salaNome})` : ''
              }!`
            );
          } else if (data.code === 'ALREADY_CONFIRMED') {
            await removePendingOfflineCheckIn(pendingItem.key);
          } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            // Rejeição definitiva de regra de negócio no servidor (ex.: prazo oficial expirado ou QR incorreto)
            await removePendingOfflineCheckIn(pendingItem.key);
            toast.error(
              data.message ||
                'A leitura offline do QR Code não pôde ser validada no servidor.'
            );
          } else {
            transientCheckInError = true;
            await updatePendingOfflineCheckInFailure(
              pendingItem.key,
              data.message || `HTTP ${res.status}`
            );
          }
        } catch (err) {
          transientCheckInError = true;
          await updatePendingOfflineCheckInFailure(
            pendingItem.key,
            err instanceof Error ? err.message : 'Erro de rede na sincronização'
          );
        }
      }

      // 2. Reconcilia o estado real de cada reserva preservada diretamente no Firestore (servidor)
      let recoveredActiveCount = 0;
      for (const rec of preservedBefore) {
        try {
          const serverSnap = await getDocFromServer(doc(db, 'reservas', rec.reservationId));
          if (!serverSnap.exists()) {
            await removePreservedReservation(rec.key);
            onReconcileReservation?.(rec.reservationId, null);
            continue;
          }

          const serverData = serverSnap.data() as Record<string, unknown>;
          onReconcileReservation?.(rec.reservationId, serverData);

          const serverStatus = String(serverData.status || '');
          if (serverStatus === 'PENDENTE' || serverStatus === 'CONFIRMADA') {
            recoveredActiveCount += 1;
          } else {
            await removePreservedReservation(rec.key);
          }
        } catch {
          transientCheckInError = true;
        }
      }

      if (transientCheckInError) {
        await get().refreshPendingCounts(uid);
        scheduleAutomaticRetry();
        return false;
      }

      await clearOfflineInterruptedFlagForUser(uid);
      await get().refreshPendingCounts(uid);

      const shouldShowRecoveredState =
        recoveredActiveCount > 0 && (hadInterruptedReservations || pendingBefore.length > 0);

      if (shouldShowRecoveredState) {
        set({
          status: 'RESERVA_RECUPERADA',
          statusMessage: CONNECTION_MESSAGES.RECOVERED,
          isReachable: true,
          retryAttempt: 0,
          lastSyncedAt: Date.now(),
        });

        recoveredBannerTimerId = setTimeout(() => {
          if (get().status === 'RESERVA_RECUPERADA') {
            set({ status: 'CONECTADO', statusMessage: null });
          }
        }, 6000);
      } else {
        set({
          status: 'CONECTADO',
          statusMessage: null,
          isReachable: true,
          retryAttempt: 0,
          lastSyncedAt: Date.now(),
        });
      }

      return true;
    } finally {
      syncMutexInFlight = false;
    }
  },
}));
