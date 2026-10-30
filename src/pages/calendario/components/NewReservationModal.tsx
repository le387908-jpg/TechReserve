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
import {
  normalizeTimeHHMM,
  useAvailableSlotsStore,
} from '../../../store/useAvailableSlotsStore';
import { usePunishmentStore } from '../../../store/usePunishmentStore';
import {
  validateReservationRules,
  isBookingWindowOpen,
  getReservationDateLimits,
} from '../../../utils/reservationRules';
import {
  checkNoShowSuspensionForDate,
  checkWeeklyQuotaLocal,
  doRoomNamesMatch,
  formatNoShowTag,
  getReleasedBlocksForRoomOnDate,
  getReleasedDatesForRoom,
  getRoomScheduleSlotsForDate,
  isSpaceReleasedByAdmin,
} from '../../../services/reservationService';
import { RoomSlotSelector } from '../../../components/reservations/RoomSlotSelector';
import { formatDataBR, createSafeLocalDateTime } from '../../../utils/dateUtils';
import { getFriendlyErrorMessage } from '../../../services/firebase/utils';
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
  const rawReservations = useReservationStore((state) => state.reservations);
  const scheduleConfig = useScheduleStore((state) => state.config);
  const rawScheduleExceptions = useScheduleStore((state) => state.exceptions);
  const rawAvailableSlots = useAvailableSlotsStore((state) => state.slots);
  const rawPunishments = usePunishmentStore((state) => state.punishments);
  const activePunishment = usePunishmentStore((state) => state.activePunishment);

  const safeRooms = Array.isArray(rooms) ? rooms : [];
  const reservations = Array.isArray(rawReservations) ? rawReservations : [];
  const scheduleExceptions = Array.isArray(rawScheduleExceptions) ? rawScheduleExceptions : [];
  const availableSlots = Array.isArray(rawAvailableSlots) ? rawAvailableSlots : [];
  const punishments = Array.isArray(rawPunishments) ? rawPunishments : [];

  const isAdmin = currentUser?.role === 'ADMIN';

  // Usuários comuns SÓ visualizam salas liberadas explicitamente pelo ADM
  const availableRooms = React.useMemo(() => {
    if (isAdmin) return safeRooms;
    return safeRooms.filter((r) => isSpaceReleasedByAdmin(r).released);
  }, [safeRooms, isAdmin]);

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
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [selectedAvailableSlotId, setSelectedAvailableSlotId] = useState<string | undefined>(
    undefined
  );
  const [curso, setCurso] = useState<CalendarCourse>(initialCourse);
  const [semestre, setSemestre] = useState<number>(initialSemester);
  const [motivo, setMotivo] = useState('Reunião de Projeto (TechReserve)');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedRoomObj = React.useMemo(
    () =>
      availableRooms.find(
        (r) =>
          r.nome === selectedRoomName ||
          (selectedRoomName ? doRoomNamesMatch(r.nome, selectedRoomName) : false)
      ) || availableRooms[0],
    [availableRooms, selectedRoomName]
  );

  const roomDateLimits = React.useMemo(
    () => getReservationDateLimits(new Date(), selectedRoomObj?.firestoreId),
    [selectedRoomObj?.firestoreId, availableSlots, scheduleConfig]
  );

  const blockRelease = React.useMemo(
    () =>
      getReleasedBlocksForRoomOnDate(
        selectedRoomObj,
        date,
        scheduleConfig,
        scheduleExceptions,
        new Date(),
        availableSlots
      ),
    [selectedRoomObj, date, scheduleConfig, scheduleExceptions, availableSlots]
  );

  const slotScheduleView = React.useMemo(
    () =>
      getRoomScheduleSlotsForDate({
        room: selectedRoomObj,
        dateISO: date,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        currentUserId: currentUser?.id,
      }),
    [
      selectedRoomObj,
      date,
      scheduleConfig,
      scheduleExceptions,
      availableSlots,
      reservations,
      currentUser?.id,
    ]
  );

  const resolvedAvailableSlotId = React.useMemo(() => {
    const match = slotScheduleView.slots.find(
      (s) =>
        s.selectableForUser &&
        s.inicio === normalizeTimeHHMM(startTime) &&
        s.fim === normalizeTimeHHMM(endTime)
    );
    return match?.availableSlotId || selectedAvailableSlotId;
  }, [slotScheduleView.slots, startTime, endTime, selectedAvailableSlotId]);

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
      const chosenRoom =
        availableRooms.find(
          (r) =>
            initialRoomName &&
            (r.nome === initialRoomName || doRoomNamesMatch(r.nome, initialRoomName))
        ) || availableRooms[0];
      const limits = getReservationDateLimits(new Date(), chosenRoom?.firestoreId);
      setSelectedRoomName(chosenRoom?.nome ?? '');

      let validInitial =
        initialDate && initialDate >= limits.minDate && (isAdmin || initialDate <= limits.maxDate)
          ? initialDate
          : limits.minDate;

      let initialView = getRoomScheduleSlotsForDate({
        room: chosenRoom,
        dateISO: validInitial,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        currentUserId: currentUser?.id,
      });

      if (!isAdmin && initialView.reservableCount === 0 && chosenRoom) {
        const releasedDates = getReleasedDatesForRoom(
          chosenRoom,
          limits.todayStr,
          availableSlots
        );
        for (const candidateDate of releasedDates) {
          const checkNoShow = checkNoShowSuspensionForDate(
            currentUser,
            effectivePunishments,
            candidateDate
          );
          if (checkNoShow.blocked) continue;
          const candidateView = getRoomScheduleSlotsForDate({
            room: chosenRoom,
            dateISO: candidateDate,
            config: scheduleConfig,
            exceptions: scheduleExceptions,
            availableSlots,
            reservations,
            currentUserId: currentUser?.id,
          });
          if (candidateView.reservableCount > 0) {
            validInitial = candidateDate;
            initialView = candidateView;
            break;
          }
        }
      }

      setDate(validInitial);

      const reservable = initialView.slots.filter((s) => s.selectableForUser);
      const normPrefillStart = initialStartTime ? normalizeTimeHHMM(initialStartTime) : '';
      const matched = normPrefillStart
        ? reservable.find((s) => s.inicio === normPrefillStart) || reservable[0]
        : reservable[0];

      if (matched) {
        setStartTime(matched.inicio);
        setEndTime(matched.fim);
        setSelectedAvailableSlotId(matched.availableSlotId);
      } else if (isAdmin) {
        setStartTime(normPrefillStart || scheduleConfig.janelaInicio || '17:00');
        setEndTime('17:50');
        setSelectedAvailableSlotId(undefined);
      } else {
        setStartTime('');
        setEndTime('');
        setSelectedAvailableSlotId(undefined);
      }

      if (initialCourse) setCurso(initialCourse);
      if (initialSemester) setSemestre(initialSemester);
    }
  }, [isOpen]);

  // Ajusta automaticamente o slot selecionado ao trocar sala, data ou quando o ADM altera `available_slots`
  React.useEffect(() => {
    if (!isOpen) return;
    const reservable = slotScheduleView.slots.filter((s) => s.selectableForUser);
    if (reservable.length > 0) {
      const stillValid = reservable.find(
        (s) =>
          s.inicio === normalizeTimeHHMM(startTime) &&
          s.fim === normalizeTimeHHMM(endTime)
      );
      if (stillValid) {
        if (selectedAvailableSlotId !== stillValid.availableSlotId) {
          setSelectedAvailableSlotId(stillValid.availableSlotId);
        }
      } else if (!isAdmin || !startTime || !endTime) {
        setStartTime(reservable[0].inicio);
        setEndTime(reservable[0].fim);
        setSelectedAvailableSlotId(reservable[0].availableSlotId);
      }
    } else if (!isAdmin) {
      setStartTime('');
      setEndTime('');
      setSelectedAvailableSlotId(undefined);
    }
  }, [date, selectedRoomObj?.firestoreId, slotScheduleView.slots, isAdmin, isOpen]);

  const conflictCheck = React.useMemo(() => {
    if (!selectedRoomObj || !date || !startTime || !endTime) {
      return { hasConflict: false as const };
    }
    const normStart = normalizeTimeHHMM(startTime);
    const normEnd = normalizeTimeHHMM(endTime);
    if (normStart >= normEnd) {
      return {
        hasConflict: true as const,
        conflictReason: 'O horário de início deve ser anterior ao horário de término.',
      };
    }

    const overlappingClass = slotScheduleView.curriculumClasses.find(
      (aula) => normStart < aula.horarioFim && normEnd > aula.horarioInicio
    );
    if (overlappingClass) {
      return {
        hasConflict: true as const,
        conflictReason: `Horário ocupado por aula regular da grade: "${overlappingClass.materia}" (${overlappingClass.horarioInicio} às ${overlappingClass.horarioFim}).`,
      };
    }

    const overlappingRes = reservations.find(
      (r) =>
        r.data === date &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA') &&
        (r.salaId === selectedRoomObj.firestoreId ||
          Boolean(selectedRoomObj.id && r.salaInstitutionalId === selectedRoomObj.id) ||
          Boolean(r.salaNome && doRoomNamesMatch(r.salaNome, selectedRoomObj.nome))) &&
        normStart < normalizeTimeHHMM(r.fim) &&
        normEnd > normalizeTimeHHMM(r.inicio)
    );
    if (overlappingRes) {
      return {
        hasConflict: true as const,
        conflictReason:
          overlappingRes.usuarioId === currentUser?.id
            ? `Você já possui uma reserva ativa neste horário (${overlappingRes.inicio} às ${overlappingRes.fim}).`
            : `Este horário (${overlappingRes.inicio} às ${overlappingRes.fim}) já está reservado por outro usuário.`,
      };
    }

    return { hasConflict: false as const };
  }, [
    selectedRoomObj,
    date,
    startTime,
    endTime,
    slotScheduleView.curriculumClasses,
    reservations,
    currentUser?.id,
  ]);

  if (!isOpen) return null;

  const isUserBlockedByQuotaOrNoShow =
    !isAdmin &&
    (availableRooms.length === 0 ||
      noShowCheck.blocked ||
      Boolean(quotaCheck && !quotaCheck.allowed));

  const isSubmitDisabled =
    isSubmitting ||
    conflictCheck.hasConflict ||
    !windowStatus.isOpen ||
    !startTime ||
    !endTime ||
    isUserBlockedByQuotaOrNoShow ||
    (!isAdmin &&
      (!blockRelease.released ||
        slotScheduleView.reservableCount === 0 ||
        !resolvedAvailableSlotId));

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
      if (!blockRelease.released || !resolvedAvailableSlotId) {
        toast.error(
          blockRelease.reason ||
            'Indisponível - Aguardando liberação da coordenação para esta sala nesta data.'
        );
        return;
      }
    }

    const room = selectedRoomObj || availableRooms[0];
    if (!room) {
      toast.error('Nenhuma sala liberada pelo administrador foi selecionada.');
      return;
    }

    const normStart = normalizeTimeHHMM(startTime);
    const normEnd = normalizeTimeHHMM(endTime);

    const validation = validateReservationRules({
      date,
      startTime: normStart,
      endTime: normEnd,
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

    const startDateTime = createSafeLocalDateTime(date, normStart);

    setIsSubmitting(true);
    try {
      await addReservation({
        salaId: room.firestoreId,
        salaInstitutionalId: room.id,
        salaNome: room.nome,
        usuarioId: currentUser.id,
        data: date,
        inicio: normStart,
        fim: normEnd,
        availableSlotId: isAdmin ? undefined : resolvedAvailableSlotId,
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
        getFriendlyErrorMessage(
          err,
          'Erro ao registrar reserva. Verifique sua cota semanal e permissões.'
        )
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
              Sujeito aos horários explicitamente liberados pela coordenação e à cota de 1 reserva por semana.
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
                    Antecedência até: <strong>{formatDataBR(roomDateLimits.maxDate)}</strong>
                  </span>
                </div>
              </div>
            )}

            {/* SALA */}
            <div>
              <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-slate-400" />
                Sala ou Laboratório
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

            {/* SELEÇÃO DE DATA (HOJE / AMANHÃ / CALENDÁRIO) */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-fatec-red" />
                Data da Consulta / Agendamento
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
              <input
                type="date"
                value={date}
                min={roomDateLimits.minDate}
                max={isAdmin ? undefined : roomDateLimits.maxDate}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                required
              />
            </div>

            {/* SELETOR DE HORÁRIOS FILTRADO PELA COLEÇÃO `available_slots` */}
            <RoomSlotSelector
              room={selectedRoomObj}
              date={date}
              selectedStartTime={startTime}
              selectedEndTime={endTime}
              onSelectDate={setDate}
              onSelectSlot={(slot) => {
                setStartTime(slot.inicio);
                setEndTime(slot.fim);
                setSelectedAvailableSlotId(slot.availableSlotId);
              }}
              disabledByUserRule={isUserBlockedByQuotaOrNoShow}
              isAdmin={isAdmin}
            />

            {/* HORÁRIOS MANUAIS EXCLUSIVOS PARA PERFIL ADM */}
            {isAdmin && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-slate-400" />
                    Início (ADM)
                  </label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-slate-400" />
                    Término (ADM)
                  </label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono tabular-nums font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red"
                    required
                  />
                </div>
              </div>
            )}

            {/* ALERTA DE CONFLITO OU CONFIRMAÇÃO DO HORÁRIO LIBERADO SELECIONADO */}
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
            ) : !isSubmitDisabled && startTime && endTime && startTime < endTime ? (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2 text-xs text-emerald-900 font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>
                  <strong>Horário Liberado Selecionado:</strong> {startTime} às {endTime}.
                </span>
              </div>
            ) : null}

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
                disabled={isSubmitDisabled}
                className={cn(
                  'px-5 py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap shrink-0',
                  isSubmitDisabled
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
