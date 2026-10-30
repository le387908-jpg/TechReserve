/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import {
  AvailableSlot,
  Reservation,
  Room,
  ScheduleConfig,
  ScheduleException,
} from '../types';
import { useReservationStore } from '../store/useReservationStore';
import { useAvailableSlotsStore } from '../store/useAvailableSlotsStore';
import { useRoomStore } from '../store/useRoomStore';
import { useScheduleStore } from '../store/useScheduleStore';
import { getFriendlyErrorMessage } from '../services/firebase/utils';

export interface ReservationContextValue {
  reservations: Reservation[];
  availableSlots: AvailableSlot[];
  rooms: Room[];
  scheduleConfig: ScheduleConfig;
  scheduleExceptions: ScheduleException[];
  loading: boolean;
  reservationsLoading: boolean;
  slotsLoading: boolean;
  roomsLoading: boolean;
  schedulesLoading: boolean;
  initialized: boolean;
  error: string | null;
  createReservation: (
    data: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>
  ) => Promise<void>;
  cancelReservation: (id: string) => Promise<void>;
  approveReservation: (id: string) => Promise<void>;
  deleteReservation: (id: string) => Promise<void>;
  performCheckIn: (id: string) => Promise<void>;
}

export const ReservationContext = createContext<ReservationContextValue | undefined>(
  undefined
);

/**
 * Contexto centralizado e resiliente de Reservas, Salas e Horários Liberados.
 * Garante fallbacks seguros de listas vazias (`[]`), estados de carregamento consolidados (`loading`)
 * e captura padronizada de exceções em mutações do Firestore.
 */
export function ReservationProvider({ children }: { children: React.ReactNode }) {
  const rawReservations = useReservationStore((state) => state.reservations);
  const reservationsLoading = useReservationStore((state) => state.loading);
  const reservationError = useReservationStore((state) => state.error);
  const addReservationAction = useReservationStore((state) => state.addReservation);
  const updateReservationAction = useReservationStore((state) => state.updateReservation);
  const deleteReservationAction = useReservationStore((state) => state.deleteReservation);
  const checkInAction = useReservationStore((state) => state.checkIn);

  const rawSlots = useAvailableSlotsStore((state) => state.slots);
  const slotsLoading = useAvailableSlotsStore((state) => state.loading);
  const slotsInitialized = useAvailableSlotsStore((state) => state.initialized);
  const slotsError = useAvailableSlotsStore((state) => state.error);

  const rawRooms = useRoomStore((state) => state.rooms);
  const roomsLoading = useRoomStore((state) => state.loading);
  const roomsError = useRoomStore((state) => state.error);

  const scheduleConfig = useScheduleStore((state) => state.config);
  const rawExceptions = useScheduleStore((state) => state.exceptions);
  const schedulesLoading = useScheduleStore((state) => state.loading);
  const schedulesInitialized = useScheduleStore((state) => state.initialized);

  const reservations = useMemo<Reservation[]>(
    () => (Array.isArray(rawReservations) ? rawReservations.filter(Boolean) : []),
    [rawReservations]
  );

  const availableSlots = useMemo<AvailableSlot[]>(
    () => (Array.isArray(rawSlots) ? rawSlots.filter(Boolean) : []),
    [rawSlots]
  );

  const rooms = useMemo<Room[]>(
    () => (Array.isArray(rawRooms) ? rawRooms.filter(Boolean) : []),
    [rawRooms]
  );

  const scheduleExceptions = useMemo<ScheduleException[]>(
    () => (Array.isArray(rawExceptions) ? rawExceptions.filter(Boolean) : []),
    [rawExceptions]
  );

  const createReservation = useCallback(
    async (data: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>) => {
      try {
        await addReservationAction(data);
      } catch (err) {
        throw new Error(
          getFriendlyErrorMessage(err, 'Não foi possível concluir a reserva.')
        );
      }
    },
    [addReservationAction]
  );

  const cancelReservation = useCallback(
    async (id: string) => {
      try {
        await updateReservationAction(id, { status: 'CANCELADA' });
      } catch (err) {
        throw new Error(
          getFriendlyErrorMessage(err, 'Não foi possível cancelar a reserva.')
        );
      }
    },
    [updateReservationAction]
  );

  const approveReservation = useCallback(
    async (id: string) => {
      try {
        await updateReservationAction(id, {
          status: 'CONFIRMADA',
          checkInRealizado: true,
        });
      } catch (err) {
        throw new Error(
          getFriendlyErrorMessage(err, 'Não foi possível aprovar a reserva.')
        );
      }
    },
    [updateReservationAction]
  );

  const deleteReservation = useCallback(
    async (id: string) => {
      try {
        await deleteReservationAction(id);
      } catch (err) {
        throw new Error(
          getFriendlyErrorMessage(err, 'Não foi possível remover a reserva.')
        );
      }
    },
    [deleteReservationAction]
  );

  const performCheckIn = useCallback(
    async (id: string) => {
      try {
        await checkInAction(id);
      } catch (err) {
        throw new Error(
          getFriendlyErrorMessage(err, 'Não foi possível registrar o check-in.')
        );
      }
    },
    [checkInAction]
  );

  const loading = Boolean(
    reservationsLoading || slotsLoading || roomsLoading || schedulesLoading
  );
  const initialized = Boolean(slotsInitialized && schedulesInitialized && !roomsLoading);
  const error = reservationError || slotsError || roomsError || null;

  const value = useMemo<ReservationContextValue>(
    () => ({
      reservations,
      availableSlots,
      rooms,
      scheduleConfig,
      scheduleExceptions,
      loading,
      reservationsLoading,
      slotsLoading,
      roomsLoading,
      schedulesLoading,
      initialized,
      error,
      createReservation,
      cancelReservation,
      approveReservation,
      deleteReservation,
      performCheckIn,
    }),
    [
      reservations,
      availableSlots,
      rooms,
      scheduleConfig,
      scheduleExceptions,
      loading,
      reservationsLoading,
      slotsLoading,
      roomsLoading,
      schedulesLoading,
      initialized,
      error,
      createReservation,
      cancelReservation,
      approveReservation,
      deleteReservation,
      performCheckIn,
    ]
  );

  return (
    <ReservationContext.Provider value={value}>
      {children}
    </ReservationContext.Provider>
  );
}

export function useReservations(): ReservationContextValue {
  const context = useContext(ReservationContext);
  if (!context) {
    throw new Error(
      'useReservations deve ser utilizado dentro de um <ReservationProvider>.'
    );
  }
  return context;
}
