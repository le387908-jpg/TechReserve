/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AvailableSlot, CalendarEvent, DayOfWeek } from '../types';
import { isSlotActiveOrReleased } from '../store/useAvailableSlotsStore';
import { doRoomNamesMatch } from '../services/reservationService';

export interface DayTimeSlot {
  id: string;
  start: string; // HH:mm
  end: string; // HH:mm
  durationMinutes: number;
  type: 'LIVRE' | 'AULA_GRADE' | 'RESERVA_USUARIO';
  title: string;
  subtitle?: string;
  room?: string;
  availableSlotId?: string;
  event?: CalendarEvent;
}

export function timeToMinutes(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(mins: number): string {
  const safeMins = Number.isFinite(mins) ? Math.max(0, Math.floor(mins)) : 0;
  const h = Math.floor(safeMins / 60);
  const m = safeMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getDayOfWeekFromDate(dateStr: string): DayOfWeek | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y || 2000, (m || 1) - 1, d || 1, 12, 0, 0);
  if (isNaN(date.getTime())) return null;
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

/**
 * Calcula a ocupação acadêmica do dia (`AULA_GRADE` + `RESERVA_USUARIO`).
 * REGRA DE BLOQUEIO PADRÃO: Não gera intervalos "livres" automáticos.
 * Slots disponíveis só aparecem se houver registros explícitos em `availableSlots` (`liberado` ou `ativo`).
 */
export function calculateDayTimeSlots(
  dateStr: string,
  events: CalendarEvent[],
  roomFilter?: string,
  availableSlots: AvailableSlot[] = []
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

  const safeEvents = Array.isArray(events) ? events : [];
  const safeAvailableSlots = Array.isArray(availableSlots) ? availableSlots : [];

  const relevantEvents = safeEvents.filter((evt) => {
    if (!evt) return false;
    if (roomFilter && roomFilter !== 'TODAS') {
      if (!doRoomNamesMatch(evt.sala || '', roomFilter)) return false;
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
      const startM = Math.max(dayStartMinutes, timeToMinutes(evt.horarioInicio || ''));
      const endM = Math.min(dayEndMinutes, timeToMinutes(evt.horarioFim || ''));
      return {
        startM,
        endM,
        evt,
      };
    })
    .filter((item) => item.endM > item.startM);

  occupiedRaw.sort((a, b) => a.startM - b.startM);

  const occupiedSlots: DayTimeSlot[] = occupiedRaw.map((item, idx) => ({
    id: `occ_${idx}_${item.evt.id || idx}`,
    start: minutesToTime(item.startM),
    end: minutesToTime(item.endM),
    durationMinutes: item.endM - item.startM,
    type: item.evt.tipo,
    title: item.evt.materia || 'Atividade Acadêmica',
    subtitle:
      item.evt.tipo === 'AULA_GRADE'
        ? `Prof. ${item.evt.professor || 'Docente'}`
        : `Solicitante: ${item.evt.solicitante || 'Usuário'}`,
    room: item.evt.sala || '',
    event: item.evt,
  }));

  // Apenas slots explicitamente liberados pelo ADM em `available_slots` para esta data (sem conflito)
  const freeSlots: DayTimeSlot[] = safeAvailableSlots
    .filter((slot) => {
      if (!slot || slot.data !== dateStr) return false;
      if (!isSlotActiveOrReleased(slot)) return false;
      if (roomFilter && roomFilter !== 'TODAS') {
        if (!doRoomNamesMatch(slot.salaNome || '', roomFilter)) return false;
      }

      const sStart = timeToMinutes(slot.inicio || '');
      const sEnd = timeToMinutes(slot.fim || '');
      if (sEnd <= sStart) return false;

      const hasRoomConflict = occupiedRaw.some((occ) => {
        if (!doRoomNamesMatch(occ.evt.sala || '', slot.salaNome || '')) return false;
        return sStart < occ.endM && sEnd > occ.startM;
      });
      return !hasRoomConflict;
    })
    .map((slot) => {
      const sStart = timeToMinutes(slot.inicio || '');
      const sEnd = timeToMinutes(slot.fim || '');
      return {
        id: `released_${slot.id}`,
        availableSlotId: slot.id,
        start: slot.inicio,
        end: slot.fim,
        durationMinutes: sEnd - sStart,
        type: 'LIVRE' as const,
        title: slot.label || 'Horário Liberado pela Coordenação',
        subtitle: `Disponível para agendamento (${slot.salaNome || 'Ambiente'})`,
        room: slot.salaNome || '',
      };
    })
    .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

  const allSlotsChronological: DayTimeSlot[] = [...occupiedSlots, ...freeSlots].sort(
    (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)
  );

  return {
    occupiedSlots,
    freeSlots,
    allSlotsChronological,
  };
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

  const safeEvents = Array.isArray(events) ? events : [];
  for (const evt of safeEvents) {
    if (!evt || !doRoomNamesMatch(evt.sala || '', targetRoomName || '')) continue;

    let isSameDay = false;
    if (evt.tipo === 'RESERVA_USUARIO') {
      isSameDay = evt.data === targetDate;
    } else if (evt.tipo === 'AULA_GRADE' && dow) {
      isSameDay = evt.diaSemana === dow;
    }

    if (!isSameDay) continue;

    const evtStartM = timeToMinutes(evt.horarioInicio || '');
    const evtEndM = timeToMinutes(evt.horarioFim || '');

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
 * Retorna exclusivamente os slots que já vieram de `available_slots` com status liberado/ativo.
 */
export function getReservableFreeSlots(freeSlots: DayTimeSlot[]): DayTimeSlot[] {
  return Array.isArray(freeSlots) ? freeSlots : [];
}
