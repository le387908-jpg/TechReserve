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
  orderBy,
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { RealtimeSpaceStatus, Room, inferSpaceCategory } from '../types';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { useLogStore } from './useLogStore';
import { useAuthStore } from './useAuthStore';
import { INITIAL_ROOMS } from '../data/initialRooms';
import { REALTIME_SPACE_STATUS_LABELS } from '../constants';

interface RoomState {
  rooms: Room[];
  loading: boolean;
  error: string | null;

  fetchRooms: () => () => void;
  addRoom: (room: Omit<Room, 'firestoreId' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateRoom: (firestoreId: string, data: Partial<Room>) => Promise<void>;
  setRoomRealtimeStatus: (room: Room, targetStatus: RealtimeSpaceStatus) => Promise<void>;
  toggleMaintenanceOneClick: (room: Room) => Promise<void>;
  toggleRoomBookingRelease: (room: Room) => Promise<void>;
  deleteRoom: (firestoreId: string, roomName?: string) => Promise<void>;
  seedRooms: () => Promise<void>;
  resetRooms: () => Promise<void>;
}

function assertAdminRole(): void {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser || currentUser.role !== 'ADMIN') {
    throw new Error('Operação restrita exclusivamente ao perfil Administrador (ADM).');
  }
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: [],
  loading: false,
  error: null,

  fetchRooms: () => {
    set({ loading: true });
    const q = query(collection(db, 'salas'), orderBy('nome', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      async (snapshot) => {
        const now = Date.now();
        const rooms = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const base = {
            ...data,
            firestoreId: docSnap.id,
            id: data.id || docSnap.id,
            codigo: data.codigo || '',
            liberadaParaReserva: data.liberadaParaReserva !== false,
          } as Room;
          base.categoria = inferSpaceCategory(base);
          return base;
        });

        // Liberar sala automaticamente se o bloqueio temporário expirou (somente se o cliente atual for ADMIN)
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.role === 'ADMIN') {
          for (const room of rooms) {
            if (room.bloqueadaAte && room.bloqueadaAte <= now) {
              try {
                const roomRef = doc(db, 'salas', room.firestoreId);
                await updateDoc(roomRef, {
                  bloqueadaAte: null,
                  motivoBloqueio: null,
                  updatedAt: now,
                });

                await useLogStore.getState().addLog({
                  acao: 'LIBERAR_SALA_AUTOMATICO',
                  usuarioId: 'SISTEMA',
                  usuarioNome: 'Sistema (Auto-Liberador)',
                  entidade: 'SALAS',
                  detalhes: `O bloqueio temporário da sala ${room.nome} expirou e o ambiente foi reativado.`,
                });
              } catch (err) {
                console.error(`Erro ao liberar sala ${room.nome} automaticamente:`, err);
              }
            }
          }
        }

        set({ rooms, loading: false });
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'salas');
      }
    );

    return unsubscribe;
  },

  seedRooms: async () => {
    assertAdminRole();
    const { rooms, addRoom } = get();
    if (rooms.length > 0) return;

    for (const room of INITIAL_ROOMS) {
      await addRoom(room as any);
    }
  },

  resetRooms: async () => {
    assertAdminRole();
    const { rooms, deleteRoom, addRoom } = get();
    set({ loading: true });
    try {
      for (const room of rooms) {
        await deleteRoom(room.firestoreId, room.nome);
      }
      for (const room of INITIAL_ROOMS) {
        await addRoom(room as any);
      }
    } finally {
      set({ loading: false });
    }
  },

  addRoom: async (roomData) => {
    assertAdminRole();
    try {
      const now = Date.now();
      const cleanData: Record<string, unknown> = {};
      Object.entries(roomData).forEach(([k, v]) => {
        if (v !== undefined) cleanData[k] = v;
      });

      await withRetry(() =>
        addDoc(collection(db, 'salas'), {
          ...cleanData,
          liberadaParaReserva: roomData.liberadaParaReserva !== false,
          categoria: inferSpaceCategory(roomData),
          createdAt: now,
          updatedAt: now,
        })
      );

      const { user } = useAuthStore.getState();
      if (user) {
        await useLogStore.getState().addLog({
          acao: 'CRIAR_SALA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SALAS',
          detalhes: `Espaço "${roomData.nome}" (${roomData.id}) cadastrado no inventário.`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'salas');
    }
  },

  updateRoom: async (firestoreId, data) => {
    assertAdminRole();
    try {
      const cleanData: Record<string, unknown> = {};
      Object.entries(data).forEach(([k, v]) => {
        if (v !== undefined) cleanData[k] = v;
      });

      const roomRef = doc(db, 'salas', firestoreId);
      await withRetry(() =>
        updateDoc(roomRef, {
          ...cleanData,
          updatedAt: Date.now(),
        })
      );

      const { user } = useAuthStore.getState();
      if (user) {
        await useLogStore.getState().addLog({
          acao: 'ATUALIZAR_SALA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SALAS',
          detalhes: `Espaço ${data.nome || firestoreId} atualizado no inventário.`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `salas/${firestoreId}`);
    }
  },

  setRoomRealtimeStatus: async (room, targetStatus) => {
    assertAdminRole();
    const { user } = useAuthStore.getState();
    const now = Date.now();

    const mappedStatus = targetStatus === 'MANUTENCAO' ? 'MANUTENCAO' : 'ATIVO';
    const mappedManual: RealtimeSpaceStatus | null =
      targetStatus === 'DISPONIVEL' ? null : targetStatus;

    try {
      await withRetry(() =>
        updateDoc(doc(db, 'salas', room.firestoreId), {
          status: mappedStatus,
          statusManual: mappedManual,
          ...(targetStatus === 'DISPONIVEL' ? { bloqueadaAte: null, motivoBloqueio: null } : {}),
          updatedAt: now,
        })
      );

      if (user) {
        await useLogStore.getState().addLog({
          acao: 'STATUS_ESPACO_TEMPO_REAL',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SALAS',
          detalhes: `Status de "${room.nome}" (${room.id}) alterado em tempo real para "${REALTIME_SPACE_STATUS_LABELS[targetStatus]}".`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `salas/${room.firestoreId}`);
    }
  },

  toggleMaintenanceOneClick: async (room) => {
    assertAdminRole();
    const isCurrentlyMaintenance =
      room.status === 'MANUTENCAO' ||
      room.status === 'INATIVO' ||
      room.statusManual === 'MANUTENCAO' ||
      Boolean(room.bloqueadaAte && room.bloqueadaAte > Date.now());

    const nextStatus: RealtimeSpaceStatus = isCurrentlyMaintenance ? 'DISPONIVEL' : 'MANUTENCAO';
    await get().setRoomRealtimeStatus(room, nextStatus);
  },

  toggleRoomBookingRelease: async (room) => {
    assertAdminRole();
    const { user } = useAuthStore.getState();
    const nextReleased = room.liberadaParaReserva === false;
    const now = Date.now();

    try {
      await withRetry(() =>
        updateDoc(doc(db, 'salas', room.firestoreId), {
          liberadaParaReserva: nextReleased,
          updatedAt: now,
        })
      );

      if (user) {
        await useLogStore.getState().addLog({
          acao: nextReleased ? 'LIBERAR_SALA_RESERVAS' : 'BLOQUEAR_SALA_RESERVAS',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SALAS',
          detalhes: `Sala "${room.nome}" (${room.id}) ${
            nextReleased ? 'liberada explicitamente' : 'bloqueada'
          } pelo ADM para reservas de usuários comuns.`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `salas/${room.firestoreId}`);
    }
  },

  deleteRoom: async (firestoreId, roomName) => {
    assertAdminRole();
    try {
      await withRetry(() => deleteDoc(doc(db, 'salas', firestoreId)));

      const { user } = useAuthStore.getState();
      if (user) {
        await useLogStore.getState().addLog({
          acao: 'EXCLUIR_SALA',
          usuarioId: user.id,
          usuarioNome: user.nome,
          entidade: 'SALAS',
          detalhes: `Espaço "${roomName || firestoreId}" excluído do inventário.`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `salas/${firestoreId}`);
    }
  },
}));
