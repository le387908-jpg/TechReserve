/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CalendarEvent, DayOfWeek } from '../types';
import { getEffectiveWindowForDate } from './reservationRules';

export interface DayTimeSlot {
  id: string;
  start: string; // HH:mm
  end: string;   // HH:mm
  durationMinutes: number;
  type: 'LIVRE' | 'AULA_GRADE' | 'RESERVA_USUARIO';
  title: string;
  subtitle?: string;
  room?: string;
  event?: CalendarEvent;
}

export function timeToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getDayOfWeekFromDate(dateStr: string): DayOfWeek | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const dayIndex = date.getDay();
  const map: Record<number, DayOfWeek | null> = {
    0: null,
    1: 'Segunda',
    2: 'Terça',
    3: 'Quarta',
    4: 'Quinta',
    5: 'Sexta',
    6: 'Sábado',
  };
  return map[dayIndex] || null;
}

export function calculateDayTimeSlots(
  dateStr: string,
  events: CalendarEvent[],
  roomFilter?: string
): {
  occupiedSlots: DayTimeSlot[];
  freeSlots: DayTimeSlot[];
  allSlotsChronological: DayTimeSlot[];
} {
  const dow = getDayOfWeekFromDate(dateStr);
  const isSaturday = dow === 'Sábado';
  const isSunday = dow === null;

  if (isSunday) {
    return {
      occupiedSlots: [],
      freeSlots: [],
      allSlotsChronological: [],
    };
  }

  const dayStartMinutes = 7 * 60 + 40;
  const dayEndMinutes = isSaturday ? 13 * 60 + 30 : 22 * 60 + 30;

  const relevantEvents = events.filter((evt) => {
    if (roomFilter && roomFilter !== 'TODAS') {
      const roomMatch =
        evt.sala.toLowerCase().includes(roomFilter.toLowerCase()) ||
        roomFilter.toLowerCase().includes(evt.sala.toLowerCase());
      if (!roomMatch) return false;
    }

    if (evt.tipo === 'RESERVA_USUARIO') {
      return evt.data === dateStr;
    }

    if (evt.tipo === 'AULA_GRADE' && dow) {
      return evt.diaSemana === dow;
    }

    return false;
  });

  const occupiedRaw = relevantEvents
    .map((evt) => {
      const startM = Math.max(dayStartMinutes, timeToMinutes(evt.horarioInicio));
      const endM = Math.min(dayEndMinutes, timeToMinutes(evt.horarioFim));
      return {
        startM,
        endM,
        evt,
      };
    })
    .filter((item) => item.endM > item.startM);

  occupiedRaw.sort((a, b) => a.startM - b.startM);

  const occupiedSlots: DayTimeSlot[] = occupiedRaw.map((item, idx) => ({
    id: `occ_${idx}_${item.evt.id}`,
    start: minutesToTime(item.startM),
    end: minutesToTime(item.endM),
    durationMinutes: item.endM - item.startM,
    type: item.evt.tipo,
    title: item.evt.materia,
    subtitle:
      item.evt.tipo === 'AULA_GRADE'
        ? `Prof. ${item.evt.professor}`
        : `Solicitante: ${item.evt.solicitante}`,
    room: item.evt.sala,
    event: item.evt,
  }));

  const mergedOccupied: { startM: number; endM: number }[] = [];
  for (const item of occupiedRaw) {
    if (mergedOccupied.length === 0) {
      mergedOccupied.push({ startM: item.startM, endM: item.endM });
    } else {
      const last = mergedOccupied[mergedOccupied.length - 1];
      if (item.startM <= last.endM) {
        last.endM = Math.max(last.endM, item.endM);
      } else {
        mergedOccupied.push({ startM: item.startM, endM: item.endM });
      }
    }
  }

  const freeSlots: DayTimeSlot[] = [];
  let currentCursor = dayStartMinutes;

  for (let i = 0; i < mergedOccupied.length; i++) {
    const occ = mergedOccupied[i];
    if (occ.startM > currentCursor) {
      const gapStart = currentCursor;
      const gapEnd = occ.startM;
      if (gapEnd - gapStart >= 15) {
        freeSlots.push({
          id: `free_${gapStart}_${gapEnd}`,
          start: minutesToTime(gapStart),
          end: minutesToTime(gapEnd),
          durationMinutes: gapEnd - gapStart,
          type: 'LIVRE',
          title: getPeriodLabel(gapStart, gapEnd),
          subtitle: 'Livre sem aula - Disponível para reserva',
          room: roomFilter !== 'TODAS' ? roomFilter : undefined,
        });
      }
    }
    currentCursor = Math.max(currentCursor, occ.endM);
  }

  if (currentCursor < dayEndMinutes) {
    const gapStart = currentCursor;
    const gapEnd = dayEndMinutes;
    if (gapEnd - gapStart >= 15) {
      freeSlots.push({
        id: `free_${gapStart}_${gapEnd}`,
        start: minutesToTime(gapStart),
        end: minutesToTime(gapEnd),
        durationMinutes: gapEnd - gapStart,
        type: 'LIVRE',
        title: getPeriodLabel(gapStart, gapEnd),
        subtitle: 'Livre sem aula - Disponível para reserva',
        room: roomFilter !== 'TODAS' ? roomFilter : undefined,
      });
    }
  }

  const allSlotsChronological: DayTimeSlot[] = [...occupiedSlots, ...freeSlots].sort(
    (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)
  );

  return {
    occupiedSlots,
    freeSlots,
    allSlotsChronological,
  };
}

function getPeriodLabel(startM: number, endM: number): string {
  if (endM <= 12 * 60) return 'Manhã (Sem Aulas)';
  if (startM >= 12 * 60 && endM <= 18 * 60 + 50) return 'Tarde (Sem Aulas)';
  if (startM >= 18 * 60) return 'Noite (Sem Aulas)';
  return 'Horário Livre (Sem Aulas)';
}

export function checkReservationConflict(
  events: CalendarEvent[],
  targetDate: string,
  targetRoomName: string,
  startTime: string,
  endTime: string
): {
  hasConflict: boolean;
  conflictReason?: string;
  conflictingEvent?: CalendarEvent;
} {
  const dow = getDayOfWeekFromDate(targetDate);
  const startM = timeToMinutes(startTime);
  const endM = timeToMinutes(endTime);

  if (startM >= endM) {
    return {
      hasConflict: true,
      conflictReason: 'O horário de início deve ser anterior ao horário de término.',
    };
  }

  for (const evt of events) {
    const isSameRoom =
      evt.sala.toLowerCase().includes(targetRoomName.toLowerCase()) ||
      targetRoomName.toLowerCase().includes(evt.sala.toLowerCase());

    if (!isSameRoom) continue;

    let isSameDay = false;
    if (evt.tipo === 'RESERVA_USUARIO') {
      isSameDay = evt.data === targetDate;
    } else if (evt.tipo === 'AULA_GRADE' && dow) {
      isSameDay = evt.diaSemana === dow;
    }

    if (!isSameDay) continue;

    const evtStartM = timeToMinutes(evt.horarioInicio);
    const evtEndM = timeToMinutes(evt.horarioFim);

    const overlaps = startM < evtEndM && endM > evtStartM;

    if (overlaps) {
      const typeLabel =
        evt.tipo === 'AULA_GRADE' ? 'Aula da Grade Curricular' : 'Reserva de Espaço';
      return {
        hasConflict: true,
        conflictReason: `Conflito de horário com ${typeLabel}: "${evt.materia}" (${evt.horarioInicio} às ${evt.horarioFim}) na sala "${evt.sala}".`,
        conflictingEvent: evt,
      };
    }
  }

  return { hasConflict: false };
}

/**
 * Filtra e ajusta os intervalos livres para a janela operacional configurada pelo ADM (ou exceção da data).
 */
export function getReservableFreeSlots(
  freeSlots: DayTimeSlot[],
  dateStr?: string,
  salaFirestoreId?: string
): DayTimeSlot[] {
  const effective = dateStr
    ? getEffectiveWindowForDate(dateStr, salaFirestoreId)
    : { isClosed: false, janelaInicio: '17:00', janelaFim: '22:00' };

  if (effective.isClosed) return [];

  const minM = timeToMinutes(effective.janelaInicio);
  const maxM = timeToMinutes(effective.janelaFim);
  const reservable: DayTimeSlot[] = [];

  for (const slot of freeSlots) {
    const startM = timeToMinutes(slot.start);
    const endM = timeToMinutes(slot.end);
    const clampedStart = Math.max(startM, minM);
    const clampedEnd = Math.min(endM, maxM);

    if (clampedEnd - clampedStart >= 15) {
      reservable.push({
        id: `res_free_${clampedStart}_${clampedEnd}`,
        start: minutesToTime(clampedStart),
        end: minutesToTime(clampedEnd),
        durationMinutes: clampedEnd - clampedStart,
        type: 'LIVRE',
        title: getPeriodLabel(clampedStart, clampedEnd),
        subtitle: `Janela liberada (${effective.janelaInicio} às ${effective.janelaFim})`,
        room: slot.room,
      });
    }
  }

  return reservable;
}
