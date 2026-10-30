/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Calendar as CalendarIcon, 
  Clock, 
  Building2, 
  GraduationCap, 
  User, 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Plus, 
  Search, 
  Layers, 
  ChevronLeft, 
  ChevronRight, 
  Sparkles,
  ShieldCheck,
  Filter,
  Info,
  ExternalLink,
  RefreshCw,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuthStore } from '../../store/useAuthStore';
import { useReservationStore } from '../../store/useReservationStore';
import { useRoomStore } from '../../store/useRoomStore';
import { CalendarCourse, DayOfWeek, CalendarEvent, Room } from '../../types';
import { GRADE_CURRICULAR_FATEC } from '../../data/gradeCurricular';
import { CalendarFilters, CalendarViewMode } from './components/CalendarFilters';
import { MonthCalendarGrid } from './components/MonthCalendarGrid';
import { EventDetailModal } from './components/EventDetailModal';
import { NewReservationModal } from './components/NewReservationModal';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../services/firebase/config';
import { isBookingWindowOpen, getReservationDateLimits } from '../../utils/reservationRules';
import { isSpaceReleasedByAdmin } from '../../services/reservationService';
import { getTodayLocalISO } from '../../utils/dateUtils';

const DAY_ORDER: DayOfWeek[] = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function getDayOfWeekFromDate(dateStr: string): DayOfWeek {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  const days: (DayOfWeek | 'Domingo')[] = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const dayName = days[date.getDay()];
  return (dayName === 'Domingo' ? 'Segunda' : dayName) as DayOfWeek;
}

/**
 * Checks if a reservation has already concluded/ended.
 * Any reservation whose scheduled date & end-time has passed is considered finished,
 * ensuring it drops off the calendar immediately and stays exclusively in the history.
 */
function isReservationFinished(res: { data: string; fim: string; status: string }, nowMs: number): boolean {
  if (
    res.status === 'CANCELADA' ||
    res.status === 'FINALIZADA' ||
    res.status === 'EXPIRADA' ||
    res.status === 'PUNIDA' ||
    res.status === 'CONCLUIDA'
  ) {
    return true;
  }
  if (!res.data || !res.fim) return false;
  try {
    const [year, month, day] = res.data.split('-').map(Number);
    const [hours, minutes] = res.fim.split(':').map(Number);
    const endDateTime = new Date(year, month - 1, day, hours, minutes, 0, 0);
    return nowMs >= endDateTime.getTime();
  } catch {
    return false;
  }
}

export function CalendarioPage() {
  const user = useAuthStore(state => state.user);
  const updateProfile = useAuthStore(state => state.updateProfile);
  const isAdmin = user?.role === 'ADMIN';

  const reservations = useReservationStore(state => state.reservations);
  const fetchReservations = useReservationStore(state => state.fetchReservations);
  const updateReservation = useReservationStore(state => state.updateReservation);
  const deleteReservation = useReservationStore(state => state.deleteReservation);

  const rooms = useRoomStore(state => state.rooms);
  const fetchRooms = useRoomStore(state => state.fetchRooms);

  const availableRooms = useMemo(
    () => (isAdmin ? rooms : rooms.filter((r) => isSpaceReleasedByAdmin(r).released)),
    [rooms, isAdmin]
  );

  // Users cache for display names
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});

  // View & Period State
  const [viewMode, setViewMode] = useState<CalendarViewMode>('MES'); // Default: Formato de Calendário Normal
  const [currentMonthDate, setCurrentMonthDate] = useState<Date>(new Date());
  const [currentTimestamp, setCurrentTimestamp] = useState<number>(Date.now());

  // Filters State - initialize with user enrolled course/semester if standard user
  const [selectedCourse, setSelectedCourse] = useState<CalendarCourse>(user?.curso || 'GTI');
  const [selectedSemester, setSelectedSemester] = useState<number>(user?.semestre || 4);
  const [selectedDay, setSelectedDay] = useState<DayOfWeek | 'TODOS'>('TODOS');
  const [selectedRoomId, setSelectedRoomId] = useState<string>('TODAS');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>(getTodayLocalISO());
  const [showOnlyReservations, setShowOnlyReservations] = useState<boolean>(false);

  // Modals State
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [isNewReservationOpen, setIsNewReservationOpen] = useState(false);
  const [bookingPrefill, setBookingPrefill] = useState<{ roomName?: string; startTime?: string }>({});
  const [isEditEnrollmentOpen, setIsEditEnrollmentOpen] = useState(false);
  const [editCourse, setEditCourse] = useState<CalendarCourse>(user?.curso || 'GTI');
  const [editSemester, setEditSemester] = useState<number>(user?.semestre || 4);

  // Synchronize enrolled course and semester for standard users
  useEffect(() => {
    if (!isAdmin && user) {
      if (user.curso && user.curso !== selectedCourse) {
        setSelectedCourse(user.curso);
      }
      if (user.semestre && user.semestre !== selectedSemester) {
        setSelectedSemester(user.semestre);
      }
      if (user.curso) setEditCourse(user.curso);
      if (user.semestre) setEditSemester(user.semestre);
    }
  }, [isAdmin, user]);

  // Real-time heartbeat timer: keeps calendar updated and drops finished reservations immediately
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTimestamp(Date.now());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubRes = fetchReservations();
    const unsubRooms = fetchRooms();

    // Cache user names strictly for ADMIN accounts (PII Isolation in Firestore rules)
    let unsubUsers: (() => void) | undefined;
    if (isAdmin) {
      unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        const map: Record<string, string> = {};
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          map[doc.id] = data.nome || data.email || 'Usuário Fatec';
        });
        setUsersMap(map);
      }, (err) => {
        console.warn('Could not fetch user list for calendar requester mapping:', err);
      });
    }

    return () => {
      unsubRes();
      unsubRooms();
      if (unsubUsers) unsubUsers();
    };
  }, [fetchReservations, fetchRooms, isAdmin]);

  // Combine fixed curriculum with dynamic real-time reservations
  const allEvents = useMemo(() => {
    const events: CalendarEvent[] = [];

    // 1. Add fixed curriculum classes (Verde)
    for (const aula of GRADE_CURRICULAR_FATEC) {
      if (aula.curso === selectedCourse && aula.semestre === selectedSemester) {
        events.push({
          ...aula,
          cor: 'verde',
        });
      }
    }

    // 2. Add dynamic reservations from Firestore (Vermelho)
    const activeRoomsInCurrentView = new Set(events.map(e => e.sala.toLowerCase().trim()));

    for (const res of reservations) {
      // 1. NEVER display finished/expired reservations on the calendar
      // As requested: "não mantenha as reservas já terminadas no calendário. assim que uma reserva terminar ela deve sair do calendário e ficar apenas em no histórico de reservas."
      if (isReservationFinished(res, currentTimestamp)) {
        continue;
      }

      const dayOfWeek = getDayOfWeekFromDate(res.data);
      const requesterName = usersMap[res.usuarioId] || (res.usuarioId === user?.id ? user?.nome : 'Usuário TechReserve');
      const cleanSalaNome = (res.salaNome || '').toLowerCase().trim();

      // Check if reservation is related to current view:
      // A) User explicitly filtered by that room, OR
      // B) The room is used by this course/semester, OR
      // C) Reservation mentions the course/semester in observations, OR
      // D) User filtered by room
      const matchesRoom = selectedRoomId !== 'TODAS' && (cleanSalaNome.includes(selectedRoomId.toLowerCase()) || selectedRoomId.toLowerCase().includes(cleanSalaNome));
      const roomUsedInCurriculum = activeRoomsInCurrentView.has(cleanSalaNome);
      const mentionsCourse = (res.observacoes || '').toUpperCase().includes(selectedCourse);

      if (selectedRoomId !== 'TODAS' && !matchesRoom) {
        continue;
      }

      events.push({
        id: `reserva_${res.id}`,
        tipo: 'RESERVA_USUARIO',
        curso: selectedCourse,
        semestre: selectedSemester,
        diaSemana: dayOfWeek,
        materia: res.observacoes || `Reserva: ${res.salaNome}`,
        solicitante: requesterName,
        usuarioId: res.usuarioId,
        sala: res.salaNome,
        salaId: res.salaId,
        salaInstitutionalId: res.salaInstitutionalId,
        horarioInicio: res.inicio,
        horarioFim: res.fim,
        cor: 'vermelho',
        status: res.status === 'CONFIRMADA' ? 'Aprovada' : res.status === 'PENDENTE' ? 'Pendente' : res.status,
        data: res.data,
        observacoes: res.observacoes,
        reservationId: res.id,
      });
    }

    return events;
  }, [reservations, selectedCourse, selectedSemester, selectedRoomId, usersMap, user, showOnlyReservations, currentTimestamp]);

  // Filter events based on active filters
  const filteredEvents = useMemo(() => {
    return allEvents.filter(event => {
      // Filter by Day
      if (selectedDay !== 'TODOS' && event.diaSemana !== selectedDay) {
        return false;
      }

      // Filter by Room
      if (selectedRoomId !== 'TODAS') {
        const cleanSelected = selectedRoomId.toLowerCase().trim();
        const cleanEventRoom = event.sala.toLowerCase().trim();
        if (!cleanEventRoom.includes(cleanSelected) && !cleanSelected.includes(cleanEventRoom)) {
          return false;
        }
      }

      // Filter by Only Reservations toggle
      if (showOnlyReservations && event.tipo !== 'RESERVA_USUARIO') {
        return false;
      }

      // Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchMateria = event.materia.toLowerCase().includes(q);
        const matchProf = (event.professor || '').toLowerCase().includes(q);
        const matchSolicitante = (event.solicitante || '').toLowerCase().includes(q);
        const matchSala = event.sala.toLowerCase().includes(q);
        if (!matchMateria && !matchProf && !matchSolicitante && !matchSala) {
          return false;
        }
      }

      return true;
    }).sort((a, b) => a.horarioInicio.localeCompare(b.horarioInicio));
  }, [allEvents, selectedDay, selectedRoomId, showOnlyReservations, searchQuery]);

  // Group events by day of week
  const eventsByDay = useMemo(() => {
    const map: Record<DayOfWeek, CalendarEvent[]> = {
      Segunda: [],
      Terça: [],
      Quarta: [],
      Quinta: [],
      Sexta: [],
      Sábado: [],
    };

    filteredEvents.forEach(evt => {
      if (map[evt.diaSemana]) {
        map[evt.diaSemana].push(evt);
      }
    });

    return map;
  }, [filteredEvents]);

  // Count stats
  const stats = useMemo(() => {
    const gradeCount = filteredEvents.filter(e => e.tipo === 'AULA_GRADE').length;
    const reservaCount = filteredEvents.filter(e => e.tipo === 'RESERVA_USUARIO').length;
    const pendingCount = filteredEvents.filter(e => e.tipo === 'RESERVA_USUARIO' && e.status === 'Pendente').length;
    const myReservaCount = filteredEvents.filter(
      e => e.tipo === 'RESERVA_USUARIO' && e.usuarioId === user?.id
    ).length;
    return { gradeCount, reservaCount, pendingCount, myReservaCount };
  }, [filteredEvents, user?.id]);

  // Action handlers
  const handleApproveReservation = async (reservationId: string) => {
    if (!isAdmin) return;
    await updateReservation(reservationId, { status: 'CONFIRMADA' });
  };

  const handleCancelReservation = async (reservationId: string) => {
    await updateReservation(reservationId, { status: 'CANCELADA' });
  };

  const handleDeleteReservation = async (reservationId: string) => {
    if (!isAdmin) return;
    await deleteReservation(reservationId);
  };

  const handleRequestRoomBooking = (roomName: string, preferredTime?: string) => {
    setBookingPrefill({
      roomName,
      startTime: preferredTime || '17:00'
    });
    setIsNewReservationOpen(true);
  };

  return (
    <div className="space-y-6 pb-12">
      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 bg-fatec-red/10 text-fatec-red text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full">
              <CalendarIcon className="h-3 w-3" />
              Fatec Franco da Rocha
            </span>
            {isAdmin && (
              <span className="inline-flex items-center gap-1 bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full">
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                Painel ADM Ativo
              </span>
            )}
          </div>
          <h2 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
            Calendário & Grade Horária
          </h2>
          <p className="text-slate-500 text-xs md:text-sm mt-0.5">
            Visualize as aulas fixas da grade e reservas de espaços em tempo real.
          </p>
        </div>

        {/* TOP ACTIONS & LEGEND */}
        <div className="flex flex-wrap items-center gap-3">
          {/* LEGEND BADGES (Mandatory: Verde = Grade, Vermelho = Reservas) */}
          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-2 shadow-2xs">
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm" />
              <span className="text-[11px] font-black text-slate-700">Grade Fixa</span>
            </div>
            <span className="text-slate-300">|</span>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-fatec-red shadow-sm" />
              <span className="text-[11px] font-black text-slate-700">Reservado</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              const windowCheck = isBookingWindowOpen(new Date(), isAdmin);
              if (!windowCheck.isOpen) {
                toast.error(windowCheck.message);
                return;
              }
              setBookingPrefill({ startTime: '17:00' });
              setIsNewReservationOpen(true);
            }}
            className="px-4 py-2.5 rounded-2xl bg-fatec-red hover:bg-fatec-red/90 text-white text-xs font-black uppercase tracking-wider shadow-sm shadow-red-500/20 flex items-center gap-2 transition-all active:scale-95"
          >
            <Plus className="h-4 w-4" />
            Nova Reserva
          </button>
        </div>
      </div>

      {/* FILTER CONTROLS */}
      <CalendarFilters
        isAdmin={isAdmin}
        selectedCourse={selectedCourse}
        onSelectCourse={setSelectedCourse}
        selectedSemester={selectedSemester}
        onSelectSemester={setSelectedSemester}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        selectedRoomId={selectedRoomId}
        onSelectRoomId={setSelectedRoomId}
        rooms={availableRooms}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        showOnlyReservations={showOnlyReservations}
        onToggleOnlyReservations={setShowOnlyReservations}
        onEditEnrollment={() => setIsEditEnrollmentOpen(true)}
      />

      {/* SUMMARY STATS STRIP */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Curso & Semestre</p>
          <p className="text-lg font-black text-slate-900 mt-0.5">{selectedCourse} • {selectedSemester}º Sem</p>
        </div>
        <div className="bg-white border border-emerald-200/60 rounded-2xl p-4 shadow-2xs">
          <p className="text-[10px] font-black uppercase tracking-wider text-emerald-600 flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Aulas da Grade
          </p>
          <p className="text-lg font-black text-emerald-950 mt-0.5">{stats.gradeCount} aulas</p>
        </div>
        <div className="bg-white border border-rose-200/60 rounded-2xl p-4 shadow-2xs">
          <p className="text-[10px] font-black uppercase tracking-wider text-fatec-red flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-fatec-red" />
            Reservas Ativas
          </p>
          <p className="text-lg font-black text-rose-950 mt-0.5">{stats.reservaCount} ativas</p>
        </div>
        {isAdmin ? (
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Pendentes ADM</p>
            <p className="text-lg font-black text-amber-600 mt-0.5">{stats.pendingCount} para avaliar</p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Minhas Reservas</p>
            <p className="text-lg font-black text-slate-900 mt-0.5">{stats.myReservaCount} agendadas</p>
          </div>
        )}
      </div>

      {/* CALENDAR VIEW: MONTH GRID (NORMAL CALENDAR) OR WEEKLY GRID OR SINGLE DAY */}
      <div className="space-y-6">
        {viewMode === 'MES' ? (
          /* TRADITIONAL MONTH CALENDAR (Formato de Calendário Normal) */
          <MonthCalendarGrid
            currentDate={currentMonthDate}
            onMonthChange={setCurrentMonthDate}
            selectedDateStr={selectedDate}
            onSelectDate={setSelectedDate}
            events={filteredEvents}
            rooms={availableRooms}
            selectedRoomId={selectedRoomId}
            onSelectEvent={setSelectedEvent}
            onNewReservationOnDate={(dateStr, startTime, roomName) => {
              const windowCheck = isBookingWindowOpen(new Date(), isAdmin);
              if (!windowCheck.isOpen) {
                toast.error(windowCheck.message);
                return;
              }
              const { minDate, maxDate } = getReservationDateLimits();
              if (dateStr < minDate) {
                toast.error('Não é permitido realizar reservas em datas passadas.');
                return;
              }
              if (!isAdmin && dateStr > maxDate) {
                toast.error(`Reservas antecipadas estão limitadas até ${maxDate}.`);
                return;
              }
              setSelectedDate(dateStr);
              setBookingPrefill({
                roomName: roomName || (selectedRoomId !== 'TODAS' ? selectedRoomId : undefined),
                startTime: startTime || '17:00'
              });
              setIsNewReservationOpen(true);
            }}
            selectedCourse={selectedCourse}
            selectedSemester={selectedSemester}
            isAdmin={isAdmin}
            onApproveReservation={isAdmin ? handleApproveReservation : undefined}
            onCancelReservation={handleCancelReservation}
          />
        ) : viewMode === 'SEMANA' || selectedDay === 'TODOS' ? (
          /* WEEK VIEW (Segunda a Sábado) */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 items-start">
            {DAY_ORDER.map((dia) => {
              const dayEvents = eventsByDay[dia];
              const isToday = getDayOfWeekFromDate(new Date().toLocaleDateString('en-CA')) === dia;

              return (
                <div 
                  key={dia} 
                  className={cn(
                    "bg-white rounded-3xl border transition-all shadow-sm flex flex-col min-h-[360px] overflow-hidden",
                    isToday ? "border-slate-400 ring-2 ring-slate-900/10" : "border-slate-200/80"
                  )}
                >
                  {/* DAY HEADER */}
                  <div className={cn(
                    "p-3.5 border-b flex items-center justify-between",
                    isToday ? "bg-slate-900 text-white" : "bg-slate-50 border-slate-100 text-slate-800"
                  )}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black tracking-tight">{dia}</span>
                      {isToday && (
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-fatec-red text-white">
                          Hoje
                        </span>
                      )}
                    </div>
                    <span className={cn(
                      "text-[10px] font-black px-2 py-0.5 rounded-full",
                      isToday ? "bg-white/20 text-white" : "bg-slate-200 text-slate-600"
                    )}>
                      {dayEvents.length}
                    </span>
                  </div>

                  {/* EVENTS LIST */}
                  <div className="p-3 space-y-2.5 flex-1 overflow-y-auto max-h-[700px]">
                    {dayEvents.length === 0 ? (
                      <div className="py-12 text-center text-slate-300 flex flex-col items-center justify-center">
                        <CalendarIcon className="h-6 w-6 stroke-[1.5] mb-1 opacity-50" />
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                          Sem aulas na grade
                        </p>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setBookingPrefill({});
                              setIsNewReservationOpen(true);
                            }}
                            className="mt-2 text-[10px] font-bold text-fatec-red hover:underline"
                          >
                            + Reservar sala
                          </button>
                        )}
                      </div>
                    ) : (
                      dayEvents.map((event) => {
                        const isGrade = event.tipo === 'AULA_GRADE';
                        return (
                          <div
                            key={event.id}
                            onClick={() => setSelectedEvent(event)}
                            className={cn(
                              "p-3 rounded-2xl border text-left cursor-pointer transition-all duration-150 relative group hover:shadow-md",
                              isGrade
                                ? "bg-emerald-50/70 border-emerald-200/80 hover:border-emerald-400 text-emerald-950"
                                : "bg-rose-50/70 border-rose-200/90 hover:border-rose-400 text-rose-950"
                            )}
                          >
                            {/* EVENT TYPE BADGE & TIME */}
                            <div className="flex items-center justify-between gap-1 mb-1.5">
                              <span className={cn(
                                "text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider",
                                isGrade ? "bg-emerald-200/80 text-emerald-900" : "bg-rose-200/90 text-rose-900"
                              )}>
                                {isGrade ? 'Grade' : (event.status || 'Reserva')}
                              </span>
                              <span className="text-[10px] font-mono font-black text-slate-700 flex items-center gap-1">
                                <Clock className="h-3 w-3 text-slate-400" />
                                {event.horarioInicio} às {event.horarioFim}
                              </span>
                            </div>

                            {/* MATÉRIA / TÍTULO */}
                            <h4 className="text-xs font-black leading-tight line-clamp-2">
                              {event.materia}
                            </h4>

                            {/* PROFESSOR OU SOLICITANTE */}
                            <p className="text-[11px] text-slate-600 font-medium mt-1 flex items-center gap-1 line-clamp-1">
                              {isGrade ? (
                                <GraduationCap className="h-3 w-3 shrink-0 text-emerald-600" />
                              ) : (
                                <User className="h-3 w-3 shrink-0 text-fatec-red" />
                              )}
                              <span>{isGrade ? event.professor : event.solicitante}</span>
                            </p>

                            {/* SALA */}
                            <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 line-clamp-1">
                              <Building2 className="h-3 w-3 shrink-0 text-slate-400" />
                              <span>{event.sala}</span>
                            </p>

                            {/* QUICK ACTIONS FOR ADM (Direct Approve / Cancel from calendar card) */}
                            {isAdmin && !isGrade && event.status === 'Pendente' && (
                              <div className="mt-2 pt-2 border-t border-rose-200/70 flex items-center justify-between">
                                <span className="text-[9px] font-black text-amber-700 uppercase">Pendente</span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (event.reservationId) {
                                      handleApproveReservation(event.reservationId);
                                      toast.success('Reserva aprovada!');
                                    }
                                  }}
                                  className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[9px] font-bold uppercase tracking-wider flex items-center gap-1"
                                >
                                  <CheckCircle2 className="h-2.5 w-2.5" />
                                  Aprovar
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* SINGLE DAY DETAILED VIEW */
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-6">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-black text-sm">
                  {selectedDay.slice(0, 3)}
                </div>
                <div>
                  <h3 className="text-xl font-black text-slate-900 tracking-tight">
                    Programação de {selectedDay}-feira
                  </h3>
                  <p className="text-xs text-slate-500">
                    {filteredEvents.length} atividades programadas no {selectedSemester}º Semestre de {selectedCourse}.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDay('TODOS');
                    setViewMode('SEMANA');
                  }}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-all"
                >
                  Grade Semanal
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDay('TODOS');
                    setViewMode('MES');
                  }}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-all"
                >
                  Calendário Normal (Mês)
                </button>
              </div>
            </div>

            {filteredEvents.length === 0 ? (
              <div className="py-16 text-center text-slate-400">
                <CalendarIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-bold">Nenhuma atividade agendada para {selectedDay}.</p>
                <p className="text-xs text-slate-400 mt-1">Nenhum evento da grade curricular ou reserva encontrado com os filtros atuais.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredEvents.map((event) => {
                  const isGrade = event.tipo === 'AULA_GRADE';
                  return (
                    <div
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      className={cn(
                        "p-5 rounded-3xl border text-left cursor-pointer transition-all duration-200 relative group hover:shadow-lg",
                        isGrade
                          ? "bg-emerald-50/70 border-emerald-200 hover:border-emerald-400 text-emerald-950"
                          : "bg-rose-50/70 border-rose-200 hover:border-rose-400 text-rose-950"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className={cn(
                          "text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider",
                          isGrade ? "bg-emerald-200/90 text-emerald-900" : "bg-rose-200 text-rose-900"
                        )}>
                          {isGrade ? '🟩 Aula da Grade' : '🟥 Sala Reservada'}
                        </span>
                        <span className="text-xs font-mono font-black text-slate-700 flex items-center gap-1.5 bg-white/80 px-2.5 py-1 rounded-lg border border-slate-200/60">
                          <Clock className="h-3.5 w-3.5 text-slate-400" />
                          {event.horarioInicio} - {event.horarioFim}
                        </span>
                      </div>

                      <h4 className="text-base font-black leading-snug mb-2 text-slate-950">
                        {event.materia}
                      </h4>

                      <div className="space-y-1.5 text-xs text-slate-600">
                        <p className="flex items-center gap-2 font-medium">
                          {isGrade ? (
                            <GraduationCap className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <User className="h-4 w-4 text-fatec-red" />
                          )}
                          <span>{isGrade ? `Prof. ${event.professor}` : `Solicitante: ${event.solicitante}`}</span>
                        </p>
                        <p className="flex items-center gap-2 font-medium">
                          <Building2 className="h-4 w-4 text-slate-400" />
                          <span>{event.sala}</span>
                        </p>
                      </div>

                      {isAdmin && !isGrade && (
                        <div className="mt-4 pt-3 border-t border-rose-200 flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">
                            Status: <strong className="text-slate-800">{event.status}</strong>
                          </span>
                          <div className="flex items-center gap-1.5">
                            {event.status === 'Pendente' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (event.reservationId) {
                                    handleApproveReservation(event.reservationId);
                                    toast.success('Reserva aprovada!');
                                  }
                                }}
                                className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-all shadow-xs flex items-center gap-1"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                Aprovar
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (event.reservationId) {
                                  handleCancelReservation(event.reservationId);
                                  toast.success('Reserva cancelada.');
                                }
                              }}
                              className="px-2.5 py-1 rounded-lg bg-white border border-rose-200 text-fatec-red hover:bg-rose-50 text-xs font-bold transition-all"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* EVENT DETAIL MODAL */}
      <EventDetailModal
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        currentUser={user}
        roomDetails={rooms.find(r => selectedEvent && (r.nome.toLowerCase().includes(selectedEvent.sala.toLowerCase()) || selectedEvent.sala.toLowerCase().includes(r.nome.toLowerCase())))}
        onApproveReservation={isAdmin ? handleApproveReservation : undefined}
        onCancelReservation={handleCancelReservation}
        onDeleteReservation={isAdmin ? handleDeleteReservation : undefined}
        onRequestRoomBooking={handleRequestRoomBooking}
      />

      {/* NEW RESERVATION MODAL */}
      <NewReservationModal
        isOpen={isNewReservationOpen}
        onClose={() => setIsNewReservationOpen(false)}
        rooms={availableRooms}
        initialRoomName={bookingPrefill.roomName}
        initialStartTime={bookingPrefill.startTime}
        initialDate={selectedDate}
        initialCourse={selectedCourse}
        initialSemester={selectedSemester}
        currentUser={user}
        existingEvents={allEvents}
      />

      {/* EDIT ENROLLMENT MODAL FOR STANDARD STUDENTS */}
      {isEditEnrollmentOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl border border-slate-100 space-y-5 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="h-10 w-10 rounded-2xl bg-fatec-red text-white flex items-center justify-center shadow-md shadow-red-500/20">
                  <GraduationCap className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900">Alterar Minha Turma</h3>
                  <p className="text-xs text-slate-500">
                    {isAdmin ? 'Atualize curso e semestre da grade' : 'Atualize o seu semestre matriculado'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsEditEnrollmentOpen(false)}
                className="p-1 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black uppercase tracking-wider text-slate-700">
                  Curso Fatec:
                </label>
                {isAdmin ? (
                  <select
                    value={editCourse}
                    onChange={(e) => setEditCourse(e.target.value as CalendarCourse)}
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-medium text-slate-800 text-sm focus:ring-2 focus:ring-fatec-red outline-none"
                  >
                    <option value="GTI">GTI - Gestão da Tecnologia da Informação</option>
                    <option value="GEEE">GEEE - Gestão de Energia e Eficiência Energética</option>
                  </select>
                ) : (
                  <div className="space-y-1">
                    <div className="w-full p-3 bg-slate-100 border border-slate-200 rounded-xl font-semibold text-slate-600 text-sm">
                      {(user?.curso || selectedCourse) === 'GEEE'
                        ? 'GEEE - Gestão de Energia e Eficiência Energética'
                        : 'GTI - Gestão da Tecnologia da Informação'}
                    </div>
                    <p className="text-[11px] text-slate-500">
                      O curso é fixado no cadastro e alterado exclusivamente pelo perfil ADM.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-black uppercase tracking-wider text-slate-700">
                  Semestre Matriculado:
                </label>
                <div className="grid grid-cols-6 gap-1.5">
                  {[1, 2, 3, 4, 5, 6].map((sem) => (
                    <button
                      key={sem}
                      type="button"
                      onClick={() => setEditSemester(sem)}
                      className={cn(
                        "py-2.5 rounded-xl text-xs font-black transition-all",
                        editSemester === sem
                          ? "bg-fatec-red text-white shadow-sm shadow-red-500/20"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      )}
                    >
                      {sem}º
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsEditEnrollmentOpen(false)}
                className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-all"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    if (isAdmin) {
                      await updateProfile({ curso: editCourse, semestre: editSemester });
                      setSelectedCourse(editCourse);
                    } else {
                      await updateProfile({ semestre: editSemester });
                    }
                    setSelectedSemester(editSemester);
                    setIsEditEnrollmentOpen(false);
                    toast.success('Semestre atualizado com sucesso!');
                  } catch (err) {
                    toast.error('Erro ao atualizar matrícula.');
                  }
                }}
                className="px-5 py-2.5 rounded-xl bg-fatec-red hover:bg-fatec-red/90 text-white text-xs font-black uppercase tracking-wider transition-all shadow-sm active:scale-95"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
