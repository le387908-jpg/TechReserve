/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { startOfWeek, endOfWeek } from 'date-fns';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase/config';
import {
  PunishmentRecord,
  Reservation,
  Room,
  ScheduleConfig,
  ScheduleException,
  TimeBlock,
  User,
} from '../types';
import {
  createSafeLocalDateTime,
  formatDataBR,
  normalizeDateToISO,
} from '../utils/dateUtils';
import { getDayNameFromISO, isSundayOrHoliday } from '../utils/reservationRules';

/**
 * Mensagem estrita exigida para bloqueio por cota semanal atingida.
 */
export const WEEKLY_QUOTA_EXCEEDED_MESSAGE =
  'Você já utilizou sua cota de 1 reserva para esta semana.';

/**
 * Formata a tag oficial de punição por No-Show (bloqueio exclusivo na data da falta).
 */
export function formatNoShowTag(dateISO: string): string {
  return `Punição de No-Show: Bloqueado apenas em ${formatDataBR(dateISO)}`;
}

/**
 * Calcula os limites da semana acadêmica (Segunda-feira a Domingo) para uma data ISO 'YYYY-MM-DD'.
 */
export function getWeekBoundsISO(dateISO: string): {
  startISO: string;
  endISO: string;
  startLabel: string;
  endLabel: string;
} {
  const safeRef = createSafeLocalDateTime(dateISO, '12:00');
  const monday = startOfWeek(safeRef, { weekStartsOn: 1 });
  const sunday = endOfWeek(safeRef, { weekStartsOn: 1 });
  const startISO = normalizeDateToISO(monday);
  const endISO = normalizeDateToISO(sunday);

  return {
    startISO,
    endISO,
    startLabel: formatDataBR(startISO),
    endLabel: formatDataBR(endISO),
  };
}

/**
 * REGRA 1.1 — Verifica se o espaço acadêmico está explicitamente liberado pelo ADM para visualização e reserva por usuários comuns.
 */
export function isSpaceReleasedByAdmin(
  room: Room | undefined | null,
  now: Date = new Date()
): { released: boolean; reason?: string } {
  if (!room) {
    return {
      released: false,
      reason: 'Espaço acadêmico não encontrado no inventário.',
    };
  }

  if (room.liberadaParaReserva === false) {
    return {
      released: false,
      reason: 'Esta sala encontra-se bloqueada pelo administrador para agendamentos de usuários.',
    };
  }

  if (
    room.status === 'INATIVO' ||
    room.status === 'MANUTENCAO' ||
    room.statusManual === 'MANUTENCAO'
  ) {
    return {
      released: false,
      reason: 'Esta sala está em manutenção ou desativada pela administração.',
    };
  }

  if (room.bloqueadaAte && room.bloqueadaAte > now.getTime()) {
    return {
      released: false,
      reason: room.motivoBloqueio
        ? `Sala temporariamente suspensa pelo ADM: ${room.motivoBloqueio}`
        : 'Esta sala está temporariamente suspensa pela administração.',
    };
  }

  return { released: true };
}

/**
 * REGRA 1.2 — Retorna os blocos de horários ativos liberados pelo ADM para uma sala e data específicas.
 * Exige que TANTO a sala esteja liberada QUANTO existam blocos ativos configurados para a data.
 */
export function getReleasedBlocksForRoomOnDate(
  room: Room | undefined | null,
  dateISO: string,
  config: ScheduleConfig,
  exceptions: ScheduleException[],
  now: Date = new Date()
): {
  released: boolean;
  blocks: TimeBlock[];
  janelaInicio: string;
  janelaFim: string;
  reason?: string;
  exception?: ScheduleException;
} {
  if (room) {
    const spaceCheck = isSpaceReleasedByAdmin(room, now);
    if (!spaceCheck.released) {
      return {
        released: false,
        blocks: [],
        janelaInicio: config.janelaInicio,
        janelaFim: config.janelaFim,
        reason: spaceCheck.reason,
      };
    }
  }

  if (!config.reservasAbertas) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: 'A abertura de novos agendamentos encontra-se suspensa pela Coordenação.',
    };
  }

  // Verifica exceção específica da sala primeiro; caso não exista, verifica exceção global ('TODAS')
  const roomSpecificException = room?.firestoreId
    ? exceptions.find((ex) => ex.data === dateISO && ex.salaId === room.firestoreId)
    : undefined;
  const globalException = exceptions.find(
    (ex) => ex.data === dateISO && (!ex.salaId || ex.salaId === 'TODAS')
  );
  const exception = roomSpecificException || globalException;

  const baseRoomBlocks =
    room?.blocosHorarios && room.blocosHorarios.length > 0
      ? room.blocosHorarios
      : config.blocosPadrao || [];

  if (exception) {
    if (exception.fechado) {
      return {
        released: false,
        blocks: [],
        janelaInicio: config.janelaInicio,
        janelaFim: config.janelaFim,
        reason: `Data fechada pelo ADM (${exception.titulo}${
          exception.motivo ? `: ${exception.motivo}` : ''
        }).`,
        exception,
      };
    }

    const janelaInicio = exception.janelaInicio || config.janelaInicio;
    const janelaFim = exception.janelaFim || config.janelaFim;
    const sourceBlocks =
      exception.blocosCustomizados && exception.blocosCustomizados.length > 0
        ? exception.blocosCustomizados
        : baseRoomBlocks;

    const activeBlocks = sourceBlocks.filter(
      (b) => b.ativo && b.inicio >= janelaInicio && b.fim <= janelaFim
    );

    if (activeBlocks.length === 0) {
      return {
        released: false,
        blocks: [],
        janelaInicio,
        janelaFim,
        reason:
          'O administrador não liberou blocos de horários ativos para esta sala nesta data.',
        exception,
      };
    }

    return {
      released: true,
      blocks: activeBlocks,
      janelaInicio,
      janelaFim,
      exception,
    };
  }

  if (isSundayOrHoliday(dateISO)) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: 'Não há janelas operacionais liberadas aos domingos ou feriados oficiais.',
    };
  }

  const dayName = getDayNameFromISO(dateISO);
  if (
    dayName === 'Domingo' ||
    (config.diasSemanaPermitidos &&
      config.diasSemanaPermitidos.length > 0 &&
      !config.diasSemanaPermitidos.includes(dayName))
  ) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: `O administrador não habilitou janelas de horários para ${dayName}.`,
    };
  }

  const activeBlocks = baseRoomBlocks.filter(
    (b) => b.ativo && b.inicio >= config.janelaInicio && b.fim <= config.janelaFim
  );

  if (activeBlocks.length === 0) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason:
        'Nenhum bloco de horário ativo foi cadastrado ou liberado pelo ADM para esta sala.',
    };
  }

  return {
    released: true,
    blocks: activeBlocks,
    janelaInicio: config.janelaInicio,
    janelaFim: config.janelaFim,
  };
}

/**
 * REGRA 2 — Verifica localmente a Cota Semanal de 1 reserva (Segunda a Domingo).
 * - Reservas com status 'PENDENTE', 'CONFIRMADA' ou 'CONCLUIDA' consomem a cota da semana.
 * - Reservas 'CANCELADA' (cancelamento prévio) e 'PUNIDA' (No-Show) LIBERAM a cota semanal.
 */
export function checkWeeklyQuotaLocal(
  reservations: Reservation[],
  userId: string,
  targetDateISO: string
): {
  allowed: boolean;
  usedCount: number;
  consumingReservation: Reservation | null;
  weekBounds: ReturnType<typeof getWeekBoundsISO>;
  error?: string;
} {
  const weekBounds = getWeekBoundsISO(targetDateISO);

  const consuming = reservations.filter(
    (r) =>
      r.usuarioId === userId &&
      r.data >= weekBounds.startISO &&
      r.data <= weekBounds.endISO &&
      (r.status === 'PENDENTE' || r.status === 'CONFIRMADA' || r.status === 'CONCLUIDA')
  );

  const allowed = consuming.length === 0;

  return {
    allowed,
    usedCount: consuming.length,
    consumingReservation: consuming[0] || null,
    weekBounds,
    error: allowed ? undefined : WEEKLY_QUOTA_EXCEEDED_MESSAGE,
  };
}

/**
 * REGRA 2 (Validação Firestore) — Consulta diretamente as reservas do usuário no Firestore
 * para garantir consistência estrita da cota de 1 reserva por semana antes de persistir o agendamento.
 */
export async function verifyWeeklyQuotaFirestore(
  userId: string,
  targetDateISO: string
): Promise<{
  allowed: boolean;
  usedCount: number;
  consumingReservation: Reservation | null;
  weekBounds: ReturnType<typeof getWeekBoundsISO>;
  error?: string;
}> {
  const q = query(collection(db, 'reservas'), where('usuarioId', '==', userId));
  const snap = await getDocs(q);
  const userReservations = snap.docs.map(
    (docSnap) => ({ id: docSnap.id, ...docSnap.data() } as Reservation)
  );
  return checkWeeklyQuotaLocal(userReservations, userId, targetDateISO);
}

/**
 * REGRA 3 — Verifica se o usuário possui Punição de No-Show (ou restrição pontual)
 * estritamente para a data alvo (`targetDateISO`).
 * Datas futuras ou diferentes de `blockedDate` permanecem liberadas.
 */
export function checkNoShowSuspensionForDate(
  user: User | null | undefined,
  punishments: PunishmentRecord[],
  targetDateISO: string
): {
  blocked: boolean;
  blockedDate: string | null;
  tag?: string;
  error?: string;
} {
  if (!user || user.role === 'ADMIN' || !targetDateISO) {
    return { blocked: false, blockedDate: null };
  }

  const userBlockedDate = user.blockedDate ? normalizeDateToISO(user.blockedDate) : '';
  const matchingPunishment = punishments.find(
    (p) =>
      p.usuarioId === user.id &&
      p.ativa &&
      p.blockedDate &&
      normalizeDateToISO(p.blockedDate) === targetDateISO
  );

  if (userBlockedDate === targetDateISO || Boolean(matchingPunishment)) {
    const tag = formatNoShowTag(targetDateISO);
    return {
      blocked: true,
      blockedDate: targetDateISO,
      tag,
      error: `${tag}. Novas reservas estão bloqueadas apenas para esta data; você pode selecionar normalmente datas futuras.`,
    };
  }

  return { blocked: false, blockedDate: null };
}

/**
 * Retorna a data de bloqueio por No-Show relevante do usuário (para exibição em perfil, histórico e painel ADM).
 */
export function getUserNoShowBlockedDate(
  user: User | null | undefined,
  punishments: PunishmentRecord[] = []
): string | null {
  if (!user) return null;

  if (user.blockedDate && user.blockedDate.trim()) {
    return normalizeDateToISO(user.blockedDate);
  }

  const activePunishment = punishments
    .filter((p) => p.usuarioId === user.id && p.ativa && Boolean(p.blockedDate))
    .sort((a, b) => (b.dataInicio || 0) - (a.dataInicio || 0))[0];

  if (activePunishment?.blockedDate) {
    return normalizeDateToISO(activePunishment.blockedDate);
  }

  return null;
}
