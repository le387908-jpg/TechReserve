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
  verifyWeeklyQuotaFirestore,
} from '../services/reservationService';
import { createSafeLocalDateTime, formatDataBR } from '../utils/dateUtils';
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
    const isAdmin = user?.role === 'ADMIN';

    // Validações estritas de regras de negócio para usuários comuns antes de gravar no Firestore
    if (user && !isAdmin) {
      const room = useRoomStore
        .getState()
        .rooms.find(
          (r) =>
            r.firestoreId === resData.salaId ||
            r.id === resData.salaInstitutionalId
        );

      // 1. Pré-requisito de liberação da sala e blocos ativos pelo ADM
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
            'Não há blocos de horários liberados pelo administrador para esta sala nesta data.'
        );
      }

      const matchesBlock = blockRelease.blocks.some(
        (b) => b.ativo && b.inicio === resData.inicio && b.fim === resData.fim
      );
      if (!matchesBlock) {
        throw new Error(
          'Selecione exclusivamente um bloco de horário liberado pelo administrador.'
        );
      }

      // 2. Verificação de punição de No-Show (bloqueio exclusivo na data da falta)
      const { punishments } = usePunishmentStore.getState();
      const noShowCheck = checkNoShowSuspensionForDate(
        user,
        punishments,
        resData.data
      );
      if (noShowCheck.blocked) {
        throw new Error(
          noShowCheck.error || formatNoShowTag(resData.data)
        );
      }

      // 3. Verificação em tempo real no Firestore da cota de 1 reserva por semana (Segunda a Domingo)
      const quotaCheck = await verifyWeeklyQuotaFirestore(
        resData.usuarioId,
        resData.data
      );
      if (!quotaCheck.allowed) {
        throw new Error(quotaCheck.error);
      }
    }

    try {
      const now = Date.now();
      const cleanData: Record<string, unknown> = {};
      Object.entries(resData).forEach(([key, val]) => {
        if (val !== undefined) cleanData[key] = val;
      });

      const docRef = await withRetry(() =>
        addDoc(collection(db, 'reservas'), {
          ...cleanData,
          ocultoParaUsuario: false,
          whatsappConfirmacaoEnviada: true,
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
          detalhes: `Reserva agendada para "${resData.salaNome}" em ${resData.data} (${resData.inicio} às ${resData.fim}).`,
        });

        // Dispara mensagem de confirmação via API do WhatsApp (caso telefone válido e opt-in ativo)
        let targetUser: User | null = user.id === resData.usuarioId ? user : null;
        if (!targetUser) {
          try {
            const ownerSnap = await getDoc(doc(db, 'users', resData.usuarioId));
            if (ownerSnap.exists()) {
              targetUser = { id: ownerSnap.id, ...ownerSnap.data() } as User;
            }
          } catch {
            // Prossegue silenciosamente
          }
        }

        if (targetUser) {
          void notifyReservationConfirmed(targetUser, {
            id: docRef.id,
            salaNome: resData.salaNome,
            salaInstitutionalId: resData.salaInstitutionalId,
            data: resData.data,
            inicio: resData.inicio,
            fim: resData.fim,
            status: resData.status,
          });
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'reservas');
    }
  },

  updateReservation: async (id, data) => {
    try {
      const target = get().reservations.find((r) => r.id === id);
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

      const { user } = useAuthStore.getState();
      if (user && data.status) {
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

        // Dispara notificação de cancelamento via API do WhatsApp (pelo próprio usuário ou pelo ADM)
        if (data.status === 'CANCELADA' && target) {
          const cancelledBy: 'USUARIO' | 'ADMIN' =
            user.role === 'ADMIN' && user.id !== target.usuarioId ? 'ADMIN' : 'USUARIO';

          let ownerProfile: User | null = user.id === target.usuarioId ? user : null;
          if (!ownerProfile && user.role === 'ADMIN') {
            try {
              const ownerSnap = await getDoc(doc(db, 'users', target.usuarioId));
              if (ownerSnap.exists()) {
                ownerProfile = { id: ownerSnap.id, ...ownerSnap.data() } as User;
              }
            } catch {
              // Ignora caso indisponível
            }
          }

          if (ownerProfile) {
            void notifyReservationCancelled(ownerProfile, target, cancelledBy, data.observacoes);
          }
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  checkIn: async (id) => {
    try {
      const target = get().reservations.find((r) => r.id === id);
      const resRef = doc(db, 'reservas', id);
      await withRetry(() =>
        updateDoc(resRef, {
          status: 'CONFIRMADA',
          checkInRealizado: true,
          updatedAt: Date.now(),
        })
      );

      const { user } = useAuthStore.getState();
      if (user) {
        await useLogStore.getState().addLog({
          acao: 'CHECKIN_REALIZADO',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Check-in presencial confirmado em "${target?.salaNome || id}".`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reservas/${id}`);
    }
  },

  hideForUser: async (id) => {
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
    try {
      const target = get().reservations.find((r) => r.id === id);
      const resRef = doc(db, 'reservas', id);
      await deleteDoc(resRef);

      const { user } = useAuthStore.getState();
      if (user) {
        await useLogStore.getState().addLog({
          acao: 'EXCLUIR_RESERVA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'RESERVAS',
          detalhes: `Registro de reserva ${
            target?.salaNome ? `"${target.salaNome}" (${target.data})` : id
          } removido pelo ADM.`,
        });
      }
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
        let targetUserPhone = currentUser.phone || '';
        let targetWhatsappEnabled = currentUser.whatsappNotificationsEnabled !== false;

        const userSnap = await withRetry(() => getDoc(punicaoRef), { silent: true });
        if (userSnap.exists()) {
          const uDoc = userSnap.data();
          if (uDoc.role === 'ADMIN') {
            continue;
          }
          targetUserName = uDoc.nome || uDoc.name || targetUserName;
          targetUserEmail = uDoc.email || targetUserEmail;
          targetUserPhone = uDoc.phone || targetUserPhone;
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

        await withRetry(() =>
          updateDoc(doc(db, 'reservas', res.id), {
            status: 'PUNIDA',
            updatedAt: now,
            blockedDate,
            punicaoMotivo,
            observacoes: `Reserva cancelada automaticamente por No-Show. ${formatNoShowTag(
              blockedDate
            )} (cota semanal liberada para outras datas).`,
            whatsappNoShowEnviado: true,
          })
        );

        // Dispara aviso de No-Show via API do WhatsApp caso o usuário tenha telefone e opt-in ativo
        if (!res.whatsappNoShowEnviado) {
          void notifyNoShowAutoCancelled(
            {
              id: res.usuarioId,
              nome: targetUserName,
              phone: targetUserPhone,
              whatsappNotificationsEnabled: targetWhatsappEnabled,
            },
            res
          );
        }

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
