/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getTodayLocalISO, createSafeLocalDateTime } from './dateUtils';
import { DayOfWeek, ScheduleException, TimeBlock } from '../types';
import { useScheduleStore, DEFAULT_SCHEDULE_CONFIG } from '../store/useScheduleStore';
import { useRoomStore } from '../store/useRoomStore';
import {
  isSlotActiveOrReleased,
  matchesSlotRoom,
  useAvailableSlotsStore,
} from '../store/useAvailableSlotsStore';

export const RESERVATION_RULES = {
  get MIN_TIME() {
    return useScheduleStore.getState().config?.janelaInicio || DEFAULT_SCHEDULE_CONFIG.janelaInicio;
  },
  get MAX_TIME() {
    return useScheduleStore.getState().config?.janelaFim || DEFAULT_SCHEDULE_CONFIG.janelaFim;
  },
  get BOOKING_OPEN_HOUR() {
    return useScheduleStore.getState().config?.horaAberturaSistema ?? DEFAULT_SCHEDULE_CONFIG.horaAberturaSistema;
  },
  get MAX_ADVANCE_DAYS() {
    return useScheduleStore.getState().config?.antecedenciaMaximaDias ?? DEFAULT_SCHEDULE_CONFIG.antecedenciaMaximaDias;
  },
};

export const HOLIDAYS = [
  '01-01', // Confraternização Universal
  '21-04', // Tiradentes
  '01-05', // Dia do Trabalho
  '09-07', // Revolução Constitucionalista
  '07-09', // Independência do Brasil
  '12-10', // Nossa Senhora Aparecida
  '02-11', // Finados
  '15-11', // Proclamação da República
  '20-11', // Dia da Consciência Negra
  '25-12', // Natal
];

export function getDayNameFromISO(dateStr: string): DayOfWeek | 'Domingo' {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
  const days: (DayOfWeek | 'Domingo')[] = [
    'Domingo',
    'Segunda',
    'Terça',
    'Quarta',
    'Quinta',
    'Sexta',
    'Sábado',
  ];
  return days[date.getDay()];
}

export function isSundayOrHoliday(dateStr: string): boolean {
  if (!dateStr) return false;
  const date = new Date(dateStr + 'T12:00:00');
  if (date.getDay() === 0) return true; // Domingo

  const monthDay = dateStr.slice(5); // MM-DD
  return HOLIDAYS.includes(monthDay);
}

/**
 * Busca uma exceção de horário configurada pelo ADM aplicável à data e (opcionalmente) sala.
 */
export function findApplicableException(
  dateStr: string,
  salaFirestoreId?: string
): ScheduleException | undefined {
  const { exceptions } = useScheduleStore.getState();
  // Prioriza exceção específica da sala; caso não haja, usa exceção global ('TODAS')
  const roomSpecific = salaFirestoreId
    ? exceptions.find((ex) => ex.data === dateStr && ex.salaId === salaFirestoreId)
    : undefined;
  if (roomSpecific) return roomSpecific;

  return exceptions.find((ex) => ex.data === dateStr && (!ex.salaId || ex.salaId === 'TODAS'));
}

/**
 * Retorna a janela operacional efetiva (início, fim, blocos disponíveis, se está fechada) para uma data e sala.
 * REGRA DE BLOQUEIO PADRÃO: Por padrão, NENHUM horário fica disponível automaticamente.
 * Exige registros explícitos com status `liberado` ou `ativo` na coleção `available_slots` para a sala e data.
 */
export function getEffectiveWindowForDate(
  dateStr: string,
  salaFirestoreId?: string
): {
  isClosed: boolean;
  reason?: string;
  janelaInicio: string;
  janelaFim: string;
  blocks: TimeBlock[];
  exception?: ScheduleException;
} {
  const { config } = useScheduleStore.getState();
  const room = salaFirestoreId
    ? useRoomStore.getState().rooms.find((r) => r.firestoreId === salaFirestoreId)
    : undefined;

  if (room) {
    if (room.liberadaParaReserva === false) {
      return {
        isClosed: true,
        reason: 'Esta sala encontra-se bloqueada pelo administrador para agendamentos de usuários.',
        janelaInicio: config.janelaInicio,
        janelaFim: config.janelaFim,
        blocks: [],
      };
    }
    if (
      room.status === 'INATIVO' ||
      room.status === 'MANUTENCAO' ||
      room.statusManual === 'MANUTENCAO' ||
      Boolean(room.bloqueadaAte && room.bloqueadaAte > Date.now())
    ) {
      return {
        isClosed: true,
        reason: room.motivoBloqueio
          ? `Sala indisponível para agendamento: ${room.motivoBloqueio}`
          : 'Esta sala está em manutenção ou indisponível pela administração.',
        janelaInicio: config.janelaInicio,
        janelaFim: config.janelaFim,
        blocks: [],
      };
    }
  }

  if (!config.reservasAbertas) {
    return {
      isClosed: true,
      reason: 'A abertura de novos agendamentos encontra-se suspensa pela Coordenação.',
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      blocks: [],
    };
  }

  const exception = findApplicableException(dateStr, salaFirestoreId);

  if (exception?.fechado) {
    return {
      isClosed: true,
      reason: `Data bloqueada pela Coordenação (${exception.titulo}${
        exception.motivo ? `: ${exception.motivo}` : ''
      }).`,
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      blocks: [],
      exception,
    };
  }

  if (!exception && isSundayOrHoliday(dateStr)) {
    return {
      isClosed: true,
      reason: 'Não é permitido realizar reservas aos domingos ou feriados oficiais.',
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      blocks: [],
    };
  }

  const dayName = getDayNameFromISO(dateStr);
  if (
    !exception &&
    (dayName === 'Domingo' ||
      (config.diasSemanaPermitidos &&
        config.diasSemanaPermitidos.length > 0 &&
        !config.diasSemanaPermitidos.includes(dayName)))
  ) {
    return {
      isClosed: true,
      reason: `Agendamentos não estão habilitados para ${dayName} nas regras operacionais vigentes.`,
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      blocks: [],
    };
  }

  // Filtra estritamente registros explícitos de `available_slots` criados e liberados pelo ADM
  const allAvailableSlots = useAvailableSlotsStore.getState().slots;
  const releasedSlots = allAvailableSlots
    .filter((slot) => {
      if (slot.data !== dateStr) return false;
      if (!isSlotActiveOrReleased(slot)) return false;
      if (room) return matchesSlotRoom(slot, room);
      if (salaFirestoreId) return slot.salaId === salaFirestoreId;
      return true;
    })
    .sort((a, b) => a.inicio.localeCompare(b.inicio));

  const baseJanelaInicio = exception?.janelaInicio || config.janelaInicio;
  const baseJanelaFim = exception?.janelaFim || config.janelaFim;

  if (releasedSlots.length === 0) {
    return {
      isClosed: true,
      reason: 'Indisponível - Aguardando liberação da coordenação para esta sala nesta data.',
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      blocks: [],
      exception,
    };
  }

  const releasedBlocks: TimeBlock[] = releasedSlots.map((slot) => ({
    id: slot.id,
    label: slot.label || `Horário ${slot.inicio}–${slot.fim}`,
    inicio: slot.inicio,
    fim: slot.fim,
    ativo: true,
  }));

  const minReleasedStart = releasedBlocks.reduce(
    (min, b) => (b.inicio < min ? b.inicio : min),
    baseJanelaInicio
  );
  const maxReleasedEnd = releasedBlocks.reduce(
    (max, b) => (b.fim > max ? b.fim : max),
    baseJanelaFim
  );

  return {
    isClosed: false,
    janelaInicio: minReleasedStart,
    janelaFim: maxReleasedEnd,
    blocks: releasedBlocks,
    exception,
  };
}

/**
 * Verifica se o sistema de reservas está aberto no momento.
 */
export function isBookingWindowOpen(
  referenceDate = new Date(),
  isAdmin = false
): { isOpen: boolean; message?: string } {
  const { config } = useScheduleStore.getState();

  if (!config.reservasAbertas && !isAdmin) {
    return {
      isOpen: false,
      message:
        'A abertura de novos agendamentos encontra-se temporariamente suspensa pela Coordenação.',
    };
  }

  const openHour = config.horaAberturaSistema ?? 6;
  const currentHour = referenceDate.getHours();
  if (currentHour < openHour && !isAdmin) {
    const formattedHour = `${String(openHour).padStart(2, '0')}:00`;
    return {
      isOpen: false,
      message: `O sistema de reservas abre às ${formattedHour}. Por favor, retorne a partir desse horário para realizar agendamentos.`,
    };
  }

  return { isOpen: true };
}

/**
 * Retorna as datas mínima e máxima permitidas de acordo com `antecedenciaMaximaDias` configurado pelo ADM.
 */
export function getReservationDateLimits(referenceDate = new Date()) {
  const { config } = useScheduleStore.getState();
  const advanceDays = Math.max(0, config.antecedenciaMaximaDias ?? 1);

  const todayStr = getTodayLocalISO(referenceDate);

  const tomorrowDate = new Date(referenceDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = getTodayLocalISO(tomorrowDate);

  const maxDateObj = new Date(referenceDate);
  maxDateObj.setDate(maxDateObj.getDate() + advanceDays);
  const maxDate = getTodayLocalISO(maxDateObj);

  return {
    minDate: todayStr,
    maxDate,
    todayStr,
    tomorrowStr,
    advanceDays,
  };
}

/**
 * Validação abrangente de regras de negócio para uma nova reserva (sincronizada em tempo real com `schedules` e `salas`).
 */
export function validateReservationRules(
  data: { date: string; startTime: string; endTime: string; salaFirestoreId?: string; isAdmin?: boolean },
  referenceDate = new Date()
): { valid: boolean; error?: string } {
  const isAdmin = Boolean(data.isAdmin);
  const windowStatus = isBookingWindowOpen(referenceDate, isAdmin);
  if (!windowStatus.isOpen) {
    return { valid: false, error: windowStatus.message };
  }

  const { minDate, maxDate, todayStr, advanceDays } = getReservationDateLimits(referenceDate);

  if (!data.date) {
    return { valid: false, error: 'Selecione uma data para a reserva.' };
  }

  if (data.date < minDate) {
    return { valid: false, error: 'A data da reserva não pode ser anterior a hoje.' };
  }

  if (!isAdmin && data.date > maxDate) {
    return {
      valid: false,
      error:
        advanceDays === 1
          ? 'Reservas antecipadas só podem ser feitas até o dia seguinte (amanhã).'
          : `Reservas antecipadas estão limitadas a até ${advanceDays} dias de antecedência.`,
    };
  }

  const effective = getEffectiveWindowForDate(data.date, data.salaFirestoreId);
  if (effective.isClosed && !isAdmin) {
    return { valid: false, error: effective.reason || 'Data indisponível para agendamento.' };
  }

  if (!data.startTime || !data.endTime) {
    return { valid: false, error: 'Selecione um bloco de horário liberado pelo administrador.' };
  }

  if (
    !isAdmin &&
    (data.startTime < effective.janelaInicio || data.endTime > effective.janelaFim)
  ) {
    return {
      valid: false,
      error: `Para esta data, as reservas são permitidas das ${effective.janelaInicio} às ${effective.janelaFim}.`,
    };
  }

  if (data.startTime >= data.endTime) {
    return { valid: false, error: 'O horário de término deve ser posterior ao horário de início.' };
  }

  // Para usuários comuns, exige que o horário selecionado corresponda a um bloco ativo liberado pelo ADM
  if (!isAdmin) {
    const matchesReleasedBlock = effective.blocks.some(
      (b) => b.ativo && b.inicio === data.startTime && b.fim === data.endTime
    );
    if (!matchesReleasedBlock) {
      return {
        valid: false,
        error:
          'Selecione exclusivamente um dos blocos de horários liberados pelo administrador para esta sala.',
      };
    }
  }

  if (data.date === todayStr) {
    const startDateTime = createSafeLocalDateTime(data.date, data.startTime);
    const nowWithTolerance = new Date(referenceDate.getTime() - 60000);
    if (startDateTime < nowWithTolerance) {
      return { valid: false, error: 'O horário de início da reserva não pode ser no passado.' };
    }
  }

  return { valid: true };
}
