/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Calendar,
  Clock,
  Building2,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  FileText,
  Send,
  Layers,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Room, CalendarCourse, User as UserType, CalendarEvent } from '../../../types';
import { useReservationStore } from '../../../store/useReservationStore';
import { useScheduleStore } from '../../../store/useScheduleStore';
import { usePunishmentStore } from '../../../store/usePunishmentStore';
import {
  checkReservationConflict,
  calculateDayTimeSlots,
  getReservableFreeSlots,
} from '../../../utils/calendarTimeSlots';
import {
  validateReservationRules,
  isBookingWindowOpen,
  getReservationDateLimits,
} from '../../../utils/reservationRules';
import {
  checkNoShowSuspensionForDate,
  checkWeeklyQuotaLocal,
  formatNoShowTag,
  getReleasedBlocksForRoomOnDate,
  isSpaceReleasedByAdmin,
} from '../../../services/reservationService';
import { formatDataBR, createSafeLocalDateTime } from '../../../utils/dateUtils';
import { cn } from '../../../lib/utils';
import { toast } from 'sonner';

interface NewReservationModalProps {
  isOpen: boolean;
  onClose: () => void;
  rooms: Room[];
  initialRoomName?: string;
  initialDate?: string;
  initialStartTime?: string;
  initialCourse?: CalendarCourse;
  initialSemester?: number;
  currentUser: UserType | null;
  existingEvents?: CalendarEvent[];
}

export function NewReservationModal({
  isOpen,
  onClose,
  rooms,
  initialRoomName,
  initialDate,
  initialStartTime,
  initialCourse = 'GTI',
  initialSemester = 4,
  currentUser,
  existingEvents = [],
}: NewReservationModalProps) {
  const addReservation = useReservationStore((state) => state.addReservation);
  const reservations = useReservationStore((state) => state.reservations);
  const scheduleConfig = useScheduleStore((state) => state.config);
  const scheduleExceptions = useScheduleStore((state) => state.exceptions);
  const punishments = usePunishmentStore((state) => state.punishments);
  const activePunishment = usePunishmentStore((state) => state.activePunishment);

  const isAdmin = currentUser?.role === 'ADMIN';

  // Usuários comuns SÓ visualizam e agendam salas liberadas explicitamente pelo ADM
  const availableRooms = React.useMemo(() => {
    if (isAdmin) return rooms;
    return rooms.filter((r) => isSpaceReleasedByAdmin(r).released);
  }, [rooms, isAdmin]);

  const effectivePunishments = React.useMemo(() => {
    if (isAdmin) return punishments;
    return activePunishment ? [activePunishment] : [];
  }, [isAdmin, punishments, activePunishment]);

  const dateLimits = React.useMemo(() => getReservationDateLimits(), [scheduleConfig]);
  const windowStatus = isBookingWindowOpen(new Date(), isAdmin);

  const [selectedRoomName, setSelectedRoomName] = useState(
    initialRoomName || (availableRooms[0]?.nome ?? '')
  );
  const [date, setDate] = useState(initialDate || dateLimits.minDate);
  const [startTime, setStartTime] = useState(
    initialStartTime || scheduleConfig.janelaInicio || '17:00'
  );
  const [endTime, setEndTime] = useState('18:40');
  const [curso, setCurso] = useState<CalendarCourse>(initialCourse);
  const [semestre, setSemestre] = useState<number>(initialSemester);
  const [motivo, setMotivo] = useState('Reunião de Projeto (TechReserve)');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedRoomObj = React.useMemo(
    () => availableRooms.find((r) => r.nome === selectedRoomName) || availableRooms[0],
    [availableRooms, selectedRoomName]
  );

  const blockRelease = React.useMemo(
    () =>
      getReleasedBlocksForRoomOnDate(
        selectedRoomObj,
        date,
        scheduleConfig,
        scheduleExceptions
      ),
    [selectedRoomObj, date, scheduleConfig, scheduleExceptions]
  );

  const quotaCheck = React.useMemo(() => {
    if (!currentUser || isAdmin) return null;
    return checkWeeklyQuotaLocal(reservations, currentUser.id, date);
  }, [reservations, currentUser, isAdmin, date]);

  const noShowCheck = React.useMemo(
    () => checkNoShowSuspensionForDate(currentUser, effectivePunishments, date),
    [currentUser, effectivePunishments, date]
  );

  React.useEffect(() => {
    if (isOpen) {
      const limits = getReservationDateLimits();
      const chosenRoom =
        availableRooms.find((r) => r.nome === initialRoomName) || availableRooms[0];
      setSelectedRoomName(chosenRoom?.nome ?? '');
      const validInitial =
        initialDate && initialDate >= limits.minDate && (isAdmin || initialDate <= limits.maxDate)
          ? initialDate
          : limits.minDate;
      setDate(validInitial);
      const rel = getReleasedBlocksForRoomOnDate(
        chosenRoom,
        validInitial,
        scheduleConfig,
        scheduleExceptions
      );
      const matchedBlock = initialStartTime
        ? rel.blocks.find((b) => b.inicio === initialStartTime)
        : rel.blocks[0];
      setStartTime(matchedBlock?.inicio || (isAdmin ? initialStartTime || '17:00' : ''));
      setEndTime(matchedBlock?.fim || (isAdmin ? '18:40' : ''));
      if (initialCourse) setCurso(initialCourse);
      if (initialSemester) setSemestre(initialSemester);
    }
  }, [isOpen]);

  // Ajusta o bloco automaticamente quando o usuário troca a sala ou a data
  React.useEffect(() => {
    if (!isOpen) return;
    if (blockRelease.blocks.length > 0) {
      const valid = blockRelease.blocks.some(
        (b) => b.inicio === startTime && b.fim === endTime
      );
      if (!valid) {
        setStartTime(blockRelease.blocks[0].inicio);
        setEndTime(blockRelease.blocks[0].fim);
      }
    } else if (!isAdmin) {
      setStartTime('');
      setEndTime('');
    }
  }, [date, selectedRoomObj?.firestoreId, blockRelease.blocks, isAdmin, isOpen]);

  const conflictCheck = React.useMemo(() => {
    if (!existingEvents.length || !date || !startTime || !endTime || !selectedRoomName) {
      return { hasConflict: false };
    }
    return checkReservationConflict(existingEvents, date, selectedRoomName, startTime, endTime);
  }, [existingEvents, date, selectedRoomName, startTime, endTime]);

  const roomSlots = React.useMemo(() => {
    if (!existingEvents.length || !date || !selectedRoomName) {
      return { occupiedSlots: [], freeSlots: [], allSlotsChronological: [] };
    }
    const daySlots = calculateDayTimeSlots(date, existingEvents, selectedRoomName);
    const reservableFree = getReservableFreeSlots(
      daySlots.freeSlots,
      date,
      selectedRoomObj?.firestoreId
    );
    return {
      ...daySlots,
      freeSlots: reservableFree,
    };
  }, [
    existingEvents,
    date,
    selectedRoomName,
    selectedRoomObj?.firestoreId,
    scheduleConfig,
    scheduleExceptions,
  ]);

  if (!isOpen) return null;

  const isUserBlockedOnSelection =
    !isAdmin &&
    (availableRooms.length === 0 ||
      !blockRelease.released ||
      noShowCheck.blocked ||
      Boolean(quotaCheck && !quotaCheck.allowed));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      toast.error('Você precisa estar autenticado para realizar reservas.');
      return;
    }

    if (currentUser.bloqueado || currentUser.inativo) {
      toast.error('Sua conta está inativa ou bloqueada e não pode realizar reservas.');
      return;
    }

    if (!isAdmin) {
      if (noShowCheck.blocked) {
        toast.error(noShowCheck.error || formatNoShowTag(date));
        return;
      }
      if (quotaCheck && !quotaCheck.allowed) {
        toast.error(quotaCheck.error);
        return;
      }
      if (!blockRelease.released) {
        toast.error(
          blockRelease.reason ||
            'Esta sala não possui horários liberados pelo ADM para esta data.'
        );
        return;
      }
    }

    const room = availableRooms.find((r) => r.nome === selectedRoomName) || availableRooms[0];
    if (!room) {
      toast.error('Nenhuma sala liberada pelo administrador foi selecionada.');
      return;
    }

    const validation = validateReservationRules({
      date,
      startTime,
      endTime,
      salaFirestoreId: room.firestoreId,
      isAdmin,
    });
    if (!validation.valid) {
      toast.error(validation.error || 'Dados de reserva inválidos.');
      return;
    }

    if (conflictCheck.hasConflict) {
      toast.error(
        conflictCheck.conflictReason || 'Existe conflito com aula ou reserva neste horário.'
      );
      return;
    }

    const startDateTime = createSafeLocalDateTime(date, startTime);

    setIsSubmitting(true);
    try {
      await addReservation({
        salaId: room.firestoreId,
        salaInstitutionalId: room.id,
        salaNome: room.nome,
        usuarioId: currentUser.id,
        data: date,
        inicio: startTime,
        fim: endTime,
        status: isAdmin ? 'CONFIRMADA' : 'PENDENTE',
        checkInExpiracao: isAdmin ? null : startDateTime.getTime() + 5 * 60 * 1000,
        checkInRealizado: isAdmin,
        observacoes: motivo.trim() || `Reserva ${curso} ${semestre}º Semestre`,
      });

      toast.success(
        isAdmin ? 'Reserva ADM registrada com sucesso!' : 'Reserva solicitada com sucesso!'
      );
      onClose();
    } catch (err: any) {
      console.error(err);
      toast.error(
        err?.message && !String(err.message).startsWith('{')
          ? err.message
          : 'Erro ao registrar reserva. Verifique sua cota semanal e permissões.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden relative max-h-[92vh] overflow-y-auto custom-scrollbar"
        >
          {/* HEADER */}
          <div className="p-6 bg-slate-900 text-white relative">
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <p className="text-xs font-semibold text-red-300 mb-1">Agendamento Acadêmico</p>
            <h3 className="text-xl font-bold text-white">Reservar Espaço / Laboratório</h3>
            <p className="text-xs text-slate-400 mt-1">
              Sujeito às salas e blocos liberados pelo ADM e à cota de 1 reserva por semana.
            </p>
          </div>

          {/* FORM */}
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {/* FEEDBACK CLARO DAS REGRAS DE NEGÓCIO */}
            {!windowStatus.isOpen ? (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-2.5 text-xs text-amber-900">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-amber-950">Sistema de Reservas Fechado</p>
                  <p className="mt-0.5 text-amber-800 leading-relaxed">{windowStatus.message}</p>
                </div>
              </div>
            ) : !isAdmin && availableRooms.length === 0 ? (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2.5 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-950">Nenhuma Sala Liberada pelo ADM</p>
                  <p className="mt-0.5 text-rose-800">
                    O administrador ainda não liberou salas para agendamento neste período.
                  </p>
                </div>
              </div>
            ) : !isAdmin && noShowCheck.blocked ? (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2.5 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-rose-950">{noShowCheck.tag}</p>
                  <p className="text-rose-800 leading-relaxed">
                    Novas reservas estão bloqueadas apenas para o restante de{' '}
                    <strong>{formatDataBR(date)}</strong>. Selecione uma data futura para agendar normalmente.
                  </p>
                </div>
              </div>
            ) : !isAdmin && quotaCheck && !quotaCheck.allowed ? (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-2.5 text-xs text-amber-900">
                <AlertCircle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-amber-950">{quotaCheck.error}</p>
                  <p className="text-amber-800 leading-relaxed">
                    Semana de {quotaCheck.weekBounds.startLabel} a {quotaCheck.weekBounds.endLabel}.
                  </p>
                </div>
              </div>
            ) : !isAdmin && !blockRelease.released ? (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2.5 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-950">Horários Indisponíveis</p>
                  <p className="mt-0.5 text-rose-800">{blockRelease.reason}</p>
                </div>
              </div>
            ) : (
              <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl space-y-1 text-xs text-slate-600">
                <div className="flex items-center justify-between font-bold text-slate-800">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-fatec-red" />
                    Regras Operacionais Vigentes
                  </span>
                  {!isAdmin && quotaCheck && (
                    <span className="font-mono tabular-nums text-[11px] text-emerald-700">
                      Cota semanal: {quotaCheck.usedCount}/1
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 pt-0.5 font-mono tabular-nums">
                  <span>
                    Abertura: <strong>{String(scheduleConfig.horaAberturaSistema).padStart(2, '0')}:00</strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Janela: <strong>{blockRelease.janelaInicio}–{blockRelease.janelaFim}</strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Até: <strong>{formatDataBR(dateLimits.maxDate)}</strong>
                  </span>
                </div>
              </div>
            )}

            {/* SALA */}
            <div>
              <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-slate-400" />
                Sala ou Laboratório Liberado
              </label>
              <select
                value={selectedRoomName}
                onChange={(e) => setSelectedRoomName(e.target.value)}
                disabled={availableRooms.length === 0}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                required
              >
                {availableRooms.map((room) => (
                  <option key={room.firestoreId} value={room.nome}>
                    {room.id ? `${room.id} - ` : ''}
                    {room.nome} ({room.andar})
                  </option>
                ))}
              </select>
            </div>

            {/* SELEÇÃO RÁPIDA DE DATA (HOJE / AMANHÃ) */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-fatec-red" />
                Dia do Agendamento
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDate(dateLimits.todayStr)}
                  className={cn(
                    'py-2 px-3 rounded-xl font-semibold text-xs transition-colors border flex items-center justify-between cursor-pointer',
                    date === dateLimits.todayStr
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  )}
                >
                  <span>Hoje</span>
                  <span className="font-mono tabular-nums">{formatDataBR(dateLimits.todayStr)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDate(dateLimits.tomorrowStr)}
                  className={cn(
                    'py-2 px-3 rounded-xl font-semibold text-xs transition-colors border flex items-center justify-between cursor-pointer',
                    date === dateLimits.tomorrowStr
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  )}
                >
                  <span>Amanhã</span>
                  <span className="font-mono tabular-nums">
                    {formatDataBR(dateLimits.tomorrowStr)}
                  </span>
                </button>
              </div>
            </div>

            {/* DATA & HORÁRIOS */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-slate-400" />
                  Data
                </label>
                <input
                  type="date"
                  value={date}
                  min={dateLimits.minDate}
                  max={isAdmin ? undefined : dateLimits.maxDate}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  Início
                </label>
                <input
                  type="time"
                  value={startTime}
                  readOnly={!isAdmin}
                  min={isAdmin ? undefined : blockRelease.janelaInicio}
                  max={isAdmin ? undefined : blockRelease.janelaFim}
                  onChange={(e) => isAdmin && setStartTime(e.target.value)}
                  className={cn(
                    'w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold focus:outline-none',
                    isAdmin
                      ? 'bg-slate-50 text-slate-800 focus:ring-2 focus:ring-fatec-red'
                      : 'bg-slate-100 text-slate-700 cursor-default'
                  )}
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  Término
                </label>
                <input
                  type="time"
                  value={endTime}
                  readOnly={!isAdmin}
                  min={isAdmin ? undefined : blockRelease.janelaInicio}
                  max={isAdmin ? undefined : blockRelease.janelaFim}
                  onChange={(e) => isAdmin && setEndTime(e.target.value)}
                  className={cn(
                    'w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold focus:outline-none',
                    isAdmin
                      ? 'bg-slate-50 text-slate-800 focus:ring-2 focus:ring-fatec-red'
                      : 'bg-slate-100 text-slate-700 cursor-default'
                  )}
                  required
                />
              </div>
            </div>

            {/* BLOCOS PEDAGÓGICOS LIBERADOS PELO ADM */}
            {blockRelease.blocks.length > 0 && (
              <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">
                    Blocos Liberados pelo ADM
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {isUserBlockedOnSelection ? 'Seleção bloqueada' : 'Clique para selecionar'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {blockRelease.blocks.map((blk) => (
                    <button
                      key={blk.id}
                      type="button"
                      disabled={isUserBlockedOnSelection}
                      onClick={() => {
                        setStartTime(blk.inicio);
                        setEndTime(blk.fim);
                      }}
                      className={cn(
                        'px-2.5 py-1.5 rounded-lg border text-[11px] font-mono tabular-nums font-semibold transition-colors',
                        isUserBlockedOnSelection
                          ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
                          : startTime === blk.inicio && endTime === blk.fim
                          ? 'bg-slate-900 border-slate-900 text-white cursor-pointer'
                          : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-800 cursor-pointer'
                      )}
                    >
                      {blk.inicio}–{blk.fim}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* REAL-TIME CONFLICT ALERT / AVAILABILITY STATUS */}
            {conflictCheck.hasConflict ? (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2.5 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-950">Conflito de Horário Detectado</p>
                  <p className="mt-0.5 text-rose-800 leading-relaxed">
                    {conflictCheck.conflictReason}
                  </p>
                </div>
              </div>
            ) : !isUserBlockedOnSelection && startTime && endTime && startTime < endTime ? (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2 text-xs text-emerald-900 font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>
                  <strong>Horário Livre:</strong> Sala disponível das {startTime} às {endTime}.
                </span>
              </div>
            ) : null}

            {/* AULAS E RESERVAS OCUPADAS NA DATA */}
            {roomSlots.occupiedSlots.length > 0 && (
              <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
                <span className="text-xs font-semibold text-slate-600 block">
                  Aulas e reservas já agendadas nesta sala na data:
                </span>
                <div className="space-y-1">
                  {roomSlots.occupiedSlots.map((occ) => (
                    <div
                      key={occ.id}
                      className="text-xs text-slate-700 flex items-center justify-between bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/60"
                    >
                      <span className="font-semibold truncate max-w-[220px] text-[11px]">
                        {occ.title}
                      </span>
                      <span className="font-mono tabular-nums font-bold text-slate-800 text-[11px] shrink-0">
                        {occ.start} às {occ.end}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CURSO & SEMESTRE VINCULADOS */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-slate-400" />
                  Curso Relacionado
                </label>
                <select
                  value={curso}
                  onChange={(e) => setCurso(e.target.value as CalendarCourse)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                >
                  <option value="GTI">GTI - Gestão de TI</option>
                  <option value="GEEE">GEEE - Gestão de Energia</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <BookOpen className="h-3.5 w-3.5 text-slate-400" />
                  Semestre
                </label>
                <select
                  value={semestre}
                  onChange={(e) => setSemestre(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                >
                  {[1, 2, 3, 4, 5, 6].map((s) => (
                    <option key={s} value={s}>
                      {s}º Semestre
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* MOTIVO / PROJETO / ATIVIDADE */}
            <div>
              <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-slate-400" />
                Finalidade / Atividade
              </label>
              <input
                type="text"
                placeholder="Ex: Reunião de Projeto (TechReserve), Monitoria, Estudo..."
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                required
              />
            </div>

            {/* SUBMIT BUTTONS */}
            <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={
                  isSubmitting ||
                  conflictCheck.hasConflict ||
                  !windowStatus.isOpen ||
                  isUserBlockedOnSelection
                }
                className={cn(
                  'px-5 py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap shrink-0',
                  conflictCheck.hasConflict ||
                    !windowStatus.isOpen ||
                    isUserBlockedOnSelection
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-fatec-red hover:bg-red-800 text-white cursor-pointer'
                )}
              >
                <Send className="h-3.5 w-3.5" />
                {isSubmitting ? 'Gravando...' : 'Confirmar Reserva'}
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
