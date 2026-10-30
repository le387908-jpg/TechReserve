/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { AvailableSlot, Room } from '../types';
import { useAuthStore } from './useAuthStore';
import { useLogStore } from './useLogStore';

/**
 * Gera um ID determinístico seguro (`^[a-zA-Z0-9_\-]+$`, máx 128 chars) para `available_slots/{slotId}`,
 * evitando duplicidade de slots para a mesma sala, data e faixa horária.
 */
export function buildAvailableSlotId(
  salaId: string,
  data: string,
  inicio: string,
  fim: string
): string {
  const cleanSala = salaId.replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanData = data.replace(/[^0-9-]/g, '');
  const cleanInicio = inicio.replace(/[^0-9]/g, '');
  const cleanFim = fim.replace(/[^0-9]/g, '');
  return `${cleanSala}_${cleanData}_${cleanInicio}_${cleanFim}`.slice(0, 128);
}

/**
 * Verifica se um registro vindo de `available_slots` encontra-se liberado/ativo para reserva.
 */
export function isSlotActiveOrReleased(
  slot: Partial<AvailableSlot> | null | undefined
): boolean {
  if (!slot) return false;
  const normalizedStatus = String(slot.status || '')
    .trim()
    .toLowerCase();

  if (normalizedStatus === 'bloqueado' || normalizedStatus === 'inativo') {
    return false;
  }
  if (slot.ativo === false) {
    return false;
  }
  return (
    normalizedStatus === 'liberado' ||
    normalizedStatus === 'ativo' ||
    (!normalizedStatus && slot.ativo === true)
  );
}

/**
 * Verifica se um documento de `available_slots` pertence à sala informada (por ID do Firestore ou ID institucional).
 */
export function matchesSlotRoom(
  slot: Pick<AvailableSlot, 'salaId' | 'salaInstitutionalId'>,
  room: Pick<Room, 'firestoreId' | 'id'>
): boolean {
  if (slot.salaId === room.firestoreId) return true;
  if (room.id && slot.salaId === room.id) return true;
  if (slot.salaInstitutionalId && room.id && slot.salaInstitutionalId === room.id) {
    return true;
  }
  return false;
}

function assertAdminRole() {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser || currentUser.role !== 'ADMIN') {
    throw new Error('Operação restrita exclusivamente ao perfil Administrador (ADM).');
  }
  return currentUser;
}

interface AvailableSlotsState {
  slots: AvailableSlot[];
  loading: boolean;
  initialized: boolean;

  fetchAvailableSlots: () => () => void;
  setSlotReleaseStatus: (params: {
    room: Room;
    data: string;
    inicio: string;
    fim: string;
    label?: string;
    release: boolean;
  }) => Promise<void>;
  releaseMultipleSlotsForRoomAndDate: (params: {
    room: Room;
    data: string;
    blocks: { inicio: string; fim: string; label?: string }[];
  }) => Promise<number>;
  blockAllSlotsForRoomAndDate: (params: {
    room: Room;
    data: string;
  }) => Promise<number>;
  releaseBlocksAcrossRoomsForDate: (params: {
    rooms: Room[];
    data: string;
    blocks: { inicio: string; fim: string; label?: string }[];
  }) => Promise<number>;
  deleteSlot: (slotId: string) => Promise<void>;
}

export const useAvailableSlotsStore = create<AvailableSlotsState>((set, get) => ({
  slots: [],
  loading: false,
  initialized: false,

  fetchAvailableSlots: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      return () => {};
    }

    set({ loading: true });

    const unsubscribe = onSnapshot(
      collection(db, 'available_slots'),
      (snapshot) => {
        const parsed = snapshot.docs
          .map((docSnap) => {
            const raw = docSnap.data() as Record<string, unknown>;
            const statusRaw = String(raw.status || (raw.ativo === true ? 'liberado' : 'bloqueado'))
              .trim()
              .toLowerCase();
            const normalizedStatus =
              statusRaw === 'liberado' ||
              statusRaw === 'ativo' ||
              statusRaw === 'bloqueado' ||
              statusRaw === 'inativo'
                ? statusRaw
                : raw.ativo === true
                ? 'liberado'
                : 'bloqueado';

            return {
              id: docSnap.id,
              salaId: String(raw.salaId || ''),
              salaInstitutionalId: raw.salaInstitutionalId
                ? String(raw.salaInstitutionalId)
                : undefined,
              salaNome: String(raw.salaNome || ''),
              data: String(raw.data || ''),
              inicio: String(raw.inicio || ''),
              fim: String(raw.fim || ''),
              label: raw.label ? String(raw.label) : undefined,
              status: normalizedStatus,
              ativo:
                typeof raw.ativo === 'boolean'
                  ? raw.ativo
                  : normalizedStatus === 'liberado' || normalizedStatus === 'ativo',
              liberadoPorId: raw.liberadoPorId ? String(raw.liberadoPorId) : undefined,
              liberadoPorNome: raw.liberadoPorNome ? String(raw.liberadoPorNome) : undefined,
              createdAt: Number(raw.createdAt || 0),
              updatedAt: Number(raw.updatedAt || 0),
            } as AvailableSlot;
          })
          .sort((a, b) => {
            if (a.data !== b.data) return a.data.localeCompare(b.data);
            if (a.salaNome !== b.salaNome) return a.salaNome.localeCompare(b.salaNome);
            return a.inicio.localeCompare(b.inicio);
          });

        set({ slots: parsed, loading: false, initialized: true });
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, 'available_slots');
        } catch {
          // Erro já tratado pelo utilitário centralizado
        }
        set({ loading: false, initialized: true });
      }
    );

    return unsubscribe;
  },

  setSlotReleaseStatus: async ({ room, data, inicio, fim, label, release }) => {
    const adminUser = assertAdminRole();
    const existingSlot = get().slots.find(
      (s) =>
        matchesSlotRoom(s, room) &&
        s.data === data &&
        s.inicio === inicio &&
        s.fim === fim
    );

    const targetId =
      existingSlot?.id || buildAvailableSlotId(room.firestoreId, data, inicio, fim);
    const now = Date.now();

    const payload = {
      id: targetId,
      salaId: room.firestoreId.slice(0, 128),
      salaInstitutionalId: (room.id || '').slice(0, 64),
      salaNome: room.nome.slice(0, 140),
      data: data.slice(0, 16),
      inicio: inicio.slice(0, 8),
      fim: fim.slice(0, 8),
      label: (label || `Bloco ${inicio}–${fim}`).slice(0, 120),
      status: release ? ('liberado' as const) : ('bloqueado' as const),
      ativo: release,
      liberadoPorId: adminUser.id.slice(0, 128),
      liberadoPorNome: adminUser.nome.slice(0, 120),
      createdAt: existingSlot?.createdAt || now,
      updatedAt: now,
    };

    try {
      await withRetry(() => setDoc(doc(db, 'available_slots', targetId), payload));

      await useLogStore.getState().addLog({
        acao: release ? 'LIBERAR_HORARIO_SALA' : 'BLOQUEAR_HORARIO_SALA',
        usuarioId: adminUser.id,
        usuarioNome: adminUser.nome,
        entidade: 'HORARIOS',
        detalhes: `Horário ${inicio}–${fim} em ${data} para "${room.nome}" definido como ${
          release ? 'LIBERADO' : 'BLOQUEADO'
        }.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `available_slots/${targetId}`);
    }
  },

  releaseMultipleSlotsForRoomAndDate: async ({ room, data, blocks }) => {
    const adminUser = assertAdminRole();
    if (blocks.length === 0) return 0;

    const now = Date.now();
    const currentSlots = get().slots;

    try {
      const batch = writeBatch(db);
      let count = 0;

      for (const blk of blocks) {
        if (!blk.inicio || !blk.fim || blk.inicio >= blk.fim) continue;
        const existingSlot = currentSlots.find(
          (s) =>
            matchesSlotRoom(s, room) &&
            s.data === data &&
            s.inicio === blk.inicio &&
            s.fim === blk.fim
        );
        const targetId =
          existingSlot?.id ||
          buildAvailableSlotId(room.firestoreId, data, blk.inicio, blk.fim);

        batch.set(doc(db, 'available_slots', targetId), {
          id: targetId,
          salaId: room.firestoreId.slice(0, 128),
          salaInstitutionalId: (room.id || '').slice(0, 64),
          salaNome: room.nome.slice(0, 140),
          data: data.slice(0, 16),
          inicio: blk.inicio.slice(0, 8),
          fim: blk.fim.slice(0, 8),
          label: (blk.label || `Bloco ${blk.inicio}–${blk.fim}`).slice(0, 120),
          status: 'liberado',
          ativo: true,
          liberadoPorId: adminUser.id.slice(0, 128),
          liberadoPorNome: adminUser.nome.slice(0, 120),
          createdAt: existingSlot?.createdAt || now,
          updatedAt: now,
        });
        count++;
      }

      if (count > 0) {
        await withRetry(() => batch.commit());
        await useLogStore.getState().addLog({
          acao: 'LIBERAR_LOTE_HORARIOS',
          usuarioId: adminUser.id,
          usuarioNome: adminUser.nome,
          entidade: 'HORARIOS',
          detalhes: `${count} horário(s) liberado(s) em ${data} para "${room.nome}".`,
        });
      }

      return count;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'available_slots');
      return 0;
    }
  },

  blockAllSlotsForRoomAndDate: async ({ room, data }) => {
    const adminUser = assertAdminRole();
    const matching = get().slots.filter(
      (s) => matchesSlotRoom(s, room) && s.data === data && isSlotActiveOrReleased(s)
    );

    if (matching.length === 0) return 0;

    const now = Date.now();
    try {
      const batch = writeBatch(db);
      for (const slot of matching) {
        batch.set(doc(db, 'available_slots', slot.id), {
          id: slot.id,
          salaId: slot.salaId.slice(0, 128),
          salaInstitutionalId: (slot.salaInstitutionalId || room.id || '').slice(0, 64),
          salaNome: (slot.salaNome || room.nome).slice(0, 140),
          data: slot.data.slice(0, 16),
          inicio: slot.inicio.slice(0, 8),
          fim: slot.fim.slice(0, 8),
          label: (slot.label || `Bloco ${slot.inicio}–${slot.fim}`).slice(0, 120),
          status: 'bloqueado',
          ativo: false,
          liberadoPorId: adminUser.id.slice(0, 128),
          liberadoPorNome: adminUser.nome.slice(0, 120),
          createdAt: slot.createdAt || now,
          updatedAt: now,
        });
      }

      await withRetry(() => batch.commit());

      await useLogStore.getState().addLog({
        acao: 'BLOQUEAR_LOTE_HORARIOS',
        usuarioId: adminUser.id,
        usuarioNome: adminUser.nome,
        entidade: 'HORARIOS',
        detalhes: `${matching.length} horário(s) bloqueado(s) em ${data} para "${room.nome}".`,
      });

      return matching.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'available_slots');
      return 0;
    }
  },

  releaseBlocksAcrossRoomsForDate: async ({ rooms, data, blocks }) => {
    const adminUser = assertAdminRole();
    if (rooms.length === 0 || blocks.length === 0) return 0;

    const now = Date.now();
    const currentSlots = get().slots;
    const operations: { id: string; payload: Record<string, unknown> }[] = [];

    for (const room of rooms) {
      for (const blk of blocks) {
        if (!blk.inicio || !blk.fim || blk.inicio >= blk.fim) continue;
        const existingSlot = currentSlots.find(
          (s) =>
            matchesSlotRoom(s, room) &&
            s.data === data &&
            s.inicio === blk.inicio &&
            s.fim === blk.fim
        );
        const targetId =
          existingSlot?.id ||
          buildAvailableSlotId(room.firestoreId, data, blk.inicio, blk.fim);

        operations.push({
          id: targetId,
          payload: {
            id: targetId,
            salaId: room.firestoreId.slice(0, 128),
            salaInstitutionalId: (room.id || '').slice(0, 64),
            salaNome: room.nome.slice(0, 140),
            data: data.slice(0, 16),
            inicio: blk.inicio.slice(0, 8),
            fim: blk.fim.slice(0, 8),
            label: (blk.label || `Bloco ${blk.inicio}–${blk.fim}`).slice(0, 120),
            status: 'liberado',
            ativo: true,
            liberadoPorId: adminUser.id.slice(0, 128),
            liberadoPorNome: adminUser.nome.slice(0, 120),
            createdAt: existingSlot?.createdAt || now,
            updatedAt: now,
          },
        });
      }
    }

    if (operations.length === 0) return 0;

    try {
      const CHUNK_SIZE = 400;
      for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
        const slice = operations.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        for (const op of slice) {
          batch.set(doc(db, 'available_slots', op.id), op.payload);
        }
        await withRetry(() => batch.commit());
      }

      await useLogStore.getState().addLog({
        acao: 'LIBERAR_HORARIOS_MULTIPLAS_SALAS',
        usuarioId: adminUser.id,
        usuarioNome: adminUser.nome,
        entidade: 'HORARIOS',
        detalhes: `${operations.length} slot(s) liberado(s) em ${data} para ${rooms.length} ambiente(s).`,
      });

      return operations.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'available_slots');
      return 0;
    }
  },

  deleteSlot: async (slotId) => {
    const adminUser = assertAdminRole();
    const target = get().slots.find((s) => s.id === slotId);
    try {
      await withRetry(() => deleteDoc(doc(db, 'available_slots', slotId)));
      await useLogStore.getState().addLog({
        acao: 'REMOVER_HORARIO_SALA',
        usuarioId: adminUser.id,
        usuarioNome: adminUser.nome,
        entidade: 'HORARIOS',
        detalhes: target
          ? `Registro de horário ${target.inicio}–${target.fim} (${target.data}) em "${target.salaNome}" removido.`
          : `Registro de horário ${slotId} removido.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `available_slots/${slotId}`);
    }
  },
}));
