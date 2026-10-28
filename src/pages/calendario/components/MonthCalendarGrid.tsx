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
  Sparkles,
  Layers,
  ArrowRight,
  Sun,
  Sunset,
  Moon,
  AlertCircle
} from 'lucide-react';
import { CalendarEvent, DayOfWeek, CalendarCourse } from '../../../types';
import { cn } from '../../../lib/utils';
import { calculateDayTimeSlots, DayTimeSlot } from '../../../utils/calendarTimeSlots';

interface MonthCalendarGridProps {
  currentDate: Date;
  onMonthChange: (newDate: Date) => void;
  selectedDateStr: string; // YYYY-MM-DD
  onSelectDate: (dateStr: string) => void;
  events: CalendarEvent[];
  onSelectEvent: (event: CalendarEvent) => void;
  onNewReservationOnDate: (dateStr: string, startTime?: string) => void;
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
  onSelectEvent,
  onNewReservationOnDate,
  selectedCourse,
  selectedSemester,
  isAdmin,
  onApproveReservation,
  onCancelReservation,
}: MonthCalendarGridProps) {
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
    return events.filter(evt => {
      // If it's a reservation, it must match the exact date
      if (evt.tipo === 'RESERVA_USUARIO') {
        return evt.data === dateString;
      }
      // If it's a fixed curriculum class, it occurs on this day of week
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
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    return getDayOfWeekName(dateObj.getDay());
  }, [selectedDateStr]);

  const selectedDateEvents = React.useMemo(() => {
    if (!selectedDateStr) return [];
    return eventsForDate(selectedDateStr, selectedDayOfWeek).sort((a, b) => 
      a.horarioInicio.localeCompare(b.horarioInicio)
    );
  }, [selectedDateStr, selectedDayOfWeek, events]);

  const timeSlotsInfo = React.useMemo(() => {
    if (!selectedDateStr) {
      return { occupiedSlots: [], freeSlots: [], allSlotsChronological: [] };
    }
    return calculateDayTimeSlots(selectedDateStr, events);
  }, [selectedDateStr, events]);

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
              Calendário acadêmico e reservas de salas em tempo real
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

      {/* 7-COLUMN MONTH GRID (Formato de Calendário Tradicional) */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        {/* WEEKDAYS HEADER */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/80 text-center">
          {WEEKDAYS.map((day, idx) => (
            <div 
              key={day} 
              className={cn(
                "py-3 text-xs font-black tracking-wider uppercase",
                idx === 0 ? "text-slate-400" : "text-slate-700"
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

            // Separate classes and reservations
            const gradeClasses = dayEvents.filter(e => e.tipo === 'AULA_GRADE');
            const userReservations = dayEvents.filter(e => e.tipo === 'RESERVA_USUARIO');

            return (
              <div
                key={cell.dateString + index}
                onClick={() => onSelectDate(cell.dateString)}
                className={cn(
                  "min-h-[105px] md:min-h-[120px] p-2 md:p-2.5 transition-all relative flex flex-col justify-between group cursor-pointer",
                  cell.isCurrentMonth ? "bg-white hover:bg-slate-50/80" : "bg-slate-50/40 opacity-40 hover:opacity-75",
                  isSelected && "ring-2 ring-inset ring-fatec-red bg-rose-50/20",
                  cell.isToday && "bg-amber-50/30"
                )}
              >
                {/* CELL TOP: DATE NUMBER & BADGES */}
                <div className="flex items-center justify-between mb-1.5">
                  <span
                    className={cn(
                      "text-xs font-bold h-6 w-6 rounded-full flex items-center justify-center transition-all",
                      cell.isToday
                        ? "bg-fatec-red text-white font-black shadow-xs"
                        : isSelected
                        ? "bg-slate-900 text-white font-black"
                        : cell.isCurrentMonth
                        ? "text-slate-800"
                        : "text-slate-400"
                    )}
                  >
                    {cell.dayNum}
                  </span>

                  {/* QUICK RESERVATION BUTTON ON CELL HOVER */}
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
                </div>

                {/* EVENTS PREVIEWS (CHIPS) */}
                <div className="space-y-1 flex-1 overflow-hidden">
                  {/* Real-time active reservations first (RED) */}
                  {userReservations.slice(0, 2).map((res) => (
                    <div
                      key={res.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(res);
                      }}
                      className="bg-rose-100 hover:bg-rose-200 border border-rose-300 text-rose-950 px-1.5 py-0.5 rounded text-[10px] font-bold truncate flex items-center gap-1 transition-colors cursor-pointer shadow-2xs"
                      title={`${res.materia} (${res.horarioInicio} às ${res.horarioFim}) - ${res.sala}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-fatec-red shrink-0" />
                      <span className="font-mono text-[8.5px] font-black text-rose-800 shrink-0">{res.horarioInicio}-{res.horarioFim}</span>
                      <span className="truncate">{res.materia}</span>
                    </div>
                  ))}

                  {/* Curriculum classes (GREEN) */}
                  {gradeClasses.slice(0, 2 - Math.min(userReservations.length, 2)).map((aula) => (
                    <div
                      key={aula.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(aula);
                      }}
                      className="bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/90 text-emerald-950 px-1.5 py-0.5 rounded text-[10px] font-bold truncate flex items-center gap-1 transition-colors cursor-pointer shadow-2xs"
                      title={`${aula.materia} (${aula.horarioInicio} às ${aula.horarioFim}) - Prof. ${aula.professor}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="font-mono text-[8.5px] font-black text-emerald-700 shrink-0">{aula.horarioInicio}-{aula.horarioFim}</span>
                      <span className="truncate">{aula.materia}</span>
                    </div>
                  ))}

                  {/* More events indicator if count > 2 */}
                  {dayEvents.length > 2 && (
                    <p className="text-[9px] font-black text-slate-500 hover:text-slate-900 pt-0.5 px-0.5">
                      +{dayEvents.length - 2} mais
                    </p>
                  )}
                </div>

                {/* BOTTOM ACCENT: EMPTY OR SUNDAY INDICATOR */}
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

      {/* SELECTED DAY DETAILED PANEL (HORÁRIOS OCUPADOS & HORÁRIOS LIVRES) */}
      {selectedDateStr && (
        <div className="bg-white rounded-3xl border border-slate-200 p-5 md:p-6 shadow-sm space-y-6">
          {/* HEADER DO DIA SELECIONADO */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-black uppercase tracking-wider text-fatec-red">
                  Visão Diária de Horários:
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
                  year: 'numeric' 
                })}
              </h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Consulte os horários ocupados por aulas e as janelas livres para agendamento seguro de salas.
              </p>
            </div>

            <button
              type="button"
              onClick={() => onNewReservationOnDate(selectedDateStr)}
              className="px-4 py-2 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-2 self-start sm:self-auto"
            >
              <Plus className="h-4 w-4 text-fatec-red" />
              Nova Reserva neste Dia
            </button>
          </div>

          {/* 1. RÉGUA / BARRA VISUAL DA LINHA DO TEMPO (08:00 ÀS 22:30) */}
          {selectedDayOfWeek !== null && (
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/80 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-slate-600" />
                  <span className="text-xs font-black uppercase tracking-wider text-slate-800">
                    Ocupação do Dia (08:00 às {selectedDayOfWeek === 'Sábado' ? '13:00' : '22:30'})
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] font-bold text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                    Aula da Grade
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-rose-500" />
                    Reserva Ativa
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-sky-400" />
                    Horário Livre
                  </span>
                </div>
              </div>

              {/* TIMELINE PROGRESSION BAR */}
              <div className="h-6 w-full bg-slate-200 rounded-lg overflow-hidden flex shadow-inner">
                {timeSlotsInfo.allSlotsChronological.map((slot) => {
                  const totalMinutes = selectedDayOfWeek === 'Sábado' ? (13 - 8) * 60 : (22.5 - 8) * 60;
                  const widthPercent = Math.max(4, (slot.durationMinutes / totalMinutes) * 100);
                  const isFree = slot.type === 'LIVRE';
                  const isGrade = slot.type === 'AULA_GRADE';

                  return (
                    <div
                      key={slot.id}
                      style={{ width: `${widthPercent}%` }}
                      className={cn(
                        "h-full transition-all flex items-center justify-center text-[9px] font-mono font-bold px-1 truncate cursor-pointer",
                        isFree 
                          ? "bg-sky-400 hover:bg-sky-500 text-white" 
                          : isGrade 
                          ? "bg-emerald-600 hover:bg-emerald-700 text-white" 
                          : "bg-rose-600 hover:bg-rose-700 text-white"
                      )}
                      title={`${slot.start} às ${slot.end}: ${slot.title} (${isFree ? 'Livre' : 'Ocupado'})`}
                      onClick={() => {
                        if (isFree) {
                          onNewReservationOnDate(selectedDateStr, slot.start);
                        } else if (slot.event) {
                          onSelectEvent(slot.event);
                        }
                      }}
                    >
                      <span className="truncate">{slot.start} - {slot.end}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] font-mono text-slate-400 px-0.5">
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

          {/* 2. HORÁRIOS LIVRES SEM AULA (DISPONÍVEIS PARA RESERVA) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center font-bold">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-slate-900">
                    Horários Livres sem Aula (Disponíveis para Reserva)
                  </h5>
                  <p className="text-[11px] text-slate-500">
                    Janelas de tempo sem aulas regulares da grade nem reservas cadastradas
                  </p>
                </div>
              </div>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200">
                {timeSlotsInfo.freeSlots.length} {timeSlotsInfo.freeSlots.length === 1 ? 'intervalo livre' : 'intervalos livres'}
              </span>
            </div>

            {timeSlotsInfo.freeSlots.length === 0 ? (
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-center text-slate-500 text-xs">
                {selectedDayOfWeek === null 
                  ? 'A instituição não possui expediente acadêmico regular aos domingos.'
                  : 'Todos os períodos deste dia estão ocupados por aulas ou reservas ativas.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {timeSlotsInfo.freeSlots.map((slot) => {
                  const isMorning = slot.start < '12:00';
                  const isAfternoon = slot.start >= '12:00' && slot.start < '18:00';
                  const Icon = isMorning ? Sun : isAfternoon ? Sunset : Moon;

                  return (
                    <div
                      key={slot.id}
                      className="p-3.5 rounded-2xl border border-sky-200/90 bg-sky-50/50 hover:bg-sky-50 hover:border-sky-300 transition-all flex flex-col justify-between gap-3 shadow-2xs group"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-sky-200/80 text-sky-900 flex items-center gap-1 w-fit mb-1.5">
                            <Icon className="h-3 w-3 text-sky-700" />
                            {slot.title}
                          </span>
                          <div className="text-base font-black text-slate-900 font-mono tracking-tight flex items-center gap-1.5">
                            <Clock className="h-4 w-4 text-sky-600" />
                            {slot.start} às {slot.end}
                          </div>
                          <p className="text-[11px] text-slate-600 font-medium mt-0.5">
                            {slot.subtitle} ({Math.floor(slot.durationMinutes / 60)}h{slot.durationMinutes % 60 ? `${slot.durationMinutes % 60}m` : ''} de duração)
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onNewReservationOnDate(selectedDateStr, slot.start)}
                        className="w-full py-2 px-3 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold transition-all shadow-xs flex items-center justify-center gap-1.5"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Reservar este Horário ({slot.start})
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. HORÁRIOS OCUPADOS (AULAS DA GRADE & RESERVAS REGISTRADAS) */}
          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center font-bold">
                  <Building2 className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-slate-900">
                    Horários Ocupados no Dia (Aulas e Reservas)
                  </h5>
                  <p className="text-[11px] text-slate-500">
                    Horários em que as salas estão indisponíveis por aula regular ou reserva prévia
                  </p>
                </div>
              </div>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                {selectedDateEvents.length} {selectedDateEvents.length === 1 ? 'atividade' : 'atividades'}
              </span>
            </div>

            {selectedDateEvents.length === 0 ? (
              <div className="py-6 text-center text-slate-400 bg-slate-50/50 rounded-2xl border border-slate-100">
                <p className="text-xs font-bold text-slate-600">Nenhuma aula da grade ou reserva agendada para esta data.</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Todas as salas e laboratórios estão 100% livres para agendamento.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {selectedDateEvents.map((evt) => {
                  const isGrade = evt.tipo === 'AULA_GRADE';
                  return (
                    <div
                      key={evt.id}
                      onClick={() => onSelectEvent(evt)}
                      className={cn(
                        "p-4 rounded-2xl border text-left cursor-pointer transition-all duration-200 relative group hover:shadow-md",
                        isGrade
                          ? "bg-emerald-50/70 border-emerald-200/90 hover:border-emerald-400 text-emerald-950"
                          : "bg-rose-50/80 border-rose-200/90 hover:border-rose-400 text-rose-950"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <span className={cn(
                          "text-[9px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider",
                          isGrade ? "bg-emerald-200/80 text-emerald-900" : "bg-rose-200 text-rose-900"
                        )}>
                          {isGrade ? '🟩 Grade Oficial' : '🟥 Reserva Ativa'}
                        </span>
                        <span className="text-xs font-mono font-black text-slate-800 flex items-center gap-1">
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
                            <GraduationCap className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
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

                      {/* ADMIN ACTIONS ON CARD */}
                      {isAdmin && !isGrade && evt.status === 'Pendente' && onApproveReservation && (
                        <div className="mt-3 pt-2.5 border-t border-rose-200/80 flex items-center justify-between">
                          <span className="text-[9px] font-black text-amber-700 uppercase">Pendente</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (evt.reservationId) {
                                onApproveReservation(evt.reservationId);
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-all flex items-center gap-1"
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
