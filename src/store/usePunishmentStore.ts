/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  orderBy,
  doc,
  updateDoc,
  getDocs,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { PunishmentCategory, PunishmentRecord, User } from '../types';
import { useAuthStore } from './useAuthStore';
import { useLogStore } from './useLogStore';
import { formatDataBR, getTodayLocalISO, normalizeDateToISO } from '../utils/dateUtils';

export type Punishment = PunishmentRecord;

interface PunishmentState {
  punishments: PunishmentRecord[];
  loading: boolean;
  error: string | null;
  activePunishment: PunishmentRecord | null;

  fetchPunishments: () => () => void;
  fetchUserPunishments: (userId: string) => () => void;
  applyPunishment: (punishment: Omit<PunishmentRecord, 'id' | 'ativa'>) => Promise<void>;
  applyManualPunishment: (params: {
    targetUser: User;
    blockedDate: string; // Data única bloqueada (YYYY-MM-DD) — sem bloqueio por múltiplos dias
    categoriaMotivo: PunishmentCategory;
    motivo: string;
    bloquearConta?: boolean;
  }) => Promise<void>;
  revokeUserPunishment: (targetUser: User, motivoRevogacao?: string) => Promise<void>;
  deactivatePunishment: (id: string) => Promise<void>;
}

export const usePunishmentStore = create<PunishmentState>((set) => ({
  punishments: [],
  loading: false,
  error: null,
  activePunishment: null,

  fetchPunishments: () => {
    set({ loading: true });
    const q = query(collection(db, 'punishments'), orderBy('dataInicio', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const punishments = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const resolvedBlockedDate =
            data.blockedDate ||
            (data.dataInicio ? normalizeDateToISO(data.dataInicio) : getTodayLocalISO());
          return {
            id: docSnap.id,
            ...data,
            blockedDate: resolvedBlockedDate,
          } as PunishmentRecord;
        });
        set({ punishments, loading: false });
      },
      (error) => {
        console.warn('Punishments list warning:', error);
        set({ error: error.message, loading: false });
      }
    );

    return unsubscribe;
  },

  fetchUserPunishments: (userId: string) => {
    set({ loading: true });
    const q = query(collection(db, 'punishments'), where('usuarioId', '==', userId));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const todayISO = getTodayLocalISO();
        const punishments = snapshot.docs
          .map((docSnap) => {
            const data = docSnap.data();
            return {
              id: docSnap.id,
              ...data,
              blockedDate:
                data.blockedDate ||
                (data.dataInicio ? normalizeDateToISO(data.dataInicio) : todayISO),
            } as PunishmentRecord;
          })
          .filter((p) => p.ativa)
          .sort((a, b) => (b.dataInicio || 0) - (a.dataInicio || 0));

        const active = punishments.find((p) => p.blockedDate >= todayISO);
        set({ activePunishment: active || null, loading: false });
      },
      (error) => {
        set({ error: error.message, loading: false });
      }
    );

    return unsubscribe;
  },

  applyPunishment: async (punishmentData) => {
    try {
      await withRetry(() =>
        addDoc(collection(db, 'punishments'), {
          ...punishmentData,
          blockedDate: normalizeDateToISO(punishmentData.blockedDate) || getTodayLocalISO(),
          ativa: true,
        })
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'punishments');
      throw err;
    }
  },

  applyManualPunishment: async ({
    targetUser,
    blockedDate,
    categoriaMotivo,
    motivo,
    bloquearConta = false,
  }) => {
    const admin = useAuthStore.getState().user;
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Operação restrita a administradores.');
    }

    const cleanReason = motivo.trim().slice(0, 500);
    const normalizedBlockedDate = normalizeDateToISO(blockedDate) || getTodayLocalISO();
    const now = Date.now();

    try {
      // 1. Atualiza o perfil do usuário com a data exata do bloqueio (sem suspensão por múltiplos dias)
      await withRetry(() =>
        updateDoc(doc(db, 'users', targetUser.id), {
          blockedDate: normalizedBlockedDate,
          punidoAte: null,
          motivoPunicao: cleanReason,
          bloqueado: Boolean(bloquearConta),
          updatedAt: now,
        })
      );

      // 2. Registra no histórico disciplinar auditável (`punishments`)
      await withRetry(() =>
        addDoc(collection(db, 'punishments'), {
          usuarioId: targetUser.id,
          usuarioNome: targetUser.nome,
          usuarioEmail: targetUser.email || '',
          usuarioRa: targetUser.ra || '',
          categoriaMotivo,
          motivo: cleanReason,
          blockedDate: normalizedBlockedDate,
          dataInicio: now,
          tipo: 'MANUAL',
          aplicadoPorId: admin.id,
          aplicadoPorNome: admin.nome,
          ativa: true,
        })
      );

      // 3. Registra no log de governança (`logs`)
      await useLogStore.getState().addLog({
        acao: bloquearConta ? 'BLOQUEIO_CONTA_USUARIO' : 'PUNICAO_DIA_UNICO_MANUAL',
        usuarioId: targetUser.id,
        usuarioNome: admin.nome,
        entidade: 'USERS',
        detalhes: `Restrição pontual aplicada a ${targetUser.nome} (${
          targetUser.email
        }) exclusivamente para ${formatDataBR(normalizedBlockedDate)}${
          bloquearConta ? ' com bloqueio de conta' : ''
        }. Motivo: ${cleanReason}`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${targetUser.id}`);
    }
  },

  revokeUserPunishment: async (targetUser, motivoRevogacao) => {
    const admin = useAuthStore.getState().user;
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Operação restrita a administradores.');
    }

    const now = Date.now();

    try {
      // 1. Limpa a data de bloqueio no perfil do usuário
      await withRetry(() =>
        updateDoc(doc(db, 'users', targetUser.id), {
          blockedDate: '',
          punidoAte: null,
          motivoPunicao: '',
          bloqueado: false,
          updatedAt: now,
        })
      );

      // 2. Marca punições ativas desse usuário na coleção `punishments` como revogadas
      try {
        const activeQuery = query(
          collection(db, 'punishments'),
          where('usuarioId', '==', targetUser.id)
        );
        const activeSnap = await getDocs(activeQuery);
        for (const pDoc of activeSnap.docs) {
          if (pDoc.data()?.ativa) {
            await updateDoc(doc(db, 'punishments', pDoc.id), {
              ativa: false,
              revogadaEm: now,
              revogadaPorNome: admin.nome,
            });
          }
        }
      } catch (subErr) {
        console.warn('Could not update punishment history docs:', subErr);
      }

      // 3. Registra auditoria
      await useLogStore.getState().addLog({
        acao: 'REVOGACAO_RESTRICAO_USUARIO',
        usuarioId: targetUser.id,
        usuarioNome: admin.nome,
        entidade: 'USERS',
        detalhes: `Restrição de ${targetUser.nome} revogada pelo administrador.${
          motivoRevogacao ? ` Observação: ${motivoRevogacao}` : ''
        }`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${targetUser.id}`);
    }
  },

  deactivatePunishment: async (id) => {
    const admin = useAuthStore.getState().user;
    try {
      const ref = doc(db, 'punishments', id);
      await withRetry(() =>
        updateDoc(ref, {
          ativa: false,
          revogadaEm: Date.now(),
          revogadaPorNome: admin?.nome || 'Administrador',
        })
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `punishments/${id}`);
      throw err;
    }
  },
}));
