/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  CalendarX2,
  CheckCircle2,
  Clock,
  FileText,
  GraduationCap,
  Lock,
  MapPin,
  QrCode,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { Room } from '../../types';
import { useAuthStore } from '../../store/useAuthStore';
import { useAvailableSlotsStore } from '../../store/useAvailableSlotsStore';
import { useReservationStore } from '../../store/useReservationStore';
import { useScheduleStore } from '../../store/useScheduleStore';
import {
  UNAVAILABLE_AWAITING_RELEASE_LABEL,
  getReleasedDatesForRoom,
  getRoomScheduleSlotsForDate,
} from '../../services/reservationService';
import { formatDataBR, getTodayLocalISO } from '../../utils/dateUtils';
import { cn } from '../../lib/utils';

export interface SelectedSlotValue {
  inicio: string;
  fim: string;
  availableSlotId?: string;
}

interface RoomSlotSelectorProps {
  room: Room | undefined | null;
  date: string; // YYYY-MM-DD
  selectedStartTime: string;
  selectedEndTime: string;
  onSelectSlot: (slot: SelectedSlotValue) => void;
  onSelectDate?: (dateISO: string) => void;
  disabledByUserRule?: boolean;
  isAdmin?: boolean;
}

/**
 * Componente de seleção e visualização da grade de horários (`RoomSlotSelector` / `RoomSchedule`).
 * Aplica os 5 estados visuais e comportamentais da grade:
 * - Aulas Regulares (`OCUPADO_AULA`): Status `"Ocupado"` em Azul, bloqueado para clique.
 * - Reservado por Outro Usuário (`OCUPADO_RESERVA_OUTRO`): Status `"Reservado"` em Vermelho, bloqueado para clique.
 * - Reservado pelo Próprio Usuário (`OCUPADO_RESERVA_PROPRIA`): Status `"Sua Reserva"` em Verde, clicável para exibir detalhes da reserva.
 * - Horários Liberados pelo ADM (`LIBERADO`): Status `"Disponível"` com borda destacada interativa, habilitado para clique e reserva.
 * - Horários Não Liberados (`AGUARDANDO_LIBERACAO` / `ENCERRADO`): Status `"Indisponível"` em Cinza/Desabilitado, bloqueado para clique.
 */
export function RoomSlotSelector({
  room,
  date,
  selectedStartTime,
  selectedEndTime,
  onSelectSlot,
  onSelectDate,
  isAdmin = false,
}: RoomSlotSelectorProps) {
  const currentUser = useAuthStore((state) => state.user);
  const rawAvailableSlots = useAvailableSlotsStore((state) => state.slots);
  const slotsLoading = useAvailableSlotsStore((state) => state.loading);
  const rawReservations = useReservationStore((state) => state.reservations);
  const resLoading = useReservationStore((state) => state.loading);
  const scheduleConfig = useScheduleStore((state) => state.config);
  const rawExceptions = useScheduleStore((state) => state.exceptions);

  const availableSlots = useMemo(
    () => (Array.isArray(rawAvailableSlots) ? rawAvailableSlots : []),
    [rawAvailableSlots]
  );
  const reservations = useMemo(
    () => (Array.isArray(rawReservations) ? rawReservations : []),
    [rawReservations]
  );
  const scheduleExceptions = useMemo(
    () => (Array.isArray(rawExceptions) ? rawExceptions : []),
    [rawExceptions]
  );

  const [inspectedOwnSlotKey, setInspectedOwnSlotKey] = useState<string | null>(null);

  const scheduleView = useMemo(
    () =>
      getRoomScheduleSlotsForDate({
        room,
        dateISO: date,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        currentUserId: currentUser?.id,
      }),
    [
      room,
      date,
      scheduleConfig,
      scheduleExceptions,
      availableSlots,
      reservations,
      currentUser?.id,
    ]
  );

  // Datas futuras/atuais com horários efetivamente disponíveis para esta sala (atalho rápido caso a data atual não tenha)
  const releasedDatesWithSlots = useMemo(() => {
    if (!room) return [];
    const todayISO = getTodayLocalISO();
    const candidateDates = getReleasedDatesForRoom(room, todayISO, availableSlots);
    return candidateDates.filter((d) => {
      const view = getRoomScheduleSlotsForDate({
        room,
        dateISO: d,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        currentUserId: currentUser?.id,
      });
      return view.reservableCount > 0;
    });
  }, [
    room,
    availableSlots,
    scheduleConfig,
    scheduleExceptions,
    reservations,
    currentUser?.id,
  ]);

  const ownReservationSlots = useMemo(
    () =>
      scheduleView.slots.filter(
        (s) => s.state === 'OCUPADO_RESERVA_PROPRIA' && Boolean(s.reservation)
      ),
    [scheduleView.slots]
  );

  // Sincroniza exibição automática de detalhes caso o próprio usuário tenha reserva nesta sala/data
  useEffect(() => {
    if (ownReservationSlots.length === 0) {
      setInspectedOwnSlotKey(null);
      return;
    }
    const stillExists = ownReservationSlots.some((s) => s.key === inspectedOwnSlotKey);
    if (!stillExists) {
      setInspectedOwnSlotKey(ownReservationSlots[0].key);
    }
  }, [ownReservationSlots, inspectedOwnSlotKey]);

  const inspectedOwnReservation = useMemo(() => {
    if (!inspectedOwnSlotKey) return null;
    return (
      ownReservationSlots.find((s) => s.key === inspectedOwnSlotKey)?.reservation || null
    );
  }, [ownReservationSlots, inspectedOwnSlotKey]);

  // Aulas regulares da grade nesta sala que ocorram fora das faixas horárias listadas
  const extraCurriculumClasses = useMemo(() => {
    return scheduleView.curriculumClasses.filter(
      (aula) =>
        !scheduleView.slots.some(
          (slot) => slot.inicio < aula.horarioFim && slot.fim > aula.horarioInicio
        )
    );
  }, [scheduleView]);

  if (!room) {
    return (
      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
        Selecione uma sala para consultar os horários da grade e eventuais liberações da coordenação.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* CABEÇALHO DE DISPONIBILIDADE */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-fatec-red" />
          Grade de Horários da Sala
        </span>
        <span
          className={cn(
            'text-[11px] font-semibold px-2 py-0.5 rounded-md border font-mono tabular-nums',
            scheduleView.reservableCount > 0
              ? 'bg-amber-50 text-amber-900 border-amber-300'
              : 'bg-slate-100 text-slate-600 border-slate-200'
          )}
        >
          {scheduleView.reservableCount}{' '}
          {scheduleView.reservableCount === 1 ? 'disponível' : 'disponíveis'}
        </span>
      </div>

      {/* LEGENDA COMPACTA DOS 5 STATUS DA GRADE */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 bg-slate-50 border border-slate-200/80 rounded-xl text-[11px] text-slate-700">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="h-2.5 w-2.5 rounded-xs bg-blue-600 shrink-0" />
          Ocupado (Aula)
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="h-2.5 w-2.5 rounded-xs bg-rose-600 shrink-0" />
          Reservado
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="h-2.5 w-2.5 rounded-xs bg-emerald-600 shrink-0" />
          Sua Reserva
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="h-2.5 w-2.5 rounded-xs bg-amber-400 border border-amber-600 shrink-0" />
          Disponível
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium text-slate-500">
          <span className="h-2.5 w-2.5 rounded-xs bg-slate-300 shrink-0" />
          Indisponível
        </span>
      </div>

      {/* ATALHO DE DATAS COM HORÁRIOS LIBERADOS PELO ADM */}
      {onSelectDate && releasedDatesWithSlots.length > 0 && (
        <div className="p-2.5 bg-amber-50/60 border border-amber-200 rounded-xl space-y-1.5">
          <p className="text-[11px] font-semibold text-amber-950 flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-amber-700 shrink-0" />
            Datas com horários liberados nesta sala:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {releasedDatesWithSlots.map((d) => {
              const active = d === date;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onSelectDate(d)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-[11px] font-mono tabular-nums font-bold border transition-colors cursor-pointer whitespace-nowrap',
                    active
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white hover:bg-amber-100/70 text-slate-900 border-amber-300'
                  )}
                >
                  {formatDataBR(d)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* AVISO QUANDO NENHUM HORÁRIO FOI LIBERADO PELO ADM NA DATA */}
      {!isAdmin && scheduleView.reservableCount === 0 && ownReservationSlots.length === 0 && (
        <div className="p-3 bg-slate-100 border border-slate-200 rounded-xl flex items-start gap-2.5 text-xs text-slate-700">
          <Lock className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-bold text-slate-900">
              {UNAVAILABLE_AWAITING_RELEASE_LABEL}
            </p>
            <p className="text-[11px] text-slate-600 leading-relaxed">
              Nenhum horário está disponível para reserva nesta data. Apenas horários liberados pelo Administrador aparecem habilitados como Disponível.
            </p>
          </div>
        </div>
      )}

      {/* OCUPAÇÃO ACADÊMICA EXTRA (AULAS REGULARES FORA DOS BLOCOS LISTADOS — AZUL) */}
      {extraCurriculumClasses.length > 0 && (
        <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-xl space-y-1.5">
          <p className="text-[11px] font-bold text-blue-950 flex items-center gap-1.5">
            <GraduationCap className="h-3.5 w-3.5 text-blue-700 shrink-0" />
            Aulas Regulares na Sala (Ocupado):
          </p>
          <div className="space-y-1">
            {extraCurriculumClasses.map((aula) => (
              <div
                key={aula.id}
                className="flex items-center justify-between gap-2 bg-white/90 border border-blue-200 rounded-lg px-2.5 py-1.5 text-[11px] text-blue-950"
              >
                <span className="font-semibold truncate">
                  {aula.materia} ({aula.curso} · {aula.semestre}º Sem)
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono tabular-nums font-bold">
                    {aula.horarioInicio} – {aula.horarioFim}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-blue-600 text-white text-[10px] font-bold">
                    Ocupado
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GRADE DE SLOTS DA SALA */}
      {(slotsLoading || resLoading) && scheduleView.slots.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div
              key={idx}
              className="h-12 bg-slate-100 border border-slate-200 rounded-xl animate-pulse"
            />
          ))}
        </div>
      ) : scheduleView.slots.length === 0 ? (
        <div className="p-3.5 bg-slate-100 border border-slate-200 rounded-xl text-xs text-slate-500 flex items-center gap-2">
          <CalendarX2 className="h-4 w-4 text-slate-400 shrink-0" />
          <span>Indisponível · {UNAVAILABLE_AWAITING_RELEASE_LABEL}</span>
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
          {scheduleView.slots.map((slot) => {
            const isLiberado = slot.state === 'LIBERADO';
            const isAula = slot.state === 'OCUPADO_AULA';
            const isReservaOutro = slot.state === 'OCUPADO_RESERVA_OUTRO';
            const isReservaPropria = slot.state === 'OCUPADO_RESERVA_PROPRIA';
            const isIndisponivel =
              slot.state === 'AGUARDANDO_LIBERACAO' || slot.state === 'ENCERRADO';

            const isSelected =
              isLiberado &&
              selectedStartTime === slot.inicio &&
              selectedEndTime === slot.fim;
            const isSelectedByAdmin =
              isAdmin &&
              !isAula &&
              !isReservaOutro &&
              !isReservaPropria &&
              selectedStartTime === slot.inicio &&
              selectedEndTime === slot.fim;

            // Horários Liberados (`LIBERADO`) e `Sua Reserva` (`OCUPADO_RESERVA_PROPRIA`) permitem clique
            const canSelectForBooking = isAdmin
              ? !isAula && !isReservaOutro && !isReservaPropria
              : isLiberado;
            const canClick = canSelectForBooking || isReservaPropria;

            return (
              <button
                key={slot.key}
                type="button"
                disabled={!canClick}
                onClick={() => {
                  if (isReservaPropria) {
                    setInspectedOwnSlotKey((prev) =>
                      prev === slot.key ? null : slot.key
                    );
                    return;
                  }
                  if (!canSelectForBooking) return;
                  onSelectSlot({
                    inicio: slot.inicio,
                    fim: slot.fim,
                    availableSlotId: slot.availableSlotId,
                  });
                }}
                className={cn(
                  'w-full px-3.5 py-2.5 rounded-xl text-left transition-colors flex items-center justify-between gap-3',
                  (isSelected || isSelectedByAdmin)
                    ? 'bg-slate-900 border-2 border-slate-900 text-white cursor-pointer'
                    : isLiberado
                    ? 'bg-amber-50/50 hover:bg-amber-50 border-2 border-amber-400 hover:border-amber-500 text-slate-900 cursor-pointer'
                    : isReservaPropria
                    ? 'bg-emerald-50 hover:bg-emerald-100/80 border border-emerald-300 text-emerald-950 cursor-pointer'
                    : isAula
                    ? 'bg-blue-50 border border-blue-200 text-blue-950 cursor-not-allowed'
                    : isReservaOutro
                    ? 'bg-rose-50 border border-rose-200 text-rose-950 cursor-not-allowed'
                    : isAdmin && canSelectForBooking
                    ? 'bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 cursor-pointer'
                    : isIndisponivel
                    ? 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed'
                )}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-mono tabular-nums text-xs font-bold shrink-0',
                        (isSelected || isSelectedByAdmin)
                          ? 'text-white'
                          : isLiberado
                          ? 'text-slate-900'
                          : isReservaPropria
                          ? 'text-emerald-950'
                          : isAula
                          ? 'text-blue-950'
                          : isReservaOutro
                          ? 'text-rose-950'
                          : 'text-slate-500'
                      )}
                    >
                      {slot.inicio} – {slot.fim}
                    </span>
                    <span
                      className={cn(
                        'text-[11px] font-medium truncate',
                        (isSelected || isSelectedByAdmin)
                          ? 'text-slate-300'
                          : isIndisponivel && !isAdmin
                          ? 'text-slate-400'
                          : 'opacity-85'
                      )}
                    >
                      {slot.label}
                    </span>
                  </div>

                  <p
                    className={cn(
                      'text-[11px] leading-snug truncate',
                      (isSelected || isSelectedByAdmin)
                        ? 'text-amber-300 font-medium'
                        : isLiberado
                        ? 'text-amber-900 font-medium'
                        : isReservaPropria
                        ? 'text-emerald-800 font-medium'
                        : isAula
                        ? 'text-blue-800'
                        : isReservaOutro
                        ? 'text-rose-800'
                        : 'text-slate-400'
                    )}
                  >
                    {isAdmin && slot.state === 'AGUARDANDO_LIBERACAO'
                      ? 'Indisponível p/ Alunos (ADM pode reservar ou liberar em Horários)'
                      : slot.statusDetail}
                  </p>
                </div>

                {/* INDICADOR DE STATUS À DIREITA */}
                <div className="shrink-0 flex items-center">
                  {(isSelected || isSelectedByAdmin) ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-400 text-slate-950 text-[10px] font-bold whitespace-nowrap">
                      <CheckCircle2 className="h-3 w-3" />
                      Selecionado
                    </span>
                  ) : isLiberado ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-400 text-slate-950 text-[10px] font-bold whitespace-nowrap">
                      <CheckCircle2 className="h-3 w-3" />
                      Disponível
                    </span>
                  ) : isReservaPropria ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[10px] font-bold whitespace-nowrap">
                      <UserCheck className="h-3 w-3" />
                      Sua Reserva
                    </span>
                  ) : isAula ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 text-white text-[10px] font-bold whitespace-nowrap">
                      <GraduationCap className="h-3 w-3" />
                      Ocupado
                    </span>
                  ) : isReservaOutro ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-rose-600 text-white text-[10px] font-bold whitespace-nowrap">
                      <XCircle className="h-3 w-3" />
                      Reservado
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-200 text-slate-600 text-[10px] font-semibold whitespace-nowrap">
                      <Lock className="h-3 w-3" />
                      Indisponível
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* PAINEL DE DETALHES DA RESERVA DO PRÓPRIO USUÁRIO LOGADO (`Sua Reserva` — VERDE) */}
      {inspectedOwnReservation && (
        <div className="p-3.5 bg-emerald-50/90 border border-emerald-300 rounded-xl space-y-2 text-xs text-emerald-950">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold flex items-center gap-1.5 text-emerald-950">
              <UserCheck className="h-4 w-4 text-emerald-700 shrink-0" />
              Detalhes da Sua Reserva
            </span>
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold">
              {inspectedOwnReservation.status === 'CONFIRMADA'
                ? 'Check-in Confirmado'
                : 'Aguardando Check-in'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
              <span className="truncate font-semibold">
                {inspectedOwnReservation.salaNome || room.nome}
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-mono tabular-nums font-bold">
              <Clock className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
              <span>
                {formatDataBR(inspectedOwnReservation.data)} · {inspectedOwnReservation.inicio} às{' '}
                {inspectedOwnReservation.fim}
              </span>
            </div>
          </div>

          {inspectedOwnReservation.observacoes && (
            <p className="text-[11px] text-emerald-900 flex items-start gap-1.5 pt-0.5">
              <FileText className="h-3.5 w-3.5 text-emerald-700 shrink-0 mt-0.5" />
              <span>{inspectedOwnReservation.observacoes}</span>
            </p>
          )}

          {inspectedOwnReservation.status === 'PENDENTE' && (
            <p className="text-[11px] text-emerald-800 flex items-center gap-1.5 pt-0.5">
              <QrCode className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
              <span>
                Apresente-se na sala e valide o QR Code em até 5 minutos após o início ({inspectedOwnReservation.inicio}).
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
