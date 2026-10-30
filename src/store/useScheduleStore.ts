/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { DayOfWeek, ScheduleConfig, ScheduleException, TimeBlock } from '../types';
import {
  OperationType,
  handleFirestoreError,
  stripUndefinedFields,
  withRetry,
} from '../services/firebase/utils';
import { useLogStore } from './useLogStore';
import { useAuthStore } from './useAuthStore';

/**
 * Gera blocos sequenciais de horário (ex: aulas padrão de 50 minutos) dentro de uma janela.
 */
export function buildTimeBlocks(
  startHHMM: string,
  endHHMM: string,
  durationMinutes = 50,
  breakMinutes = 0
): TimeBlock[] {
  const [sh, sm] = String(startHHMM || '17:00').split(':').map(Number);
  const [eh, em] = String(endHHMM || '22:00').split(':').map(Number);
  const startTotal = (sh || 0) * 60 + (sm || 0);
  const endTotal = (eh || 0) * 60 + (em || 0);

  if (durationMinutes < 15 || endTotal <= startTotal) return [];

  const blocks: TimeBlock[] = [];
  let cursor = startTotal;
  let index = 1;

  while (cursor + durationMinutes <= endTotal && blocks.length < 24) {
    const blockEnd = cursor + durationMinutes;
    const fmt = (mins: number) =>
      `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    blocks.push({
      id: `blk_${index}_${fmt(cursor).replace(':', '')}`,
      label: `${index}º Bloco (${durationMinutes} min)`,
      inicio: fmt(cursor),
      fim: fmt(blockEnd),
      ativo: true,
    });

    cursor = blockEnd + Math.max(0, breakMinutes);
    index++;
  }

  return blocks;
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  id: 'global_config',
  tipoDoc: 'GLOBAL_CONFIG',
  reservasAbertas: true,
  horaAberturaSistema: 6,
  janelaInicio: '17:00',
  janelaFim: '22:00',
  duracaoBlocoPadraoMinutos: 50,
  intervaloEntreBlocosMinutos: 10,
  antecedenciaMaximaDias: 1,
  diasSemanaPermitidos: ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as DayOfWeek[],
  blocosPadrao: [
    { id: 'blk_1_1700', label: '1º Bloco Vespertino (50 min)', inicio: '17:00', fim: '17:50', ativo: true },
    { id: 'blk_2_1750', label: '2º Bloco Vespertino (50 min)', inicio: '17:50', fim: '18:40', ativo: true },
    { id: 'blk_3_1900', label: '1ª Aula Noturna (50 min)', inicio: '19:00', fim: '19:50', ativo: true },
    { id: 'blk_4_1950', label: '2ª Aula Noturna (50 min)', inicio: '19:50', fim: '20:40', ativo: true },
    { id: 'blk_5_2050', label: '3ª Aula Noturna (50 min)', inicio: '20:50', fim: '21:40', ativo: true },
    { id: 'blk_6_2140', label: 'Bloco Final Estudo', inicio: '21:40', fim: '22:00', ativo: true },
  ],
  updatedAt: 0,
};

interface ScheduleState {
  config: ScheduleConfig;
  exceptions: ScheduleException[];
  loading: boolean;
  initialized: boolean;

  fetchSchedules: () => () => void;
  saveGlobalConfig: (partial: Partial<ScheduleConfig>) => Promise<void>;
  addException: (data: Omit<ScheduleException, 'id' | 'tipoDoc' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateException: (id: string, data: Partial<ScheduleException>) => Promise<void>;
  deleteException: (id: string, titulo?: string) => Promise<void>;
}

function assertAdminRole(): void {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser || currentUser.role !== 'ADMIN') {
    throw new Error('Operação restrita exclusivamente ao perfil Administrador (ADM).');
  }
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  config: DEFAULT_SCHEDULE_CONFIG,
  exceptions: [],
  loading: false,
  initialized: false,

  fetchSchedules: () => {
    set({ loading: true });
    const colRef = collection(db, 'schedules');

    const unsubscribe = onSnapshot(
      colRef,
      (snapshot) => {
        let loadedConfig: ScheduleConfig = DEFAULT_SCHEDULE_CONFIG;
        const loadedExceptions: ScheduleException[] = [];

        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data() || {};
          if (docSnap.id === 'global_config' || data.tipoDoc === 'GLOBAL_CONFIG') {
            loadedConfig = {
              ...DEFAULT_SCHEDULE_CONFIG,
              ...data,
              id: 'global_config',
              tipoDoc: 'GLOBAL_CONFIG',
              diasSemanaPermitidos: Array.isArray(data.diasSemanaPermitidos)
                ? data.diasSemanaPermitidos
                : DEFAULT_SCHEDULE_CONFIG.diasSemanaPermitidos,
              blocosPadrao: Array.isArray(data.blocosPadrao)
                ? data.blocosPadrao
                : DEFAULT_SCHEDULE_CONFIG.blocosPadrao,
            } as ScheduleConfig;
          } else if (data.tipoDoc === 'EXCEPTION' || data.data) {
            loadedExceptions.push({
              ...data,
              id: docSnap.id,
              tipoDoc: 'EXCEPTION',
              data: String(data.data || ''),
              titulo: String(data.titulo || 'Exceção de Horário'),
            } as ScheduleException);
          }
        });

        loadedExceptions.sort((a, b) => (a?.data || '').localeCompare(b?.data || ''));

        set({
          config: loadedConfig,
          exceptions: loadedExceptions,
          loading: false,
          initialized: true,
        });
      },
      (error) => {
        // Evita travar a UI caso ainda não haja regras implantadas em primeiro boot
        console.warn('Schedules listener warning:', error);
        set({ loading: false, initialized: true });
      }
    );

    return unsubscribe;
  },

  saveGlobalConfig: async (partial) => {
    assertAdminRole();
    const current = get().config;
    const { user } = useAuthStore.getState();
    const now = Date.now();

    const nextConfig: ScheduleConfig = stripUndefinedFields({
      ...DEFAULT_SCHEDULE_CONFIG,
      ...current,
      ...partial,
      id: 'global_config',
      tipoDoc: 'GLOBAL_CONFIG',
      updatedAt: now,
      updatedBy: user?.nome || 'Administrador',
    });

    try {
      await withRetry(() => setDoc(doc(db, 'schedules', 'global_config'), nextConfig));
      set({ config: nextConfig });

      if (user) {
        await useLogStore
          .getState()
          .addLog({
            acao: 'ATUALIZAR_JANELA_HORARIOS',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'HORARIOS',
            detalhes: `Janela operacional atualizada (${nextConfig.janelaInicio} às ${nextConfig.janelaFim} • Status: ${
              nextConfig.reservasAbertas ? 'Liberado' : 'Suspenso'
            } • ${(nextConfig.blocosPadrao ?? []).filter((b) => b?.ativo).length} blocos ativos).`,
          })
          .catch(() => {});
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'schedules/global_config');
    }
  },

  addException: async (exceptionData) => {
    assertAdminRole();
    const { user } = useAuthStore.getState();
    const now = Date.now();

    const cleanPayload: Record<string, unknown> = {
      tipoDoc: 'EXCEPTION',
      data: String(exceptionData.data || ''),
      titulo: String(exceptionData.titulo || '').trim().slice(0, 140),
      fechado: Boolean(exceptionData.fechado),
      salaId: exceptionData.salaId || 'TODAS',
      salaNome: exceptionData.salaNome || 'Todos os Ambientes',
      motivo: String(exceptionData.motivo || '').trim().slice(0, 400),
      createdAt: now,
      updatedAt: now,
    };

    if (!exceptionData.fechado) {
      cleanPayload.janelaInicio = exceptionData.janelaInicio || get().config?.janelaInicio || '17:00';
      cleanPayload.janelaFim = exceptionData.janelaFim || get().config?.janelaFim || '22:00';
      if (
        Array.isArray(exceptionData.blocosCustomizados) &&
        exceptionData.blocosCustomizados.length > 0
      ) {
        cleanPayload.blocosCustomizados = exceptionData.blocosCustomizados;
      }
    }

    try {
      await withRetry(() =>
        addDoc(collection(db, 'schedules'), stripUndefinedFields(cleanPayload))
      );

      if (user) {
        await useLogStore
          .getState()
          .addLog({
            acao: 'CRIAR_EXCECAO_HORARIO',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'HORARIOS',
            detalhes: `Exceção "${exceptionData.titulo}" criada para ${exceptionData.data} (${
              exceptionData.fechado
                ? 'Dia Fechado / Bloqueado'
                : `${exceptionData.janelaInicio} às ${exceptionData.janelaFim}`
            }).`,
          })
          .catch(() => {});
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'schedules');
    }
  },

  updateException: async (id, data) => {
    assertAdminRole();
    const { user } = useAuthStore.getState();
    const now = Date.now();
    const cleanData = stripUndefinedFields({
      ...(data as unknown as Record<string, unknown>),
      updatedAt: now,
    });

    try {
      await withRetry(() => updateDoc(doc(db, 'schedules', id), cleanData));

      if (user) {
        await useLogStore
          .getState()
          .addLog({
            acao: 'EDITAR_EXCECAO_HORARIO',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'HORARIOS',
            detalhes: `Exceção de horário ID ${id} atualizada.`,
          })
          .catch(() => {});
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `schedules/${id}`);
    }
  },

  deleteException: async (id, titulo) => {
    assertAdminRole();
    const { user } = useAuthStore.getState();
    try {
      await withRetry(() => deleteDoc(doc(db, 'schedules', id)));

      if (user) {
        await useLogStore
          .getState()
          .addLog({
            acao: 'EXCLUIR_EXCECAO_HORARIO',
            usuarioId: user.id,
            usuarioNome: user.nome,
            entidade: 'HORARIOS',
            detalhes: `Exceção de horário "${titulo || id}" removida.`,
          })
          .catch(() => {});
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `schedules/${id}`);
    }
  },
}));
