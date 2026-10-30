/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getTodayLocalISO, createSafeLocalDateTime, normalizeDateToISO } from './dateUtils';
import { DayOfWeek, ScheduleException, TimeBlock } from '../types';
import { useScheduleStore, DEFAULT_SCHEDULE_CONFIG } from '../store/useScheduleStore';
import { useRoomStore } from '../store/useRoomStore';
import {
  isSlotActiveOrReleased,
  matchesSlotRoom,
  normalizeTimeHHMM,
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
  if (!dateStr || typeof dateStr !== 'string') return 'Segunda';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y || 2000, (m || 1) - 1, d || 1, 12, 0, 0);
  if (isNaN(date.getTime())) return 'Segunda';
  const days: (DayOfWeek | 'Domingo')[] = [
    'Domingo',
    'Segunda',
    'Terça',
    'Quarta',
    'Quinta',
    'Sexta',
    'Sábado',
  ];
  return days[date.getDay()] || 'Segunda';
}

export function isSundayOrHoliday(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const date = new Date(dateStr + 'T12:00:00');
  if (isNaN(date.getTime())) return false;
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
  const rawExceptions = useScheduleStore.getState().exceptions;
  const exceptions = Array.isArray(rawExceptions) ? rawExceptions : [];
  const roomSpecific = salaFirestoreId
    ? exceptions.find((ex) => ex?.data === dateStr && ex.salaId === salaFirestoreId)
    : undefined;
  if (roomSpecific) return roomSpecific;

  return exceptions.find((ex) => ex?.data === dateStr && (!ex.salaId || ex.salaId === 'TODAS'));
}

/**
 * Retorna a janela operacional efetiva (início, fim, blocos disponíveis, se está fechada) para uma data e sala.
 * REGRA DE BLOQUEIO PADRÃO: Por padrão, NENHUM horário fica disponível automaticamente.
 * Exige registros explícitos com status `liberado`, `ativo` ou `disponivel` na coleção `available_slots` para a sala e data.
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
  const normalizedDate = normalizeDateToISO(dateStr);
  const config = useScheduleStore.getState().config || DEFAULT_SCHEDULE_CONFIG;
  const rawRooms = useRoomStore.getState().rooms;
  const safeRooms = Array.isArray(rawRooms) ? rawRooms : [];
  const room = salaFirestoreId
    ? safeRooms.find((r) => r?.firestoreId === salaFirestoreId || r?.id === salaFirestoreId)
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

  if (config.reservasAbertas === false) {
    return {
      isClosed: true,
      reason: 'A abertura de novos agendamentos encontra-se suspensa pela Coordenação.',
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      blocks: [],
    };
  }

  const exception = findApplicableException(normalizedDate, room?.firestoreId || salaFirestoreId);

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

  // Filtra estritamente registros explícitos de `available_slots` criados e liberados pelo ADM
  const rawAvailableSlots = useAvailableSlotsStore.getState().slots;
  const allAvailableSlots = Array.isArray(rawAvailableSlots) ? rawAvailableSlots : [];
  const releasedSlots = allAvailableSlots
    .filter((slot) => {
      if (!slot || slot.data !== normalizedDate) return false;
      if (!isSlotActiveOrReleased(slot)) return false;
      if (room) return matchesSlotRoom(slot, room);
      if (salaFirestoreId) {
        return slot.salaId === salaFirestoreId || slot.salaInstitutionalId === salaFirestoreId;
      }
      return true;
    })
    .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

  const baseJanelaInicio = exception?.janelaInicio || config.janelaInicio;
  const baseJanelaFim = exception?.janelaFim || config.janelaFim;

  // Se o ADM liberou explicitamente horários em `available_slots` para esta sala e data,
  // autoriza o agendamento exatamente nos blocos liberados.
  if (releasedSlots.length > 0) {
    const releasedBlocks: TimeBlock[] = releasedSlots.map((slot) => ({
      id: slot.id,
      label: slot.label || `Horário ${slot.inicio}–${slot.fim}`,
      inicio: normalizeTimeHHMM(slot.inicio),
      fim: normalizeTimeHHMM(slot.fim),
      ativo: true,
    }));

    const minReleasedStart = releasedBlocks.reduce(
      (min, b) => (b.inicio < min ? b.inicio : min),
      releasedBlocks[0].inicio
    );
    const maxReleasedEnd = releasedBlocks.reduce(
      (max, b) => (b.fim > max ? b.fim : max),
      releasedBlocks[0].fim
    );

    return {
      isClosed: false,
      janelaInicio: minReleasedStart,
      janelaFim: maxReleasedEnd,
      blocks: releasedBlocks,
      exception,
    };
  }

  if (!exception && isSundayOrHoliday(normalizedDate)) {
    return {
      isClosed: true,
      reason: 'Não é permitido realizar reservas aos domingos ou feriados oficiais.',
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      blocks: [],
    };
  }

  const dayName = getDayNameFromISO(normalizedDate);
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
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      blocks: [],
    };
  }

  return {
    isClosed: true,
    reason: 'Indisponível - Aguardando liberação da coordenação para esta sala nesta data.',
    janelaInicio: baseJanelaInicio,
    janelaFim: baseJanelaFim,
    blocks: [],
    exception,
  };
}

/**
 * Verifica se o sistema de reservas está aberto no momento.
 * Caso o ADM já tenha liberado explicitamente horários em `available_slots`, permite o agendamento
 * sempre que `config.reservasAbertas` estiver ativo.
 */
export function isBookingWindowOpen(
  referenceDate = new Date(),
  isAdmin = false
): { isOpen: boolean; message?: string } {
  const config = useScheduleStore.getState().config || DEFAULT_SCHEDULE_CONFIG;

  if (config.reservasAbertas === false && !isAdmin) {
    return {
      isOpen: false,
      message:
        'A abertura de novos agendamentos encontra-se temporariamente suspensa pela Coordenação.',
    };
  }

  const todayISO = getTodayLocalISO(referenceDate);
  const rawSlots = useAvailableSlotsStore.getState().slots;
  const safeSlots = Array.isArray(rawSlots) ? rawSlots : [];
  const hasAnyActiveAdminReleasedSlot = safeSlots.some(
    (slot) => (slot?.data || '') >= todayISO && isSlotActiveOrReleased(slot)
  );

  const openHour = config.horaAberturaSistema ?? 6;
  const currentHour = referenceDate.getHours();
  if (currentHour < openHour && !isAdmin && !hasAnyActiveAdminReleasedSlot) {
    const formattedHour = `${String(openHour).padStart(2, '0')}:00`;
    return {
      isOpen: false,
      message: `O sistema de reservas abre às ${formattedHour}. Por favor, retorne a partir desse horário para realizar agendamentos.`,
    };
  }

  return { isOpen: true };
}

/**
 * Retorna as datas mínima e máxima permitidas, expandindo automaticamente `maxDate`
 * caso o Administrador tenha liberado horários em `available_slots` para datas posteriores.
 */
export function getReservationDateLimits(referenceDate = new Date(), salaFirestoreId?: string) {
  const config = useScheduleStore.getState().config || DEFAULT_SCHEDULE_CONFIG;
  const advanceDays = Math.max(0, config.antecedenciaMaximaDias ?? 1);

  const todayStr = getTodayLocalISO(referenceDate);

  const tomorrowDate = new Date(referenceDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = getTodayLocalISO(tomorrowDate);

  const maxDateObj = new Date(referenceDate);
  maxDateObj.setDate(maxDateObj.getDate() + advanceDays);
  let maxDate = getTodayLocalISO(maxDateObj);

  const rawRooms = useRoomStore.getState().rooms;
  const safeRooms = Array.isArray(rawRooms) ? rawRooms : [];
  const room = salaFirestoreId
    ? safeRooms.find((r) => r?.firestoreId === salaFirestoreId || r?.id === salaFirestoreId)
    : undefined;

  const rawSlots = useAvailableSlotsStore.getState().slots;
  const safeSlots = Array.isArray(rawSlots) ? rawSlots : [];
  const releasedDates = safeSlots
    .filter((slot) => {
      if (!slot?.data || slot.data < todayStr || !isSlotActiveOrReleased(slot)) return false;
      if (room) return matchesSlotRoom(slot, room);
      if (salaFirestoreId) {
        return slot.salaId === salaFirestoreId || slot.salaInstitutionalId === salaFirestoreId;
      }
      return true;
    })
    .map((s) => s.data);

  for (const rDate of releasedDates) {
    if (rDate > maxDate) {
      maxDate = rDate;
    }
  }

  return {
    minDate: todayStr,
    maxDate,
    todayStr,
    tomorrowStr,
    advanceDays,
  };
}

/**
 * Validação abrangente de regras de negócio para uma nova reserva (sincronizada em tempo real com `available_slots`, `schedules` e `salas`).
 */
export function validateReservationRules(
  data: {
    date: string;
    startTime: string;
    endTime: string;
    salaFirestoreId?: string;
    isAdmin?: boolean;
  },
  referenceDate = new Date()
): { valid: boolean; error?: string } {
  const isAdmin = Boolean(data.isAdmin);
  const windowStatus = isBookingWindowOpen(referenceDate, isAdmin);
  if (!windowStatus.isOpen) {
    return { valid: false, error: windowStatus.message };
  }

  const normalizedDate = normalizeDateToISO(data.date);
  const normStart = normalizeTimeHHMM(data.startTime);
  const normEnd = normalizeTimeHHMM(data.endTime);

  const { minDate, maxDate, todayStr, advanceDays } = getReservationDateLimits(
    referenceDate,
    data.salaFirestoreId
  );

  if (!normalizedDate) {
    return { valid: false, error: 'Selecione uma data para a reserva.' };
  }

  if (normalizedDate < minDate) {
    return { valid: false, error: 'A data da reserva não pode ser anterior a hoje.' };
  }

  const effective = getEffectiveWindowForDate(normalizedDate, data.salaFirestoreId);
  const hasExplicitReleasedBlocks = !effective.isClosed && effective.blocks.length > 0;

  if (!isAdmin && !hasExplicitReleasedBlocks && normalizedDate > maxDate) {
    return {
      valid: false,
      error:
        advanceDays === 1
          ? 'Reservas antecipadas só podem ser feitas até o dia seguinte (amanhã), salvo datas com liberação explícita da coordenação.'
          : `Reservas antecipadas estão limitadas a até ${advanceDays} dias de antecedência.`,
    };
  }

  if (effective.isClosed && !isAdmin) {
    return { valid: false, error: effective.reason || 'Data indisponível para agendamento.' };
  }

  if (!normStart || !normEnd) {
    return { valid: false, error: 'Selecione um horário com status Disponível liberado pelo administrador.' };
  }

  if (normStart >= normEnd) {
    return { valid: false, error: 'O horário de término deve ser posterior ao horário de início.' };
  }

  // Para usuários comuns, exige que o horário selecionado corresponda a um bloco ativo liberado pelo ADM
  if (!isAdmin) {
    const matchesReleasedBlock = effective.blocks.some(
      (b) => b.ativo && normalizeTimeHHMM(b.inicio) === normStart && normalizeTimeHHMM(b.fim) === normEnd
    );
    if (!matchesReleasedBlock) {
      return {
        valid: false,
        error:
          'Selecione exclusivamente um dos horários com status Disponível liberados pelo administrador para esta sala.',
      };
    }
  }

  if (normalizedDate === todayStr) {
    const startDateTime = createSafeLocalDateTime(normalizedDate, normStart);
    const nowWithTolerance = new Date(referenceDate.getTime() - 60000);
    if (startDateTime < nowWithTolerance) {
      return { valid: false, error: 'O horário de início da reserva não pode ser no passado.' };
    }
  }

  return { valid: true };
}
