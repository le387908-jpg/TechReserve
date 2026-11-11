/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  collection,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
  query,
  getDoc,
  orderBy,
  runTransaction,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { Reservation, User, isUserDeleted, isUserInactive } from '../types';
import {
  OperationType,
  getFriendlyErrorMessage,
  handleFirestoreError,
  stripUndefinedFields,
  withRetry,
} from '../services/firebase/utils';
import { useLogStore } from './useLogStore';
import { useAuthStore } from './useAuthStore';
import { useRoomStore } from './useRoomStore';
import { useScheduleStore } from './useScheduleStore';
import { usePunishmentStore } from './usePunishmentStore';
import {
  checkNoShowSuspensionForDate,
  formatNoShowTag,
  getReleasedBlocksForRoomOnDate,
  isSpaceReleasedByAdmin,
  verifyAvailableSlotFirestore,
  verifyWeeklyQuotaFirestore,
} from '../services/reservationService';
import { createSafeLocalDateTime } from '../utils/dateUtils';
import { hydrateUserDocument } from '../services/authService';
import {
  notifyReservationCancelled,
  notifyReservationConfirmed,
} from '../services/whatsappService';
import { buildAvailableSlotId } from './useAvailableSlotsStore';
import { syncUserActiveReservationsToLocal } from '../services/offlineRecoveryService';
import { useConnectivityStore } from './useConnectivityStore';
import { buildAuthenticatedJsonHeaders } from '../services/apiClient';
import { toast } from 'sonner';

let isMissedCheckInsInProgress = false;
let lastMissedCheckInsRun = 0;
const MISSED_CHECKINS_THROTTLE_MS = 60 * 1000;

interface ReservationState {
  reservations: Reservation[];
  loading: boolean;
  initialized: boolean;
  error: string | null;

  fetchReservations: () => () => void;
  addReservation: (reservation: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateReservation: (id: string, data: Partial<Reservation>) => Promise<void>;
  checkIn: (id: string) => Promise<void>;
  hideForUser: (id: string) => Promise<void>;
  deleteReservation: (id: string) => Promise<void>;
  processMissedCheckIns: () => Promise<void>;
  archiveReservationWithoutPenalty: (
    id: string,
    justificativa?: string
  ) => Promise<void>;
  registerNoShowManual: (id: string) => Promise<void>;
  reconcileServerReservation: (
    id: string,
    serverData: Record<string, unknown> | null
  ) => void;

  scanningResId: string | null;
  setScanningResId: (id: string | null) => void;
}

export const useReservationStore = create<ReservationState>((set, get) => ({
  reservations: [],
  loading: false,
  initialized: false,
  error: null,
  scanningResId: null,

  setScanningResId: (id) => set({ scanningResId: id }),

  fetchReservations: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      return () => {};
    }

    set({ loading: true, error: null });
    const q = query(collection(db, 'reservas'), orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const reservations = snapshot.docs.map((docSnap) => {
          const d = docSnap.data() || {};
          return {
            ...d,
            id: docSnap.id,
            salaId: String(d.salaId || ''),
            salaNome: String(d.salaNome || ''),
            usuarioId: String(d.usuarioId || ''),
            data: String(d.data || ''),
            inicio: String(d.inicio || ''),
            fim: String(d.fim || ''),
            status: d.status || 'PENDENTE',
          } as Reservation;
        });
        set({ reservations, loading: false, initialized: true, error: null });
        const activeUid = useAuthStore.getState().user?.id;
        if (activeUid) {
          const isOfflineNow = !useConnectivityStore.getState().isReachable;
          void syncUserActiveReservationsToLocal(activeUid, reservations, isOfflineNow).then(
            () => useConnectivityStore.getState().refreshPendingCounts(activeUid)
          );
        }
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, 'reservas');
        } catch {
          // Erro já registrado estruturadamente
        }
        set({
          loading: false,
          initialized: true,
          error: getFriendlyErrorMessage(error, 'Erro ao sincronizar reservas.'),
        });
      }
    );

    return unsubscribe;
  },

  addReservation: async (resData) => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error('Autenticação necessária para realizar agendamentos.');
    }
    if (isUserDeleted(user) || isUserInactive(user)) {
      throw new Error(
        'Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações'
      );
    }
    const isAdmin = user.role === 'ADMIN';
    let verifiedAvailableSlotId: string | undefined = resData.availableSlotId;
    const storeRooms = useRoomStore.getState().rooms;
    const safeRooms = Array.isArray(storeRooms) ? storeRooms : [];
    const resolvedRoom = safeRooms.find(
      (r) =>
        r?.firestoreId === resData.salaId ||
        (resData.salaInstitutionalId && r?.id === resData.salaInstitutionalId) ||
        (resData.salaNome && r?.nome === resData.salaNome)
    );

    // Validações estritas de regras de negócio para usuários comuns antes de gravar no Firestore
    if (!isAdmin) {
      if (!resolvedRoom) {
        throw new Error('Sala não encontrada no inventário institucional.');
      }

      // 1. Pré-requisito de liberação da sala e registro explícito em `available_slots` pelo ADM
      const roomRelease = isSpaceReleasedByAdmin(resolvedRoom);
      if (!roomRelease.released) {
        throw new Error(
          roomRelease.reason ||
            'Esta sala não está liberada pelo administrador para agendamentos.'
        );
      }

      // Confirma diretamente no Firestore (`available_slots`) e obtém o `availableSlotId` exigido pelas Security Rules
      const verifiedSlot = await verifyAvailableSlotFirestore(
        resolvedRoom,
        resData.data,
        resData.inicio,
        resData.fim,
        resData.availableSlotId
      );
      verifiedAvailableSlotId = verifiedSlot.id;

      const { config, exceptions } = useScheduleStore.getState();
      const blockRelease = getReleasedBlocksForRoomOnDate(
        resolvedRoom,
        verifiedSlot.data,
        config,
        exceptions,
        new Date(),
        [verifiedSlot]
      );
      if (!blockRelease.released) {
        throw new Error(
          blockRelease.reason ||
            'Indisponível - Aguardando liberação da coordenação para esta sala nesta data.'
        );
      }

      // 2. Verificação de punição de No-Show (bloqueio exclusivo na data da falta)
      const { punishments, activePunishment } = usePunishmentStore.getState();
      const effectivePunishments = activePunishment
        ? [...punishments, activePunishment]
        : punishments;
      const noShowCheck = checkNoShowSuspensionForDate(
        user,
        effectivePunishments,
        verifiedSlot.data
      );
      if (noShowCheck.blocked) {
        throw new Error(
          noShowCheck.error || formatNoShowTag(verifiedSlot.data)
        );
      }

      // 3. Verificação em tempo real no Firestore da cota de 1 reserva por semana (Segunda a Domingo)
      const quotaCheck = await verifyWeeklyQuotaFirestore(
        user.id,
        verifiedSlot.data
      );
      if (!quotaCheck.allowed) {
        throw new Error(quotaCheck.error);
      }

      resData = {
        ...resData,
        salaId: resolvedRoom.firestoreId,
        salaInstitutionalId: resolvedRoom.id,
        salaNome: resolvedRoom.nome,
        data: verifiedSlot.data,
        inicio: verifiedSlot.inicio,
        fim: verifiedSlot.fim,
      };
    }

    try {
      const now = Date.now();
      const effectiveResData = isAdmin
        ? resData
        : {
            ...resData,
            usuarioId: user.id,
            availableSlotId: verifiedAvailableSlotId,
            status: 'PENDENTE' as const,
          };
      const cleanData = stripUndefinedFields(
        effectiveResData as unknown as Record<string, unknown>
      );

      const slotLockId = buildAvailableSlotId(
        String(effectiveResData.salaId || ''),
        String(effectiveResData.data || ''),
        String(effectiveResData.inicio || ''),
        String(effectiveResData.fim || '')
      );

      const docRef = await withRetry(() =>
        runTransaction(db, async (tx) => {
          const slotLockRef = doc(db, 'slot_locks', slotLockId);
          const slotLockSnap = await tx.get(slotLockRef);

          if (slotLockSnap.exists()) {
            const lockedReservaId = String(slotLockSnap.data()?.reservaId || '');
            if (lockedReservaId) {
              const lockedResSnap = await tx.get(doc(db, 'reservas', lockedReservaId));
              if (lockedResSnap.exists()) {
                const lockedStatus = String(lockedResSnap.data()?.status || '');
                if (lockedStatus === 'PENDENTE' || lockedStatus === 'CONFIRMADA') {
                  const conflictErr = new Error(
                    'Este horário acabou de ser reservado por outro usuário. Selecione outro bloco disponível.'
                  );
                  (conflictErr as Error & { isDirectConflict?: boolean }).isDirectConflict = true;
                  throw conflictErr;
                }
              }
            }
          }

          if (!isAdmin && verifiedAvailableSlotId) {
            const slotRef = doc(db, 'available_slots', verifiedAvailableSlotId);
            const slotSnap = await tx.get(slotRef);
            if (!slotSnap.exists() || slotSnap.data()?.ativo === false) {
              const closedErr = new Error(
                'Este horário não está mais liberado para agendamento. Atualize a grade e tente novamente.'
              );
              (closedErr as Error & { isDirectConflict?: boolean }).isDirectConflict = true;
              throw closedErr;
            }
          }

          const newResRef = doc(collection(db, 'reservas'));
          tx.set(
            newResRef,
            stripUndefinedFields({
              ...cleanData,
              ocultoParaUsuario: false,
              whatsappConfirmacaoEnviada: false,
              whatsappLembreteInicioEnviado: false,
              whatsappAlertaDesocupacaoEnviado: false,
              whatsappNoShowEnviado: false,
              createdAt: now,
              updatedAt: now,
            })
          );

          tx.set(slotLockRef, {
            id: slotLockId,
            salaId: String(effectiveResData.salaId || ''),
            data: String(effectiveResData.data || ''),
            inicio: String(effectiveResData.inicio || ''),
            fim: String(effectiveResData.fim || ''),
            reservaId: newResRef.id,
            usuarioId: String(effectiveResData.usuarioId || user.id),
            createdAt: now,
            updatedAt: now,
          });

          return newResRef;
        })
      );

      if (user) {
        try {
          await useLogStore.getState().addLog({
            acao: 'CRIAR_RESERVA',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'RESERVAS',
            detalhes: `Reserva agendada para "${effectiveResData.salaNome}" em ${effectiveResData.data} (${effectiveResData.inicio} às ${effectiveResData.fim}).`,
          });
        } catch (logErr) {
          console.warn('[Reservas] Falha secundária ao gravar log de criação:', logErr);
        }

        // Dispara mensagem de confirmação via Evolution API (`/message/sendText/{instance}`)
        void (async () => {
          try {
            let targetUser: User | null =
              user.id === effectiveResData.usuarioId ? user : null;

            // Busca o documento atualizado em `users/{uid}` se for outro usuário (ADM) ou se o telefone em memória estiver vazio
            if (!targetUser || (!targetUser.phone && !targetUser.phoneFormatted)) {
              try {
                const ownerSnap = await getDoc(
                  doc(db, 'users', effectiveResData.usuarioId)
                );
                if (ownerSnap.exists()) {
                  targetUser = hydrateUserDocument(ownerSnap.data(), ownerSnap.id);
                }
              } catch (fetchErr) {
                console.error(
                  '[Reservas][WhatsApp Confirmação] Erro ao carregar perfil do usuário para envio:',
                  fetchErr
                );
              }
            }

            if (!targetUser) {
              console.warn(
                '[Reservas][WhatsApp Confirmação] Perfil de destino não encontrado para reserva:',
                docRef.id
              );
              return;
            }

            const dispatchRes = await notifyReservationConfirmed(targetUser, {
              id: docRef.id,
              salaNome: effectiveResData.salaNome,
              salaInstitutionalId: effectiveResData.salaInstitutionalId,
              data: effectiveResData.data,
              inicio: effectiveResData.inicio,
              fim: effectiveResData.fim,
              status: effectiveResData.status,
            });

            if (dispatchRes.delivered) {
              try {
                await updateDoc(doc(db, 'reservas', docRef.id), {
                  whatsappConfirmacaoEnviada: true,
                  updatedAt: Date.now(),
                });
              } catch {
                // Ignora falha secundária de marcação
              }
              if (user.id === targetUser.id) {
                toast.success('Confirmação enviada para o seu WhatsApp.');
              }
            } else if (!dispatchRes.skipped) {
              console.error(
                '[Reservas][WhatsApp Confirmação] Falha no envio da confirmação:',
                dispatchRes
              );
            }
          } catch (waErr) {
            console.warn('[Reservas][WhatsApp Confirmação] Falha assíncrona ignorada:', waErr);
          }
        })();
      }
    } catch (err: any) {
      if (err?.isDirectConflict) {
        throw err;
      }
      handleFirestoreError(err, OperationType.CREATE, 'reservas');
    }
  },

  updateReservation: async (id, data) => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error('Autenticação necessária.');
    }
    if (isUserDeleted(user) || isUserInactive(user)) {
      throw new Error(
        'Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações'
      );
    }
    let target = get().reservations.find((r) => r.id === id);
    if (!target) {
      try {
        const snap = await getDoc(doc(db, 'reservas', id));
        if (snap.exists()) {
          target = { id: snap.id, ...snap.data() } as Reservation;
        }
      } catch {
        // Prossegue caso indisponível
      }
    }

    if (user.role !== 'ADMIN') {
      if (target && target.usuarioId !== user.id) {
        throw new Error('Você só pode gerenciar suas próprias reservas.');
      }
      if (data.status === 'CONFIRMADA') {
        throw new Error('A aprovação direta é exclusiva do perfil ADM. Utilize o check-in via QR Code.');
      }
    }

    if (data.status === 'CONFIRMADA' && target) {
      const endMs = createSafeLocalDateTime(target.data, target.fim).getTime();
      const isPastEndTime = endMs < Date.now();
      if (isPastEndTime) {
        throw new Error(
          'Esta reserva está vencida e não pode ser confirmada retroativamente. Realize a regularização administrativa (Arquivar sem Falta ou Registrar No-Show).'
        );
      }
    }

    try {
      const resRef = doc(db, 'reservas', id);
      const cleanData = stripUndefinedFields(data as unknown as Record<string, unknown>);

      await withRetry(() =>
        updateDoc(
          resRef,
          stripUndefinedFields({
            ...cleanData,
            updatedAt: Date.now(),
          })
        )
      );

      if (data.status) {
        const actionMap: Record<string, string> = {
          CANCELADA: 'CANCELAR_RESERVA',
          CONFIRMADA: 'CONFIRMAR_RESERVA',
          CONCLUIDA: 'CONCLUIR_RESERVA',
          PUNIDA: 'NO_SHOW_RESERVA',
        };
        await useLogStore
          .getState()
          .addLog({
            acao: actionMap[data.status] || 'ATUALIZAR_RESERVA',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'RESERVAS',
            detalhes: `Reserva ${
              target?.salaNome
                ? `em "${target.salaNome}" (${target.data} ${target.inicio}-${target.fim})`
                : id
            } alterada para ${data.status}.`,
          })
          .catch(() => {});

        // Dispara notificações automáticas via Evolution API (cancelamento ou aprovação ADM)
        if ((data.status === 'CANCELADA' || data.status === 'CONFIRMADA') && target) {
          const snapshotTarget = target;
          void (async () => {
            try {
              let ownerProfile: User | null =
                user.id === snapshotTarget.usuarioId ? user : null;

              if (!ownerProfile || (!ownerProfile.phone && !ownerProfile.phoneFormatted)) {
                try {
                  const ownerSnap = await getDoc(doc(db, 'users', snapshotTarget.usuarioId));
                  if (ownerSnap.exists()) {
                    ownerProfile = hydrateUserDocument(ownerSnap.data(), ownerSnap.id);
                  }
                } catch (fetchErr) {
                  console.error(
                    '[Reservas][WhatsApp Atualização] Erro ao carregar perfil do usuário:',
                    fetchErr
                  );
                }
              }

              if (!ownerProfile) return;

              if (data.status === 'CANCELADA') {
                if ((data as Record<string, unknown>).skipWhatsAppNotification) {
                  return;
                }
                const cancelledBy: 'USUARIO' | 'ADMIN' =
                  user.role === 'ADMIN' && user.id !== snapshotTarget.usuarioId
                    ? 'ADMIN'
                    : 'USUARIO';

                const cancelRes = await notifyReservationCancelled(
                  ownerProfile,
                  snapshotTarget,
                  cancelledBy,
                  data.observacoes
                );
                if (!cancelRes.delivered && !cancelRes.skipped) {
                  console.error(
                    '[Reservas][WhatsApp Cancelamento] Falha no envio do cancelamento:',
                    cancelRes
                  );
                }
              } else if (
                data.status === 'CONFIRMADA' &&
                snapshotTarget.status === 'PENDENTE' &&
                !snapshotTarget.whatsappConfirmacaoEnviada
              ) {
                const confirmRes = await notifyReservationConfirmed(ownerProfile, {
                  ...snapshotTarget,
                  status: 'CONFIRMADA',
                });
                if (confirmRes.delivered) {
                  await updateDoc(doc(db, 'reservas', id), {
                    whatsappConfirmacaoEnviada: true,
                    updatedAt: Date.now(),
                  }).catch(() => {});
                } else if (!confirmRes.skipped) {
                  console.error(
                    '[Reservas][WhatsApp Aprovação ADM] Falha no envio da confirmação:',
                    confirmRes
                  );
                }
              }
            } catch (waErr) {
              console.warn('[Reservas][WhatsApp Atualização] Falha assíncrona ignorada:', waErr);
            }
          })();
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  checkIn: async (id) => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error('Autenticação necessária.');
    }
    if (isUserDeleted(user) || isUserInactive(user)) {
      throw new Error(
        'Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações'
      );
    }
    const target = get().reservations.find((r) => r.id === id);
    if (user.role !== 'ADMIN' && target && target.usuarioId !== user.id) {
      throw new Error('Você só pode realizar check-in na sua própria reserva.');
    }

    try {
      const resRef = doc(db, 'reservas', id);
      await withRetry(() =>
        updateDoc(resRef, {
          status: 'CONFIRMADA',
          checkInRealizado: true,
          updatedAt: Date.now(),
        })
      );

      await useLogStore
        .getState()
        .addLog({
          acao: 'CHECKIN_REALIZADO',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Check-in presencial confirmado em "${target?.salaNome || id}".`,
        })
        .catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  hideForUser: async (id) => {
    const { user } = useAuthStore.getState();
    const target = get().reservations.find((r) => r.id === id);
    if (
      !user ||
      isUserDeleted(user) ||
      isUserInactive(user) ||
      (user.role !== 'ADMIN' && target && target.usuarioId !== user.id)
    ) {
      throw new Error('Permissão insuficiente.');
    }

    try {
      const resRef = doc(db, 'reservas', id);
      await updateDoc(resRef, {
        ocultoParaUsuario: true,
        updatedAt: Date.now(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  deleteReservation: async (id) => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      throw new Error('Apenas administradores podem excluir registros de reserva.');
    }

    try {
      const target = get().reservations.find((r) => r.id === id);
      const resRef = doc(db, 'reservas', id);
      await deleteDoc(resRef);

      await useLogStore
        .getState()
        .addLog({
          acao: 'EXCLUIR_RESERVA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Registro de reserva ${
            target?.salaNome ? `"${target.salaNome}" (${target.data})` : id
          } removido pelo ADM.`,
        })
        .catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `reservas/${id}`);
    }
  },

  reconcileServerReservation: (id, serverData) => {
    set((state) => {
      const current = Array.isArray(state.reservations) ? state.reservations : [];
      if (!serverData) {
        return { reservations: current.filter((r) => r.id !== id) };
      }
      const hydrated: Reservation = {
        ...(serverData as unknown as Reservation),
        id,
        salaId: String(serverData.salaId || ''),
        salaNome: String(serverData.salaNome || ''),
        usuarioId: String(serverData.usuarioId || ''),
        data: String(serverData.data || ''),
        inicio: String(serverData.inicio || ''),
        fim: String(serverData.fim || ''),
        status: (serverData.status as Reservation['status']) || 'PENDENTE',
      };
      const idx = current.findIndex((r) => r.id === id);
      if (idx === -1) {
        return { reservations: [hydrated, ...current] };
      }
      const next = [...current];
      next[idx] = hydrated;
      return { reservations: next };
    });
  },

  processMissedCheckIns: async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const connectivity = useConnectivityStore.getState();
    if (
      !connectivity.isReachable ||
      connectivity.status !== 'CONECTADO' ||
      connectivity.pendingCheckInsCount > 0
    ) {
      return;
    }

    const rawReservations = get().reservations;
    const reservations = Array.isArray(rawReservations) ? rawReservations : [];
    const now = connectivity.getOfficialNow();
    const { user: currentUser } = useAuthStore.getState();
    if (!currentUser || isUserDeleted(currentUser) || isUserInactive(currentUser)) return;

    // 1. Conclui automaticamente reservas confirmadas (com check-in realizado) cujo horário de término já passou
    const completedCandidates = reservations.filter((r) => {
      if (!r || r.status !== 'CONFIRMADA') return false;
      if (currentUser.role !== 'ADMIN' && r.usuarioId !== currentUser.id) return false;
      const endMs = createSafeLocalDateTime(r.data, r.fim).getTime();
      return endMs < now;
    });

    for (const doneRes of completedCandidates) {
      try {
        await withRetry(() =>
          updateDoc(doc(db, 'reservas', doneRes.id), {
            status: 'CONCLUIDA',
            updatedAt: now,
          })
        );
      } catch {
        // Silencioso caso outro cliente já tenha atualizado
      }
    }

    // 2. Processa No-Show de forma segura via backend serverless (`/api/reservations/expire`)
    const nowMs = Date.now();
    if (isMissedCheckInsInProgress || nowMs - lastMissedCheckInsRun < MISSED_CHECKINS_THROTTLE_MS) {
      return;
    }

    const missed = reservations.filter(
      (r) =>
        r &&
        r.status === 'PENDENTE' &&
        r.checkInExpiracao &&
        r.checkInExpiracao < now &&
        !r.checkInRealizado
    );

    // Se não há reservas vencidas identificadas em memória e o usuário não é admin, evita chamada desnecessária
    if (missed.length === 0 && currentUser.role !== 'ADMIN') return;

    isMissedCheckInsInProgress = true;
    lastMissedCheckInsRun = nowMs;

    try {
      const headers = await buildAuthenticatedJsonHeaders();
      const response = await fetch('/api/reservations/expire', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          processedCount?: number;
          message?: string;
          results?: Array<{ salaNome?: string; data?: string; status?: string }>;
        };

        if (data.processedCount && data.processedCount > 0) {
          const firstDetail = data.results?.find((d) => d.status === 'PUNIDA');
          if (firstDetail) {
            toast.info(
              `Reserva em ${firstDetail.salaNome || 'ambiente'} cancelada por ausência (No-Show).`
            );
          }
        }
      }
    } catch (err) {
      console.warn('[Reservas] Reconciliação serverless de No-Show indisponível no momento:', err);
    } finally {
      isMissedCheckInsInProgress = false;
    }
  },

  archiveReservationWithoutPenalty: async (id: string, justificativa?: string) => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      throw new Error('Apenas administradores podem regularizar reservas.');
    }

    const headers = await buildAuthenticatedJsonHeaders();
    const response = await fetch('/api/reservations/archive', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reservationId: id,
        justificativa:
          justificativa?.trim() ||
          'Reserva regularizada administrativamente sem aplicação de falta.',
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      message?: string;
      code?: string;
    };

    if (!response.ok) {
      throw new Error(data.message || 'Falha ao arquivar reserva.');
    }

    toast.success('Reserva arquivada sem aplicação de falta com sucesso.');
  },

  registerNoShowManual: async (id: string) => {
    const { user } = useAuthStore.getState();
    if (!user || user.role !== 'ADMIN') {
      throw new Error('Apenas administradores podem registrar No-Show manualmente.');
    }

    const headers = await buildAuthenticatedJsonHeaders();
    const response = await fetch('/api/reservations/expire', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reservationId: id,
        allowPastDateReview: true,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      message?: string;
      code?: string;
    };

    if (!response.ok) {
      throw new Error(data.message || 'Falha ao registrar No-Show.');
    }

    if (data.code === 'ALREADY_PROCESSED' || data.code === 'ALREADY_CONFIRMED') {
      toast.info(data.message || 'A reserva já havia sido processada anteriormente.');
    } else {
      toast.success('No-Show registrado com sucesso. Usuário notificado e ambiente liberado.');
    }
  },
}));
