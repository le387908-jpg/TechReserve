/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Clock,
  Building2,
  Plus,
  CheckCircle2,
  GraduationCap,
  User,
  Lock,
  Unlock,
} from 'lucide-react';
import { CalendarEvent, DayOfWeek, CalendarCourse, Room } from '../../../types';
import { cn } from '../../../lib/utils';
import { calculateDayTimeSlots, timeToMinutes } from '../../../utils/calendarTimeSlots';
import {
  isSlotActiveOrReleased,
  matchesSlotRoom,
  useAvailableSlotsStore,
} from '../../../store/useAvailableSlotsStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useReservationStore } from '../../../store/useReservationStore';
import { useScheduleStore } from '../../../store/useScheduleStore';
import {
  doRoomNamesMatch,
  getRoomScheduleSlotsForDate,
  RoomScheduleSlotView,
  UNAVAILABLE_AWAITING_RELEASE_LABEL,
} from '../../../services/reservationService';
import { getFriendlyErrorMessage } from '../../../services/firebase/utils';
import { toast } from 'sonner';

interface MonthCalendarGridProps {
  currentDate: Date;
  onMonthChange: (newDate: Date) => void;
  selectedDateStr: string; // YYYY-MM-DD
  onSelectDate: (dateStr: string) => void;
  events: CalendarEvent[];
  rooms: Room[];
  selectedRoomId: string;
  onSelectEvent: (event: CalendarEvent) => void;
  onNewReservationOnDate: (dateStr: string, startTime?: string, roomName?: string) => void;
  selectedCourse: CalendarCourse;
  selectedSemester: number;
  isAdmin: boolean;
  onApproveReservation?: (id: string) => Promise<void>;
  onCancelReservation?: (id: string) => Promise<void>;
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function getDayOfWeekName(dayIndex: number): DayOfWeek | null {
  const map: Record<number, DayOfWeek | null> = {
    0: null, // Domingo (sem aulas regulares)
    1: 'Segunda',
    2: 'Terça',
    3: 'Quarta',
    4: 'Quinta',
    5: 'Sexta',
    6: 'Sábado',
  };
  return map[dayIndex] || null;
}

export function MonthCalendarGrid({
  currentDate,
  onMonthChange,
  selectedDateStr,
  onSelectDate,
  events,
  rooms,
  selectedRoomId,
  onSelectEvent,
  onNewReservationOnDate,
  selectedCourse,
  selectedSemester,
  isAdmin,
  onApproveReservation,
}: MonthCalendarGridProps) {
  const currentUser = useAuthStore((state) => state.user);
  const rawAvailableSlots = useAvailableSlotsStore((state) => state.slots);
  const rawReservations = useReservationStore((state) => state.reservations);
  const scheduleConfig = useScheduleStore((state) => state.config);
  const rawScheduleExceptions = useScheduleStore((state) => state.exceptions);

  const safeEvents = Array.isArray(events) ? events : [];
  const safeRooms = Array.isArray(rooms) ? rooms : [];
  const availableSlots = Array.isArray(rawAvailableSlots) ? rawAvailableSlots : [];
  const reservations = Array.isArray(rawReservations) ? rawReservations : [];
  const scheduleExceptions = Array.isArray(rawScheduleExceptions) ? rawScheduleExceptions : [];

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const todayStr = new Date().toLocaleDateString('en-CA');

  // Compute days in month and starting offset
  const firstDayOfMonth = new Date(year, month, 1);
  const startingDayOfWeek = firstDayOfMonth.getDay(); // 0 = Dom, 1 = Seg...
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  // Navigation handlers
  const handlePrevMonth = () => {
    onMonthChange(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    onMonthChange(new Date(year, month + 1, 1));
  };

  const handleToday = () => {
    const now = new Date();
    onMonthChange(new Date(now.getFullYear(), now.getMonth(), 1));
    onSelectDate(todayStr);
  };

  // Build 35 or 42 grid cells
  const totalSlots = startingDayOfWeek + daysInMonth <= 35 ? 35 : 42;
  const gridCells = [];

  // Previous month trailing days
  for (let i = startingDayOfWeek - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const prevDate = new Date(year, month - 1, dayNum);
    const dateString = prevDate.toLocaleDateString('en-CA');
    const dow = getDayOfWeekName(prevDate.getDay());
    gridCells.push({
      dateString,
      dayNum,
      isCurrentMonth: false,
      isToday: dateString === todayStr,
      dayOfWeek: dow,
    });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const thisDate = new Date(year, month, d);
    const dateString = thisDate.toLocaleDateString('en-CA');
    const dow = getDayOfWeekName(thisDate.getDay());
    gridCells.push({
      dateString,
      dayNum: d,
      isCurrentMonth: true,
      isToday: dateString === todayStr,
      dayOfWeek: dow,
    });
  }

  // Next month leading days
  const remainingSlots = totalSlots - gridCells.length;
  for (let d = 1; d <= remainingSlots; d++) {
    const nextDate = new Date(year, month + 1, d);
    const dateString = nextDate.toLocaleDateString('en-CA');
    const dow = getDayOfWeekName(nextDate.getDay());
    gridCells.push({
      dateString,
      dayNum: d,
      isCurrentMonth: false,
      isToday: dateString === todayStr,
      dayOfWeek: dow,
    });
  }

  // Map events to dateStrings
  const eventsForDate = (dateString: string, dayOfWeek: DayOfWeek | null) => {
    return safeEvents.filter((evt) => {
      if (!evt) return false;
      if (evt.tipo === 'RESERVA_USUARIO') {
        return evt.data === dateString;
      }
      if (evt.tipo === 'AULA_GRADE' && dayOfWeek) {
        return evt.diaSemana === dayOfWeek;
      }
      return false;
    });
  };

  // Selected date events for details strip
  const selectedDayOfWeek = React.useMemo(() => {
    if (!selectedDateStr) return null;
    const [y, m, d] = selectedDateStr.split('-').map(Number);
    if (!y || !m || !d) return null;
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    return getDayOfWeekName(dateObj.getDay());
  }, [selectedDateStr]);

  const selectedDateEvents = React.useMemo(() => {
    if (!selectedDateStr) return [];
    return eventsForDate(selectedDateStr, selectedDayOfWeek).sort((a, b) =>
      (a?.horarioInicio || '').localeCompare(b?.horarioInicio || '')
    );
  }, [selectedDateStr, selectedDayOfWeek, safeEvents]);

  const timeSlotsInfo = React.useMemo(() => {
    if (!selectedDateStr) {
      return { occupiedSlots: [], freeSlots: [], allSlotsChronological: [] };
    }
    return calculateDayTimeSlots(
      selectedDateStr,
      safeEvents,
      selectedRoomId !== 'TODAS' ? selectedRoomId : undefined
    );
  }, [selectedDateStr, safeEvents, selectedRoomId]);

  const scopedRooms = React.useMemo(
    () =>
      selectedRoomId !== 'TODAS'
        ? safeRooms.filter(
            (r) =>
              r &&
              (doRoomNamesMatch(r.nome || '', selectedRoomId) ||
                r.id === selectedRoomId ||
                r.firestoreId === selectedRoomId)
          )
        : safeRooms,
    [safeRooms, selectedRoomId]
  );

  const releasedCountByDate = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const slot of availableSlots) {
      if (!slot?.data || slot.data < todayStr || !isSlotActiveOrReleased(slot)) continue;
      const roomMatch = scopedRooms.some((r) => matchesSlotRoom(slot, r));
      if (!roomMatch) continue;
      map.set(slot.data, (map.get(slot.data) || 0) + 1);
    }
    return map;
  }, [availableSlots, scopedRooms, todayStr]);

  // Calcula estritamente os horários liberados pelo ADM em `available_slots` para a data selecionada
  const releasedSlotsForSelectedDate = React.useMemo(() => {
    if (!selectedDateStr || selectedDateStr < todayStr) return [];

    const results: { room: Room; slot: RoomScheduleSlotView }[] = [];

    for (const room of scopedRooms) {
      const scheduleView = getRoomScheduleSlotsForDate({
        room,
        dateISO: selectedDateStr,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        currentUserId: currentUser?.id,
      });

      for (const slot of scheduleView.slots) {
        if (slot.selectableForUser) {
          results.push({ room, slot });
        }
      }
    }

    return results.sort((a, b) => {
      if (a.slot.inicio !== b.slot.inicio) {
        return (a.slot.inicio || '').localeCompare(b.slot.inicio || '');
      }
      return (a.room?.nome || '').localeCompare(b.room?.nome || '');
    });
  }, [
    selectedDateStr,
    todayStr,
    scopedRooms,
    scheduleConfig,
    scheduleExceptions,
    availableSlots,
    reservations,
    currentUser?.id,
  ]);

  return (
    <div className="space-y-4">
      {/* CALENDAR HEADER WITH MONTH NAVIGATION */}
      <div className="bg-white rounded-3xl border border-slate-200 p-4 md:p-5 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-black shadow-sm">
            <CalendarIcon className="h-5 w-5 text-fatec-red" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl md:text-2xl font-black text-slate-900 tracking-tight">
                {MONTH_NAMES[month]} {year}
              </h3>
              <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                {selectedCourse} • {selectedSemester}º Semestre
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium">
              Grade acadêmica regular e ocupação de espaços em tempo real
            </p>
          </div>
        </div>

        {/* MONTH SWITCHER CONTROLS */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToday}
            className="px-3.5 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-all"
          >
            Hoje
          </button>
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-1.5 rounded-lg text-slate-700 hover:bg-white hover:shadow-2xs transition-all"
              title="Mês anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-1.5 rounded-lg text-slate-700 hover:bg-white hover:shadow-2xs transition-all"
              title="Próximo mês"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 7-COLUMN MONTH GRID */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        {/* WEEKDAYS HEADER */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/80 text-center">
          {WEEKDAYS.map((day, idx) => (
            <div
              key={day}
              className={cn(
                'py-3 text-xs font-black tracking-wider uppercase',
                idx === 0 ? 'text-slate-400' : 'text-slate-700'
              )}
            >
              {day}
            </div>
          ))}
        </div>

        {/* DAYS GRID CELLS */}
        <div className="grid grid-cols-7 divide-x divide-y divide-slate-100">
          {gridCells.map((cell, index) => {
            const dayEvents = eventsForDate(cell.dateString, cell.dayOfWeek);
            const isSelected = cell.dateString === selectedDateStr;
            const isSunday = cell.dayOfWeek === null;

            const gradeClasses = dayEvents.filter((e) => e.tipo === 'AULA_GRADE');
            const userReservations = dayEvents.filter((e) => e.tipo === 'RESERVA_USUARIO');

            return (
              <div
                key={cell.dateString + index}
                onClick={() => onSelectDate(cell.dateString)}
                className={cn(
                  'min-h-[105px] md:min-h-[120px] p-2 md:p-2.5 transition-all relative flex flex-col justify-between group cursor-pointer',
                  cell.isCurrentMonth
                    ? 'bg-white hover:bg-slate-50/80'
                    : 'bg-slate-50/40 opacity-40 hover:opacity-75',
                  isSelected && 'ring-2 ring-inset ring-fatec-red bg-rose-50/20',
                  cell.isToday && 'bg-amber-50/30'
                )}
              >
                {/* CELL TOP: DATE NUMBER & ADM QUICK ACTION */}
                <div className="flex items-center justify-between mb-1.5">
                  <span
                    className={cn(
                      'text-xs font-bold h-6 w-6 rounded-full flex items-center justify-center transition-all tabular-nums',
                      cell.isToday
                        ? 'bg-fatec-red text-white font-black shadow-xs'
                        : isSelected
                        ? 'bg-slate-900 text-white font-black'
                        : cell.isCurrentMonth
                        ? 'text-slate-800'
                        : 'text-slate-400'
                    )}
                  >
                    {cell.dayNum}
                  </span>

                  {isAdmin && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewReservationOnDate(cell.dateString);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded-md bg-slate-100 hover:bg-fatec-red hover:text-white text-slate-500 transition-all"
                      title={`Reservar sala em ${cell.dateString}`}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* EVENTS PREVIEWS (CHIPS) */}
                <div className="space-y-1 flex-1 overflow-hidden">
                  {/* ADM-released available slots indicator ("Disponível") */}
                  {(releasedCountByDate.get(cell.dateString) || 0) > 0 && (
                    <div
                      className="bg-amber-50 border border-amber-400 text-amber-950 px-1.5 py-0.5 rounded text-[9.5px] font-black truncate flex items-center justify-between gap-1 shadow-2xs"
                      title={`${releasedCountByDate.get(cell.dateString)} horário(s) liberado(s) pela coordenação`}
                    >
                      <span className="truncate">Disponível</span>
                      <span className="font-mono tabular-nums text-[9px] shrink-0">
                        {releasedCountByDate.get(cell.dateString)}
                      </span>
                    </div>
                  )}

                  {/* Real-time active reservations: Green = Sua Reserva, Red = Reservado */}
                  {userReservations.slice(0, 2).map((res) => {
                    const isOwn = Boolean(currentUser?.id && res.usuarioId === currentUser.id);
                    const canOpen = isAdmin || isOwn;
                    return (
                      <div
                        key={res.id}
                        onClick={(e) => {
                          if (canOpen) {
                            e.stopPropagation();
                            onSelectEvent(res);
                          }
                        }}
                        className={cn(
                          'border px-1.5 py-0.5 rounded text-[10px] font-bold truncate flex items-center gap-1 transition-colors shadow-2xs',
                          isOwn
                            ? 'bg-emerald-50 hover:bg-emerald-100 border-emerald-300 text-emerald-950 cursor-pointer'
                            : cn(
                                'bg-rose-50 border-rose-200 text-rose-950',
                                isAdmin ? 'hover:bg-rose-100 cursor-pointer' : 'cursor-default'
                              )
                        )}
                        title={`${isOwn ? 'Sua Reserva' : 'Reservado'}: ${res.materia} (${res.horarioInicio} às ${res.horarioFim}) - ${res.sala}`}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full shrink-0',
                            isOwn ? 'bg-emerald-600' : 'bg-rose-600'
                          )}
                        />
                        <span
                          className={cn(
                            'font-mono text-[8.5px] font-black shrink-0 tabular-nums',
                            isOwn ? 'text-emerald-800' : 'text-rose-800'
                          )}
                        >
                          {res.horarioInicio}-{res.horarioFim}
                        </span>
                        <span className="truncate">
                          {isOwn ? 'Sua Reserva' : res.materia}
                        </span>
                      </div>
                    );
                  })}

                  {/* Curriculum classes: Blue = Ocupado */}
                  {gradeClasses
                    .slice(0, 2 - Math.min(userReservations.length, 2))
                    .map((aula) => (
                      <div
                        key={aula.id}
                        onClick={(e) => {
                          if (isAdmin) {
                            e.stopPropagation();
                            onSelectEvent(aula);
                          }
                        }}
                        className={cn(
                          'bg-blue-50 border border-blue-200 text-blue-950 px-1.5 py-0.5 rounded text-[10px] font-bold truncate flex items-center gap-1 transition-colors shadow-2xs',
                          isAdmin ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-default'
                        )}
                        title={`Ocupado (Aula): ${aula.materia} (${aula.horarioInicio} às ${aula.horarioFim}) - Prof. ${aula.professor}`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-600 shrink-0" />
                        <span className="font-mono text-[8.5px] font-black text-blue-800 shrink-0 tabular-nums">
                          {aula.horarioInicio}-{aula.horarioFim}
                        </span>
                        <span className="truncate">{aula.materia}</span>
                      </div>
                    ))}

                  {dayEvents.length > 2 && (
                    <p className="text-[9px] font-black text-slate-500 hover:text-slate-900 pt-0.5 px-0.5 tabular-nums">
                      +{dayEvents.length - 2} mais
                    </p>
                  )}
                </div>

                {isSunday && dayEvents.length === 0 && (
                  <span className="text-[9px] text-slate-300 text-center font-medium block">
                    Sem aulas
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* SELECTED DAY DETAILED PANEL (GRADE DE AULAS + SLOTS LIBERADOS PELO ADM) */}
      {selectedDateStr && (
        <div className="bg-white rounded-3xl border border-slate-200 p-5 md:p-6 shadow-sm space-y-6">
          {/* HEADER DO DIA SELECIONADO */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-black uppercase tracking-wider text-fatec-red">
                  Ocupação da Grade Acadêmica:
                </span>
                <span className="text-xs font-bold text-slate-500">
                  {selectedDayOfWeek ? `${selectedDayOfWeek}-feira` : 'Domingo (Sem expediente)'}
                </span>
                <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                  {selectedCourse} • {selectedSemester}º Semestre
                </span>
              </div>
              <h4 className="text-lg md:text-xl font-black text-slate-900 tracking-tight capitalize">
                {new Date(selectedDateStr + 'T12:00:00').toLocaleDateString('pt-BR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Visualize a grade regular de aulas e confira os horários explicitamente liberados pela coordenação para reserva.
              </p>
            </div>

            {isAdmin ? (
              <button
                type="button"
                onClick={() => onNewReservationOnDate(selectedDateStr)}
                className="px-4 py-2 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-2 self-start sm:self-auto whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="h-4 w-4 text-fatec-red" />
                Nova Reserva neste Dia
              </button>
            ) : releasedSlotsForSelectedDate.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  onNewReservationOnDate(
                    selectedDateStr,
                    releasedSlotsForSelectedDate[0].slot.inicio,
                    releasedSlotsForSelectedDate[0].room.nome
                  )
                }
                className="px-4 py-2 rounded-2xl bg-amber-400 hover:bg-amber-500 text-slate-950 text-xs font-black transition-all shadow-sm flex items-center gap-2 self-start sm:self-auto whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Unlock className="h-4 w-4" />
                Horários Disponíveis ({releasedSlotsForSelectedDate.length})
              </button>
            ) : (
              <div className="px-3.5 py-2 rounded-2xl bg-slate-100 border border-slate-200 text-slate-500 text-xs font-semibold flex items-center gap-2 self-start sm:self-auto whitespace-nowrap shrink-0">
                <Lock className="h-3.5 w-3.5 text-slate-400" />
                <span>Indisponível · Aguardando liberação</span>
              </div>
            )}
          </div>

          {/* 1. RÉGUA DE OCUPAÇÃO DA GRADE ACADÊMICA (SOMENTE AULAS E RESERVAS ATIVAS) */}
          {selectedDayOfWeek !== null && timeSlotsInfo.occupiedSlots.length > 0 && (
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/80 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-slate-600" />
                  <span className="text-xs font-black uppercase tracking-wider text-slate-800">
                    Ocupação da Grade no Dia (08:00 às{' '}
                    {selectedDayOfWeek === 'Sábado' ? '13:00' : '22:30'})
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[10px] font-bold text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-blue-600" />
                    Ocupado (Aula)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-emerald-600" />
                    Sua Reserva
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-rose-600" />
                    Reservado
                  </span>
                </div>
              </div>

              {/* TIMELINE PROGRESSION BAR (ONLY OCCUPIED BLOCKS ON NEUTRAL TRACK) */}
              <div className="h-6 w-full bg-slate-200/80 rounded-lg overflow-hidden relative">
                {timeSlotsInfo.occupiedSlots.map((slot) => {
                  const minStart = 7 * 60 + 40;
                  const maxEnd = selectedDayOfWeek === 'Sábado' ? 13 * 60 + 30 : 22 * 60 + 30;
                  const spanMinutes = maxEnd - minStart;
                  const sMin = Math.max(minStart, timeToMinutes(slot.start));
                  const eMin = Math.min(maxEnd, timeToMinutes(slot.end));
                  const leftPct = ((sMin - minStart) / spanMinutes) * 100;
                  const widthPct = Math.max(3, ((eMin - sMin) / spanMinutes) * 100);
                  const isGrade = slot.type === 'AULA_GRADE';
                  const isOwn =
                    !isGrade && Boolean(currentUser?.id && slot.event?.usuarioId === currentUser.id);
                  const canClick = isAdmin || isOwn;

                  return (
                    <div
                      key={slot.id}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      className={cn(
                        'absolute top-0 bottom-0 transition-opacity flex items-center justify-center text-[9px] font-mono tabular-nums font-bold px-1 truncate border-r border-white/30',
                        isGrade
                          ? 'bg-blue-600 text-white'
                          : isOwn
                          ? 'bg-emerald-600 text-white'
                          : 'bg-rose-600 text-white',
                        canClick ? 'cursor-pointer hover:opacity-90' : 'cursor-not-allowed'
                      )}
                      title={`${isGrade ? 'Ocupado' : isOwn ? 'Sua Reserva' : 'Reservado'} — ${slot.start} às ${slot.end}: ${slot.title} (${slot.room || ''})`}
                      onClick={() => {
                        if (canClick && slot.event) {
                          onSelectEvent(slot.event);
                        }
                      }}
                    >
                      <span className="truncate">
                        {slot.start}-{slot.end}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] font-mono tabular-nums text-slate-400 px-0.5">
                <span>08:00</span>
                <span>12:00</span>
                {selectedDayOfWeek !== 'Sábado' && (
                  <>
                    <span>16:00</span>
                    <span>19:00</span>
                    <span>22:30</span>
                  </>
                )}
                {selectedDayOfWeek === 'Sábado' && <span>13:00</span>}
              </div>
            </div>
          )}

          {/* 2. HORÁRIOS LIBERADOS PELA COORDENAÇÃO (`available_slots`) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-6 w-6 rounded-lg flex items-center justify-center font-bold',
                    releasedSlotsForSelectedDate.length > 0
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : 'bg-slate-100 text-slate-500'
                  )}
                >
                  {releasedSlotsForSelectedDate.length > 0 ? (
                    <Unlock className="h-3.5 w-3.5" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                </span>
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-slate-900">
                    Horários Liberados pelo ADM (Disponíveis)
                  </h5>
                  <p className="text-[11px] text-slate-500">
                    Clique em um horário com status Disponível para efetuar a reserva imediatamente
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-mono tabular-nums font-semibold text-slate-600">
                {releasedSlotsForSelectedDate.length}{' '}
                {releasedSlotsForSelectedDate.length === 1 ? 'disponível' : 'disponíveis'}
              </span>
            </div>

            {releasedSlotsForSelectedDate.length === 0 ? (
              <div className="p-4 rounded-2xl bg-slate-100/80 border border-slate-200 flex items-start gap-3">
                <Lock className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-black uppercase tracking-wider">
                      Indisponível
                    </span>
                    <p className="text-xs font-bold text-slate-700">
                      {UNAVAILABLE_AWAITING_RELEASE_LABEL}
                    </p>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Horários não liberados permanecem bloqueados por padrão até liberação explícita pela coordenação.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {releasedSlotsForSelectedDate.map(({ room, slot }) => (
                  <div
                    key={`${room.firestoreId}_${slot.key}`}
                    className="p-3.5 rounded-2xl border-2 border-amber-400 bg-amber-50/35 hover:bg-amber-50/75 hover:border-amber-500 transition-colors flex flex-col justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-bold text-slate-900 truncate">{room.nome}</span>
                        <span className="px-2 py-0.5 rounded-md bg-amber-400 text-slate-950 text-[10px] font-black uppercase tracking-wider shrink-0">
                          Disponível
                        </span>
                      </div>
                      <div className="text-base font-black text-slate-900 font-mono tabular-nums tracking-tight flex items-center gap-1.5">
                        <Clock className="h-4 w-4 text-amber-600" />
                        {slot.inicio} às {slot.fim}
                      </div>
                      <p className="text-[11px] text-slate-600 truncate">
                        {slot.label} · {room.andar}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        onNewReservationOnDate(selectedDateStr, slot.inicio, room.nome)
                      }
                      className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-fatec-red text-white text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Reservar este Horário
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3. OCUPAÇÃO DA GRADE ACADÊMICA & RESERVAS ATIVAS */}
          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold">
                  <GraduationCap className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-slate-900">
                    Grade de Aulas Regulares & Reservas Registradas
                  </h5>
                  <p className="text-[11px] text-slate-500">
                    Azul: Ocupado (Aula Regular) · Vermelho: Reservado · Verde: Sua Reserva
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-mono tabular-nums font-semibold text-slate-600">
                {selectedDateEvents.length}{' '}
                {selectedDateEvents.length === 1 ? 'atividade' : 'atividades'}
              </span>
            </div>

            {selectedDateEvents.length === 0 ? (
              <div className="py-6 px-4 text-center text-slate-500 bg-slate-50/60 rounded-2xl border border-slate-100">
                <p className="text-xs font-bold text-slate-700">
                  Nenhuma aula regular da grade ou reserva ativa para o filtro selecionado nesta data.
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Os espaços permanecem bloqueados por padrão até liberação explícita pela coordenação.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {selectedDateEvents.map((evt) => {
                  const isGrade = evt.tipo === 'AULA_GRADE';
                  const isOwn =
                    !isGrade && Boolean(currentUser?.id && evt.usuarioId === currentUser.id);
                  const canClick = isAdmin || isOwn;

                  return (
                    <div
                      key={evt.id}
                      role={canClick ? 'button' : undefined}
                      tabIndex={canClick ? 0 : undefined}
                      aria-disabled={!canClick}
                      onClick={() => {
                        if (canClick) onSelectEvent(evt);
                      }}
                      onKeyDown={(e) => {
                        if (canClick && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onSelectEvent(evt);
                        }
                      }}
                      className={cn(
                        'p-4 rounded-2xl border text-left transition-all duration-150 relative group',
                        isGrade
                          ? 'bg-blue-50/80 border-blue-200 text-blue-950'
                          : isOwn
                          ? 'bg-emerald-50/85 border-emerald-300 text-emerald-950'
                          : 'bg-rose-50/80 border-rose-200 text-rose-950',
                        canClick
                          ? 'cursor-pointer hover:shadow-md'
                          : 'cursor-not-allowed select-none opacity-95'
                      )}
                    >
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <span
                          className={cn(
                            'text-[9px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider whitespace-nowrap',
                            isGrade
                              ? 'bg-blue-600 text-white'
                              : isOwn
                              ? 'bg-emerald-600 text-white'
                              : 'bg-rose-600 text-white'
                          )}
                        >
                          {isGrade ? 'Ocupado' : isOwn ? 'Sua Reserva' : 'Reservado'}
                        </span>
                        <span className="text-xs font-mono tabular-nums font-black text-slate-800 flex items-center gap-1">
                          <Clock className="h-3 w-3 text-slate-400" />
                          {evt.horarioInicio} às {evt.horarioFim}
                        </span>
                      </div>

                      <h5 className="text-sm font-black leading-snug line-clamp-2 text-slate-900">
                        {evt.materia}
                      </h5>

                      <div className="mt-2 space-y-1 text-xs text-slate-600">
                        <p className="flex items-center gap-1.5 font-medium truncate">
                          {isGrade ? (
                            <GraduationCap className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                          ) : isOwn ? (
                            <User className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <User className="h-3.5 w-3.5 text-fatec-red shrink-0" />
                          )}
                          <span>{isGrade ? evt.professor : evt.solicitante}</span>
                        </p>
                        <p className="flex items-center gap-1.5 font-medium truncate">
                          <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span>{evt.sala}</span>
                        </p>
                      </div>

                      {isOwn && !isAdmin && (
                        <p className="mt-2.5 pt-2 border-t border-emerald-200/80 text-[11px] font-semibold text-emerald-800">
                          Clique para ver detalhes da sua reserva
                        </p>
                      )}

                      {isAdmin && !isGrade && evt.status === 'Pendente' && onApproveReservation && (
                        <div className="mt-3 pt-2.5 border-t border-rose-200/80 flex items-center justify-between">
                          <span className="text-[9px] font-black text-amber-700 uppercase">
                            Pendente
                          </span>
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!evt.reservationId) return;
                              try {
                                await onApproveReservation(evt.reservationId);
                                toast.success('Reserva aprovada com sucesso!');
                              } catch (err) {
                                toast.error(
                                  getFriendlyErrorMessage(err, 'Erro ao aprovar reserva.')
                                );
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-all flex items-center gap-1 cursor-pointer"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Aprovar
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
