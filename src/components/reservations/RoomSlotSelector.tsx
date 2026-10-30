/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import {
  CheckCircle2,
  Clock,
  GraduationCap,
  Lock,
  CalendarX2,
} from 'lucide-react';
import { Room } from '../../types';
import { useAvailableSlotsStore } from '../../store/useAvailableSlotsStore';
import { useReservationStore } from '../../store/useReservationStore';
import { useScheduleStore } from '../../store/useScheduleStore';
import {
  UNAVAILABLE_AWAITING_RELEASE_LABEL,
  getRoomScheduleSlotsForDate,
} from '../../services/reservationService';
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
  disabledByUserRule?: boolean;
  isAdmin?: boolean;
}

/**
 * Componente de seleção de horários da sala (`RoomSlotSelector` / `RoomSchedule`).
 * - Bloqueio Padrão: por padrão, nenhum horário aparece livre para o perfil Usuário/Aluno.
 * - Liberação do ADM: apenas registros explícitos na coleção `available_slots` com status
 *   `liberado` ou `ativo` (e sem conflitos de aula/reserva) ficam habilitados para clique.
 * - Os demais horários permanecem desabilitados com indicador visual explícito
 *   ("Indisponível - Aguardando liberação da coordenação").
 */
export function RoomSlotSelector({
  room,
  date,
  selectedStartTime,
  selectedEndTime,
  onSelectSlot,
  disabledByUserRule = false,
  isAdmin = false,
}: RoomSlotSelectorProps) {
  const availableSlots = useAvailableSlotsStore((state) => state.slots);
  const reservations = useReservationStore((state) => state.reservations);
  const scheduleConfig = useScheduleStore((state) => state.config);
  const scheduleExceptions = useScheduleStore((state) => state.exceptions);

  const scheduleView = useMemo(
    () =>
      getRoomScheduleSlotsForDate({
        room,
        dateISO: date,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
      }),
    [room, date, scheduleConfig, scheduleExceptions, availableSlots, reservations]
  );

  // Aulas regulares da grade nesta sala que ocorram fora das faixas horárias listadas (ex: manhã/sábado)
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
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-slate-100 text-slate-600 border-slate-200'
          )}
        >
          {scheduleView.reservableCount}{' '}
          {scheduleView.reservableCount === 1 ? 'horário liberado' : 'horários liberados'}
        </span>
      </div>

      {/* AVISO QUANDO NENHUM HORÁRIO FOI LIBERADO PELO ADM NA DATA */}
      {!isAdmin && scheduleView.reservableCount === 0 && (
        <div className="p-3 bg-slate-100/90 border border-slate-200 rounded-xl flex items-start gap-2.5 text-xs text-slate-700">
          <Lock className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-bold text-slate-900">
              {UNAVAILABLE_AWAITING_RELEASE_LABEL}
            </p>
            <p className="text-[11px] text-slate-600 leading-relaxed">
              Nenhum horário foi liberado pelo Administrador para esta sala na data selecionada. Somente horários com liberação ativa pela coordenação ficam habilitados para reserva.
            </p>
          </div>
        </div>
      )}

      {/* OCUPAÇÃO ACADÊMICA EXTRA (AULAS REGULARES FORA DOS BLOCOS LISTADOS) */}
      {extraCurriculumClasses.length > 0 && (
        <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-1.5">
          <p className="text-[11px] font-bold text-emerald-950 flex items-center gap-1.5">
            <GraduationCap className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
            Ocupação da Grade Acadêmica Regular nesta Sala:
          </p>
          <div className="space-y-1">
            {extraCurriculumClasses.map((aula) => (
              <div
                key={aula.id}
                className="flex items-center justify-between gap-2 bg-white/90 border border-emerald-200/80 rounded-lg px-2.5 py-1.5 text-[11px] text-emerald-950"
              >
                <span className="font-semibold truncate">
                  {aula.materia} ({aula.curso} · {aula.semestre}º Sem)
                </span>
                <span className="font-mono tabular-nums font-bold shrink-0">
                  {aula.horarioInicio} – {aula.horarioFim}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LISTA DE SLOTS DA SALA (APENAS `liberado` / `ativo` SÃO CLICÁVEIS PARA USUÁRIO) */}
      {scheduleView.slots.length === 0 ? (
        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center gap-2">
          <CalendarX2 className="h-4 w-4 text-slate-400 shrink-0" />
          <span>{UNAVAILABLE_AWAITING_RELEASE_LABEL}</span>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
          {scheduleView.slots.map((slot) => {
            const isLiberado = slot.state === 'LIBERADO';
            const isAula = slot.state === 'OCUPADO_AULA';
            const isReserva = slot.state === 'OCUPADO_RESERVA';
            const isSelected =
              selectedStartTime === slot.inicio && selectedEndTime === slot.fim;

            const canClick = isAdmin
              ? !isReserva && !isAula
              : slot.selectableForUser && !disabledByUserRule;

            return (
              <button
                key={slot.key}
                type="button"
                disabled={!canClick}
                onClick={() => {
                  if (!canClick) return;
                  onSelectSlot({
                    inicio: slot.inicio,
                    fim: slot.fim,
                    availableSlotId: slot.availableSlotId,
                  });
                }}
                className={cn(
                  'w-full px-3 py-2.5 rounded-xl border text-left transition-all flex items-center justify-between gap-3',
                  canClick && isSelected
                    ? 'bg-slate-900 border-slate-900 text-white shadow-xs cursor-pointer'
                    : canClick && isLiberado
                    ? 'bg-emerald-50/70 hover:bg-emerald-100/70 border-emerald-300 text-slate-900 cursor-pointer'
                    : canClick && isAdmin
                    ? 'bg-white hover:bg-slate-50 border-slate-200 text-slate-800 cursor-pointer'
                    : isAula
                    ? 'bg-emerald-50/40 border-emerald-200/80 text-emerald-900 opacity-85 cursor-not-allowed'
                    : isReserva
                    ? 'bg-rose-50/50 border-rose-200 text-rose-900 opacity-80 cursor-not-allowed'
                    : 'bg-slate-100/90 border-slate-200 text-slate-500 cursor-not-allowed'
                )}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-mono tabular-nums text-xs font-bold shrink-0',
                        canClick && isSelected
                          ? 'text-white'
                          : isLiberado
                          ? 'text-emerald-950'
                          : isAula
                          ? 'text-emerald-900'
                          : isReserva
                          ? 'text-rose-900 line-through'
                          : 'text-slate-600'
                      )}
                    >
                      {slot.inicio} – {slot.fim}
                    </span>
                    <span
                      className={cn(
                        'text-[11px] font-medium truncate',
                        canClick && isSelected ? 'text-slate-300' : 'opacity-80'
                      )}
                    >
                      {slot.label}
                    </span>
                  </div>

                  <p
                    className={cn(
                      'text-[11px] leading-snug truncate',
                      canClick && isSelected
                        ? 'text-emerald-300 font-medium'
                        : isLiberado
                        ? 'text-emerald-800 font-medium'
                        : isAula
                        ? 'text-emerald-800'
                        : isReserva
                        ? 'text-rose-800'
                        : 'text-slate-500'
                    )}
                  >
                    {isAdmin && slot.state === 'AGUARDANDO_LIBERACAO'
                      ? 'Bloqueado p/ Alunos (ADM pode reservar ou liberar em Horários)'
                      : slot.statusDetail}
                  </p>
                </div>

                {/* INDICADOR VISUAL À DIREITA */}
                <div className="shrink-0 flex items-center">
                  {canClick && isSelected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500 text-white text-[10px] font-bold">
                      <CheckCircle2 className="h-3 w-3" />
                      Selecionado
                    </span>
                  ) : isLiberado ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-bold">
                      <CheckCircle2 className="h-3 w-3" />
                      {slot.statusBadge}
                    </span>
                  ) : isAula ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-200/80 text-emerald-950 text-[10px] font-bold">
                      <GraduationCap className="h-3 w-3" />
                      Aula Regular
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-200/90 text-slate-600 text-[10px] font-semibold">
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
    </div>
  );
}
