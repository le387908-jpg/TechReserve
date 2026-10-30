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
import {
  OperationType,
  getFriendlyErrorMessage,
  handleFirestoreError,
  stripUndefinedFields,
  withRetry,
} from '../services/firebase/utils';
import { AvailableSlot, Room } from '../types';
import { useAuthStore } from './useAuthStore';
import { useLogStore } from './useLogStore';
import { normalizeDateToISO } from '../utils/dateUtils';

/**
 * Normaliza horários para formato estrito `HH:mm` (ex: `"8:00"` -> `"08:00"`).
 */
export function normalizeTimeHHMM(rawTime: unknown): string {
  const str = String(rawTime || '').trim();
  const match = str.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return str;
  const h = String(Math.min(23, Math.max(0, Number(match[1])))).padStart(2, '0');
  const m = String(Math.min(59, Math.max(0, Number(match[2])))).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Extrai `inicio` e `fim` (`HH:mm`) suportando tanto campos separados (`inicio`/`fim`, `startTime`/`endTime`)
 * quanto o campo composto `timeSlot` / `horario` (ex: `"19:00 - 19:50"` ou `"19:00 às 19:50"`).
 */
export function extractNormalizedSlotTimes(raw: Record<string, unknown>): {
  inicio: string;
  fim: string;
  timeSlot: string;
} {
  let inicio = normalizeTimeHHMM(raw.inicio ?? raw.startTime ?? raw.start ?? '');
  let fim = normalizeTimeHHMM(raw.fim ?? raw.endTime ?? raw.end ?? '');
  const rawTimeSlot = String(raw.timeSlot ?? raw.horario ?? '').trim();

  if ((!inicio || !fim) && rawTimeSlot) {
    const rangeMatch = rawTimeSlot.match(/(\d{1,2}:\d{2})\s*(?:[-–—]|às|as|a)\s*(\d{1,2}:\d{2})/i);
    if (rangeMatch) {
      if (!inicio) inicio = normalizeTimeHHMM(rangeMatch[1]);
      if (!fim) fim = normalizeTimeHHMM(rangeMatch[2]);
    }
  }

  return {
    inicio,
    fim,
    timeSlot: rawTimeSlot || (inicio && fim ? `${inicio} - ${fim}` : ''),
  };
}

function normalizeRoomNameForExactMatch(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª.]/g, ' ')
    .replace(/\b0+(\d+)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hidrata qualquer documento da coleção `available_slots` unificando variações de chaves
 * (`salaId`/`roomId`, `data`/`date`, `inicio`+`fim`/`timeSlot`, `status`/`ativo`).
 */
export function hydrateAvailableSlotDoc(
  docId: string,
  raw: Record<string, unknown>,
  fallbackRoomName = ''
): AvailableSlot {
  const { inicio, fim, timeSlot } = extractNormalizedSlotTimes(raw);
  const rawDate = String(raw.data ?? raw.date ?? '').trim();
  const normalizedData = rawDate ? normalizeDateToISO(rawDate) : '';

  const boolFlag =
    typeof raw.ativo === 'boolean'
      ? raw.ativo
      : typeof raw.available === 'boolean'
      ? raw.available
      : undefined;

  const statusRaw = String(
    raw.status ?? (boolFlag === true ? 'liberado' : boolFlag === false ? 'bloqueado' : '')
  )
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const isReleasedStatus =
    statusRaw === 'liberado' ||
    statusRaw === 'ativo' ||
    statusRaw === 'disponivel' ||
    statusRaw === 'livre' ||
    statusRaw === 'available' ||
    statusRaw === 'open';

  const isBlockedStatus =
    statusRaw === 'bloqueado' ||
    statusRaw === 'inativo' ||
    statusRaw === 'indisponivel' ||
    statusRaw === 'closed';

  let normalizedStatus: AvailableSlot['status'] = 'bloqueado';
  if (boolFlag === false || isBlockedStatus) {
    normalizedStatus = statusRaw === 'inativo' ? 'inativo' : 'bloqueado';
  } else if (isReleasedStatus || (!statusRaw && boolFlag === true)) {
    normalizedStatus =
      statusRaw === 'ativo'
        ? 'ativo'
        : statusRaw === 'disponivel'
        ? 'disponivel'
        : 'liberado';
  }

  return {
    id: docId,
    salaId: String(raw.salaId ?? raw.roomId ?? raw.room_id ?? '').trim(),
    salaInstitutionalId:
      raw.salaInstitutionalId || raw.roomCode
        ? String(raw.salaInstitutionalId ?? raw.roomCode).trim()
        : undefined,
    salaNome: String(raw.salaNome ?? raw.roomName ?? fallbackRoomName ?? '').trim(),
    data: normalizedData,
    inicio,
    fim,
    timeSlot: timeSlot || undefined,
    label: raw.label ? String(raw.label) : undefined,
    status: normalizedStatus,
    ativo: boolFlag !== undefined ? boolFlag : isReleasedStatus,
    liberadoPorId: raw.liberadoPorId ? String(raw.liberadoPorId) : undefined,
    liberadoPorNome: raw.liberadoPorNome ? String(raw.liberadoPorNome) : undefined,
    createdAt: Number(raw.createdAt || 0),
    updatedAt: Number(raw.updatedAt || 0),
  };
}

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
  const cleanSala = String(salaId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanData = normalizeDateToISO(data || '').replace(/[^0-9-]/g, '');
  const cleanInicio = normalizeTimeHHMM(inicio).replace(/[^0-9]/g, '');
  const cleanFim = normalizeTimeHHMM(fim).replace(/[^0-9]/g, '');
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
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (
    normalizedStatus === 'bloqueado' ||
    normalizedStatus === 'inativo' ||
    normalizedStatus === 'indisponivel'
  ) {
    return false;
  }
  if (slot.ativo === false) {
    return false;
  }
  return (
    normalizedStatus === 'liberado' ||
    normalizedStatus === 'ativo' ||
    normalizedStatus === 'disponivel' ||
    normalizedStatus === 'livre' ||
    normalizedStatus === 'available' ||
    (!normalizedStatus && slot.ativo === true)
  );
}

/**
 * Verifica se um documento de `available_slots` pertence à sala informada
 * (comparando `firestoreId`, `id` institucional, `codigo` ou nome normalizado sem colisão numérica).
 */
export function matchesSlotRoom(
  slot: Pick<AvailableSlot, 'salaId' | 'salaInstitutionalId' | 'salaNome'> | null | undefined,
  room: Pick<Room, 'firestoreId' | 'id' | 'codigo' | 'nome'> | null | undefined
): boolean {
  if (!slot || !room) return false;
  const slotRoomId = (slot.salaId || '').trim();
  const slotInstId = (slot.salaInstitutionalId || '').trim();

  if (slotRoomId && slotRoomId === room.firestoreId) return true;
  if (room.id) {
    const rId = room.id.trim();
    if (slotRoomId && slotRoomId.toUpperCase() === rId.toUpperCase()) return true;
    if (slotInstId && slotInstId.toUpperCase() === rId.toUpperCase()) return true;
  }
  if (room.codigo) {
    const rCode = room.codigo.trim();
    if (slotRoomId && slotRoomId.toUpperCase() === rCode.toUpperCase()) return true;
    if (slotInstId && slotInstId.toUpperCase() === rCode.toUpperCase()) return true;
  }
  if (slot.salaNome && room.nome) {
    const normSlotName = normalizeRoomNameForExactMatch(slot.salaNome);
    const normRoomName = normalizeRoomNameForExactMatch(room.nome);
    if (normSlotName && normSlotName === normRoomName) return true;
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
  error: string | null;

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
  error: null,

  fetchAvailableSlots: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      return () => {};
    }

    set({ loading: true, error: null });

    const unsubscribe = onSnapshot(
      collection(db, 'available_slots'),
      (snapshot) => {
        const parsed = snapshot.docs
          .map((docSnap) =>
            hydrateAvailableSlotDoc(docSnap.id, (docSnap.data() || {}) as Record<string, unknown>)
          )
          .filter((s) => Boolean(s.data && s.inicio && s.fim))
          .sort((a, b) => {
            if (a.data !== b.data) return (a.data || '').localeCompare(b.data || '');
            if (a.salaNome !== b.salaNome) return (a.salaNome || '').localeCompare(b.salaNome || '');
            return (a.inicio || '').localeCompare(b.inicio || '');
          });

        set({ slots: parsed, loading: false, initialized: true, error: null });
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, 'available_slots');
        } catch {
          // Erro já tratado pelo utilitário centralizado
        }
        set({
          loading: false,
          initialized: true,
          error: getFriendlyErrorMessage(error, 'Erro ao carregar horários liberados.'),
        });
      }
    );

    return unsubscribe;
  },

  setSlotReleaseStatus: async ({ room, data, inicio, fim, label, release }) => {
    const adminUser = assertAdminRole();
    const safeSlots = Array.isArray(get().slots) ? get().slots : [];
    const existingSlot = safeSlots.find(
      (s) =>
        matchesSlotRoom(s, room) &&
        s?.data === data &&
        s?.inicio === inicio &&
        s?.fim === fim
    );

    const targetId =
      existingSlot?.id || buildAvailableSlotId(room?.firestoreId || '', data, inicio, fim);
    const now = Date.now();

    const payload = stripUndefinedFields({
      id: targetId,
      salaId: String(room?.firestoreId || '').slice(0, 128),
      salaInstitutionalId: String(room?.id || '').slice(0, 64),
      salaNome: String(room?.nome || 'Ambiente').slice(0, 140),
      data: String(data || '').slice(0, 16),
      inicio: String(inicio || '').slice(0, 8),
      fim: String(fim || '').slice(0, 8),
      label: String(label || `Bloco ${inicio}–${fim}`).slice(0, 120),
      status: release ? ('liberado' as const) : ('bloqueado' as const),
      ativo: release,
      liberadoPorId: String(adminUser?.id || '').slice(0, 128),
      liberadoPorNome: String(adminUser?.nome || 'Administrador').slice(0, 120),
      createdAt: existingSlot?.createdAt || now,
      updatedAt: now,
    });

    try {
      await withRetry(() => setDoc(doc(db, 'available_slots', targetId), payload));

      await useLogStore
        .getState()
        .addLog({
          acao: release ? 'LIBERAR_HORARIO_SALA' : 'BLOQUEAR_HORARIO_SALA',
          usuarioId: adminUser.id,
          usuarioNome: adminUser.nome || 'Administrador',
          entidade: 'HORARIOS',
          detalhes: `Horário ${inicio}–${fim} em ${data} para "${room?.nome || targetId}" definido como ${
            release ? 'LIBERADO' : 'BLOQUEADO'
          }.`,
        })
        .catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `available_slots/${targetId}`);
    }
  },

  releaseMultipleSlotsForRoomAndDate: async ({ room, data, blocks }) => {
    const adminUser = assertAdminRole();
    const safeBlocks = Array.isArray(blocks) ? blocks : [];
    if (!room || safeBlocks.length === 0) return 0;

    const now = Date.now();
    const currentSlots = Array.isArray(get().slots) ? get().slots : [];

    try {
      const batch = writeBatch(db);
      let count = 0;

      for (const blk of safeBlocks) {
        if (!blk?.inicio || !blk?.fim || blk.inicio >= blk.fim) continue;
        const existingSlot = currentSlots.find(
          (s) =>
            matchesSlotRoom(s, room) &&
            s?.data === data &&
            s?.inicio === blk.inicio &&
            s?.fim === blk.fim
        );
        const targetId =
          existingSlot?.id ||
          buildAvailableSlotId(room.firestoreId || '', data, blk.inicio, blk.fim);

        batch.set(
          doc(db, 'available_slots', targetId),
          stripUndefinedFields({
            id: targetId,
            salaId: String(room.firestoreId || '').slice(0, 128),
            salaInstitutionalId: String(room.id || '').slice(0, 64),
            salaNome: String(room.nome || 'Ambiente').slice(0, 140),
            data: String(data || '').slice(0, 16),
            inicio: String(blk.inicio).slice(0, 8),
            fim: String(blk.fim).slice(0, 8),
            label: String(blk.label || `Bloco ${blk.inicio}–${blk.fim}`).slice(0, 120),
            status: 'liberado',
            ativo: true,
            liberadoPorId: String(adminUser?.id || '').slice(0, 128),
            liberadoPorNome: String(adminUser?.nome || 'Administrador').slice(0, 120),
            createdAt: existingSlot?.createdAt || now,
            updatedAt: now,
          })
        );
        count++;
      }

      if (count > 0) {
        await withRetry(() => batch.commit());
        await useLogStore
          .getState()
          .addLog({
            acao: 'LIBERAR_LOTE_HORARIOS',
            usuarioId: adminUser.id,
            usuarioNome: adminUser.nome || 'Administrador',
            entidade: 'HORARIOS',
            detalhes: `${count} horário(s) liberado(s) em ${data} para "${room.nome}".`,
          })
          .catch(() => {});
      }

      return count;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'available_slots');
      return 0;
    }
  },

  blockAllSlotsForRoomAndDate: async ({ room, data }) => {
    const adminUser = assertAdminRole();
    const safeSlots = Array.isArray(get().slots) ? get().slots : [];
    const matching = safeSlots.filter(
      (s) => matchesSlotRoom(s, room) && s?.data === data && isSlotActiveOrReleased(s)
    );

    if (matching.length === 0) return 0;

    const now = Date.now();
    try {
      const batch = writeBatch(db);
      for (const slot of matching) {
        batch.set(
          doc(db, 'available_slots', slot.id),
          stripUndefinedFields({
            id: slot.id,
            salaId: String(slot.salaId || room?.firestoreId || '').slice(0, 128),
            salaInstitutionalId: String(slot.salaInstitutionalId || room?.id || '').slice(0, 64),
            salaNome: String(slot.salaNome || room?.nome || 'Ambiente').slice(0, 140),
            data: String(slot.data || data || '').slice(0, 16),
            inicio: String(slot.inicio || '').slice(0, 8),
            fim: String(slot.fim || '').slice(0, 8),
            label: String(slot.label || `Bloco ${slot.inicio}–${slot.fim}`).slice(0, 120),
            status: 'bloqueado',
            ativo: false,
            liberadoPorId: String(adminUser?.id || '').slice(0, 128),
            liberadoPorNome: String(adminUser?.nome || 'Administrador').slice(0, 120),
            createdAt: slot.createdAt || now,
            updatedAt: now,
          })
        );
      }

      await withRetry(() => batch.commit());

      await useLogStore
        .getState()
        .addLog({
          acao: 'BLOQUEAR_LOTE_HORARIOS',
          usuarioId: adminUser.id,
          usuarioNome: adminUser.nome || 'Administrador',
          entidade: 'HORARIOS',
          detalhes: `${matching.length} horário(s) bloqueado(s) em ${data} para "${room?.nome || ''}".`,
        })
        .catch(() => {});

      return matching.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'available_slots');
      return 0;
    }
  },

  releaseBlocksAcrossRoomsForDate: async ({ rooms, data, blocks }) => {
    const adminUser = assertAdminRole();
    const safeRooms = Array.isArray(rooms) ? rooms : [];
    const safeBlocks = Array.isArray(blocks) ? blocks : [];
    if (safeRooms.length === 0 || safeBlocks.length === 0) return 0;

    const now = Date.now();
    const currentSlots = Array.isArray(get().slots) ? get().slots : [];
    const operations: { id: string; payload: Record<string, unknown> }[] = [];

    for (const room of safeRooms) {
      if (!room?.firestoreId) continue;
      for (const blk of safeBlocks) {
        if (!blk?.inicio || !blk?.fim || blk.inicio >= blk.fim) continue;
        const existingSlot = currentSlots.find(
          (s) =>
            matchesSlotRoom(s, room) &&
            s?.data === data &&
            s?.inicio === blk.inicio &&
            s?.fim === blk.fim
        );
        const targetId =
          existingSlot?.id ||
          buildAvailableSlotId(room.firestoreId, data, blk.inicio, blk.fim);

        operations.push({
          id: targetId,
          payload: stripUndefinedFields({
            id: targetId,
            salaId: String(room.firestoreId).slice(0, 128),
            salaInstitutionalId: String(room.id || '').slice(0, 64),
            salaNome: String(room.nome || 'Ambiente').slice(0, 140),
            data: String(data || '').slice(0, 16),
            inicio: String(blk.inicio).slice(0, 8),
            fim: String(blk.fim).slice(0, 8),
            label: String(blk.label || `Bloco ${blk.inicio}–${blk.fim}`).slice(0, 120),
            status: 'liberado',
            ativo: true,
            liberadoPorId: String(adminUser?.id || '').slice(0, 128),
            liberadoPorNome: String(adminUser?.nome || 'Administrador').slice(0, 120),
            createdAt: existingSlot?.createdAt || now,
            updatedAt: now,
          }),
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

      await useLogStore
        .getState()
        .addLog({
          acao: 'LIBERAR_HORARIOS_MULTIPLAS_SALAS',
          usuarioId: adminUser.id,
          usuarioNome: adminUser.nome,
          entidade: 'HORARIOS',
          detalhes: `${operations.length} slot(s) liberado(s) em ${data} para ${rooms.length} ambiente(s).`,
        })
        .catch(() => {});

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
      await useLogStore
        .getState()
        .addLog({
          acao: 'REMOVER_HORARIO_SALA',
          usuarioId: adminUser.id,
          usuarioNome: adminUser.nome,
          entidade: 'HORARIOS',
          detalhes: target
            ? `Registro de horário ${target.inicio}–${target.fim} (${target.data}) em "${target.salaNome}" removido.`
            : `Registro de horário ${slotId} removido.`,
        })
        .catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `available_slots/${slotId}`);
    }
  },
}));
