/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  getDoc,
  orderBy,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { Reservation, User } from '../types';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
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
import { createSafeLocalDateTime, formatDataBR } from '../utils/dateUtils';
import { hydrateUserDocument } from '../services/authService';
import {
  notifyNoShowAutoCancelled,
  notifyReservationCancelled,
  notifyReservationConfirmed,
} from '../services/whatsappService';
import { toast } from 'sonner';

interface ReservationState {
  reservations: Reservation[];
  loading: boolean;
  error: string | null;

  fetchReservations: () => () => void;
  addReservation: (reservation: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateReservation: (id: string, data: Partial<Reservation>) => Promise<void>;
  checkIn: (id: string) => Promise<void>;
  hideForUser: (id: string) => Promise<void>;
  deleteReservation: (id: string) => Promise<void>;
  processMissedCheckIns: () => Promise<void>;

  scanningResId: string | null;
  setScanningResId: (id: string | null) => void;
}

export const useReservationStore = create<ReservationState>((set, get) => ({
  reservations: [],
  loading: false,
  error: null,
  scanningResId: null,

  setScanningResId: (id) => set({ scanningResId: id }),

  fetchReservations: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      return () => {};
    }

    set({ loading: true });
    const q = query(collection(db, 'reservas'), orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const reservations = snapshot.docs.map(
          (docSnap) => ({ id: docSnap.id, ...docSnap.data() } as Reservation)
        );
        set({ reservations, loading: false });
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, 'reservas');
        } catch {
          // Erro já registrado estruturadamente
        }
        set({ loading: false });
      }
    );

    return unsubscribe;
  },

  addReservation: async (resData) => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error('Autenticação necessária para realizar agendamentos.');
    }
    const isAdmin = user.role === 'ADMIN';
    let verifiedAvailableSlotId: string | undefined = resData.availableSlotId;

    // Validações estritas de regras de negócio para usuários comuns antes de gravar no Firestore
    if (!isAdmin) {
      const room = useRoomStore
        .getState()
        .rooms.find(
          (r) =>
            r.firestoreId === resData.salaId ||
            r.id === resData.salaInstitutionalId
        );

      if (!room) {
        throw new Error('Sala não encontrada no inventário institucional.');
      }

      // 1. Pré-requisito de liberação da sala e registro explícito em `available_slots` pelo ADM
      const roomRelease = isSpaceReleasedByAdmin(room);
      if (!roomRelease.released) {
        throw new Error(
          roomRelease.reason ||
            'Esta sala não está liberada pelo administrador para agendamentos.'
        );
      }

      const { config, exceptions } = useScheduleStore.getState();
      const blockRelease = getReleasedBlocksForRoomOnDate(
        room,
        resData.data,
        config,
        exceptions
      );
      if (!blockRelease.released) {
        throw new Error(
          blockRelease.reason ||
            'Indisponível - Aguardando liberação da coordenação para esta sala nesta data.'
        );
      }

      const matchedLocalSlot = blockRelease.blocks.find(
        (b) => b.ativo && b.inicio === resData.inicio && b.fim === resData.fim
      );
      if (!matchedLocalSlot) {
        throw new Error(
          'Indisponível - Aguardando liberação da coordenação. Selecione apenas um horário com status liberado.'
        );
      }

      // Confirma diretamente no Firestore (`available_slots`) e obtém o `availableSlotId` exigido pelas Security Rules
      const verifiedSlot = await verifyAvailableSlotFirestore(
        room,
        resData.data,
        resData.inicio,
        resData.fim
      );
      verifiedAvailableSlotId = verifiedSlot.id;

      // 2. Verificação de punição de No-Show (bloqueio exclusivo na data da falta)
      const { punishments, activePunishment } = usePunishmentStore.getState();
      const effectivePunishments = activePunishment
        ? [...punishments, activePunishment]
        : punishments;
      const noShowCheck = checkNoShowSuspensionForDate(
        user,
        effectivePunishments,
        resData.data
      );
      if (noShowCheck.blocked) {
        throw new Error(
          noShowCheck.error || formatNoShowTag(resData.data)
        );
      }

      // 3. Verificação em tempo real no Firestore da cota de 1 reserva por semana (Segunda a Domingo)
      const quotaCheck = await verifyWeeklyQuotaFirestore(
        user.id,
        resData.data
      );
      if (!quotaCheck.allowed) {
        throw new Error(quotaCheck.error);
      }
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
      const cleanData: Record<string, unknown> = {};
      Object.entries(effectiveResData).forEach(([key, val]) => {
        if (val !== undefined) cleanData[key] = val;
      });

      const docRef = await withRetry(() =>
        addDoc(collection(db, 'reservas'), {
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

      if (user) {
        await useLogStore.getState().addLog({
          acao: 'CRIAR_RESERVA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Reserva agendada para "${effectiveResData.salaNome}" em ${effectiveResData.data} (${effectiveResData.inicio} às ${effectiveResData.fim}).`,
        });

        // Dispara mensagem de confirmação via Evolution API (`/message/sendText/{instance}`)
        void (async () => {
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

          console.log('[Reservas][WhatsApp Confirmação] Iniciando disparo para reserva criada:', {
            reservaId: docRef.id,
            usuarioId: targetUser.id,
            sala: effectiveResData.salaNome,
            data: effectiveResData.data,
            inicio: effectiveResData.inicio,
          });

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
        })();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'reservas');
    }
  },

  updateReservation: async (id, data) => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error('Autenticação necessária.');
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

    try {
      const resRef = doc(db, 'reservas', id);
      const cleanData: Record<string, unknown> = {};
      Object.entries(data).forEach(([key, val]) => {
        if (val !== undefined) cleanData[key] = val;
      });

      await withRetry(() =>
        updateDoc(resRef, {
          ...cleanData,
          updatedAt: Date.now(),
        })
      );

      if (data.status) {
        const actionMap: Record<string, string> = {
          CANCELADA: 'CANCELAR_RESERVA',
          CONFIRMADA: 'CONFIRMAR_RESERVA',
          CONCLUIDA: 'CONCLUIR_RESERVA',
          PUNIDA: 'NO_SHOW_RESERVA',
        };
        await useLogStore.getState().addLog({
          acao: actionMap[data.status] || 'ATUALIZAR_RESERVA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Reserva ${
            target?.salaNome
              ? `em "${target.salaNome}" (${target.data} ${target.inicio}-${target.fim})`
              : id
          } alterada para ${data.status}.`,
        });

        // Dispara notificações automáticas via Evolution API (cancelamento ou aprovação ADM)
        if ((data.status === 'CANCELADA' || data.status === 'CONFIRMADA') && target) {
          const snapshotTarget = target;
          void (async () => {
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
              const cancelledBy: 'USUARIO' | 'ADMIN' =
                user.role === 'ADMIN' && user.id !== snapshotTarget.usuarioId
                  ? 'ADMIN'
                  : 'USUARIO';

              console.log('[Reservas][WhatsApp Cancelamento] Disparando aviso de cancelamento:', {
                reservaId: snapshotTarget.id,
                usuarioId: ownerProfile.id,
                cancelledBy,
              });

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
              console.log('[Reservas][WhatsApp Aprovação ADM] Disparando confirmação:', {
                reservaId: snapshotTarget.id,
                usuarioId: ownerProfile.id,
              });

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

      await useLogStore.getState().addLog({
        acao: 'CHECKIN_REALIZADO',
        usuarioId: user.id,
        usuarioNome: user.nome,
        entidade: 'RESERVAS',
        detalhes: `Check-in presencial confirmado em "${target?.salaNome || id}".`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  hideForUser: async (id) => {
    const { user } = useAuthStore.getState();
    const target = get().reservations.find((r) => r.id === id);
    if (!user || (user.role !== 'ADMIN' && target && target.usuarioId !== user.id)) {
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

      await useLogStore.getState().addLog({
        acao: 'EXCLUIR_RESERVA',
        usuarioId: user.id,
        usuarioNome: user.nome,
        entidade: 'RESERVAS',
        detalhes: `Registro de reserva ${
          target?.salaNome ? `"${target.salaNome}" (${target.data})` : id
        } removido pelo ADM.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `reservas/${id}`);
    }
  },

  processMissedCheckIns: async () => {
    const { reservations } = get();
    const now = Date.now();
    const { user: currentUser } = useAuthStore.getState();
    if (!currentUser) return;

    // 1. Conclui automaticamente reservas confirmadas (com check-in realizado) cujo horário de término já passou
    const completedCandidates = reservations.filter((r) => {
      if (r.status !== 'CONFIRMADA') return false;
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

    // 2. Processa No-Show (ausência de check-in em 5 minutos) aplicando punição EXCLUSIVA para o dia da falta
    const missed = reservations.filter(
      (r) =>
        r.status === 'PENDENTE' &&
        r.checkInExpiracao &&
        r.checkInExpiracao < now &&
        !r.checkInRealizado
    );

    if (missed.length === 0) return;

    for (const res of missed) {
      try {
        if (currentUser.role !== 'ADMIN' && res.usuarioId !== currentUser.id) {
          continue;
        }

        if (res.observacoes === 'Reserva ADM' || res.observacoes === 'Reserva Administrativa') {
          continue;
        }

        const punicaoRef = doc(db, 'users', res.usuarioId);
        let targetUserName = currentUser.nome;
        let targetUserEmail = currentUser.email;
        let targetUserPhone = currentUser.phone || currentUser.phoneFormatted || '';
        let targetWhatsappEnabled = currentUser.whatsappNotificationsEnabled !== false;

        const userSnap = await withRetry(() => getDoc(punicaoRef), { silent: true });
        if (userSnap.exists()) {
          const uDoc = hydrateUserDocument(userSnap.data(), userSnap.id);
          if (uDoc.role === 'ADMIN') {
            continue;
          }
          targetUserName = uDoc.nome || targetUserName;
          targetUserEmail = uDoc.email || targetUserEmail;
          targetUserPhone = uDoc.phone || uDoc.phoneFormatted || targetUserPhone;
          targetWhatsappEnabled = uDoc.whatsappNotificationsEnabled !== false;
        }

        const blockedDate = res.data; // Bloqueio estritamente no dia exato da falta (YYYY-MM-DD)
        const punicaoMotivo = `${formatNoShowTag(
          blockedDate
        )} (ausência de check-in presencial via QR Code em 5 minutos)`;

        await withRetry(() =>
          updateDoc(punicaoRef, {
            blockedDate,
            punidoAte: null,
            motivoPunicao: punicaoMotivo,
            updatedAt: now,
          })
        );

        // Dispara aviso de No-Show via Evolution API (`/message/sendText/{instance}`) antes de concluir a marcação
        let noShowDelivered = Boolean(res.whatsappNoShowEnviado);
        if (!res.whatsappNoShowEnviado) {
          console.log('[Reservas][WhatsApp No-Show] Disparando alerta de No-Show automático:', {
            reservaId: res.id,
            usuarioId: res.usuarioId,
            sala: res.salaNome,
            data: res.data,
          });

          const noShowResult = await notifyNoShowAutoCancelled(
            {
              id: res.usuarioId,
              nome: targetUserName,
              phone: targetUserPhone,
              whatsappNotificationsEnabled: targetWhatsappEnabled,
            },
            res
          );
          noShowDelivered = Boolean(noShowResult.delivered);
          if (!noShowResult.delivered && !noShowResult.skipped) {
            console.error(
              '[Reservas][WhatsApp No-Show] Falha ao enviar alerta de No-Show:',
              noShowResult
            );
          }
        }

        await withRetry(() =>
          updateDoc(doc(db, 'reservas', res.id), {
            status: 'PUNIDA',
            updatedAt: now,
            blockedDate,
            punicaoMotivo,
            observacoes: `Reserva cancelada automaticamente por No-Show. ${formatNoShowTag(
              blockedDate
            )} (cota semanal liberada para outras datas).`,
            whatsappNoShowEnviado: noShowDelivered,
          })
        );

        try {
          await addDoc(collection(db, 'punishments'), {
            usuarioId: res.usuarioId,
            usuarioNome: targetUserName || 'Usuário',
            usuarioEmail: targetUserEmail || '',
            reservaId: res.id,
            categoriaMotivo: 'NO_SHOW',
            motivo: punicaoMotivo,
            blockedDate,
            dataInicio: now,
            tipo: 'AUTOMATICA',
            aplicadoPorId: 'SISTEMA',
            aplicadoPorNome: 'Sistema (No-Show Automático)',
            ativa: true,
          });
        } catch {
          // Prossegue mesmo se o histórico secundário falhar
        }

        await useLogStore.getState().addLog({
          acao: 'NO_SHOW_AUTOMATICO',
          usuarioId: res.usuarioId,
          usuarioNome: targetUserName || 'SISTEMA',
          entidade: 'RESERVAS',
          detalhes: `No-Show em "${res.salaNome}" (${formatDataBR(
            blockedDate
          )} às ${res.inicio}). ${formatNoShowTag(
            blockedDate
          )}. Cota semanal liberada para outras datas.`,
        });

        toast.error(
          `Reserva em ${res.salaNome} cancelada por No-Show. ${formatNoShowTag(blockedDate)}.`
        );
      } catch (err: any) {
        if (currentUser && res.usuarioId === currentUser.id) {
          const isPermissionError =
            err.message?.includes('permission') || err.code === 'permission-denied';
          toast.error(
            isPermissionError
              ? 'Erro de permissão no cancelamento automático.'
              : 'Erro ao processar cancelamento automático. Verifique sua conexão.'
          );
        }
      }
    }
  },
}));
