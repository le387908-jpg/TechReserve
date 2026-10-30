/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { startOfWeek, endOfWeek } from 'date-fns';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase/config';
import {
  AvailableSlot,
  CalendarEvent,
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
  getTodayLocalISO,
  normalizeDateToISO,
} from '../utils/dateUtils';
import { getDayNameFromISO, isSundayOrHoliday } from '../utils/reservationRules';
import { GRADE_CURRICULAR_FATEC } from '../data/gradeCurricular';
import {
  buildAvailableSlotId,
  hydrateAvailableSlotDoc,
  isSlotActiveOrReleased,
  matchesSlotRoom,
  normalizeTimeHHMM,
  useAvailableSlotsStore,
} from '../store/useAvailableSlotsStore';
import { useAuthStore } from '../store/useAuthStore';

/**
 * Mensagem estrita exigida para bloqueio por cota semanal atingida.
 */
export const WEEKLY_QUOTA_EXCEEDED_MESSAGE =
  'Você já utilizou sua cota de 1 reserva para esta semana.';

/**
 * Indicador visual padrão para horários ainda não liberados pela coordenação.
 */
export const UNAVAILABLE_AWAITING_RELEASE_LABEL =
  'Indisponível - Aguardando liberação da coordenação';

/**
 * Formata a tag oficial de punição por No-Show (bloqueio exclusivo na data da falta).
 */
export function formatNoShowTag(dateISO: string): string {
  return `Punição de No-Show: Bloqueado apenas em ${formatDataBR(dateISO)}`;
}

/**
 * Normaliza texto removendo acentos, pontuação supérflua e zeros à esquerda em números
 * (`Sala 01` == `Sala 1`), sem jamais confundir `Sala 1` com `Sala 10`.
 */
function normalizeRoomToken(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª.]/g, ' ')
    .replace(/\b0+(\d+)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compara dois nomes de sala/laboratório com segurança contra colisão numérica
 * (ex: `"1º. andar Sala 1"` NUNCA colide com `"1º. andar Sala 10"`).
 */
export function doRoomNamesMatch(nameA: string, nameB: string): boolean {
  const normA = normalizeRoomToken(nameA);
  const normB = normalizeRoomToken(nameB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  // Se ambos citam uma sala numerada ("sala X" / "sala de aula X"), os números devem coincidir exatamente
  const salaNumA = normA.match(/\bsala\s*(?:de\s*aula\s*)?(\d+)\b/);
  const salaNumB = normB.match(/\bsala\s*(?:de\s*aula\s*)?(\d+)\b/);
  if (salaNumA && salaNumB) {
    return salaNumA[1] === salaNumB[1];
  }
  if (salaNumA || salaNumB) {
    return false;
  }

  // Se ambos citam um laboratório de informática numerado ("lab info X"), os números devem coincidir
  const labInfoA = normA.match(/\blab(?:oratorio)?\s*(?:de\s*)?info(?:rmatica)?\s*(\d+)\b/);
  const labInfoB = normB.match(/\blab(?:oratorio)?\s*(?:de\s*)?info(?:rmatica)?\s*(\d+)\b/);
  if (labInfoA && labInfoB) {
    return labInfoA[1] === labInfoB[1];
  }
  if (labInfoA || labInfoB) {
    return false;
  }

  // Para espaços nomeados sem sufixo numérico conflitante (ex: Auditório, Química, Hidráulica, Braile, AutoCAD)
  const keywords = [
    'auditorio',
    'quimica',
    'hidraulica',
    'eletrotecnica',
    'fisica',
    'materiais',
    'instalacoes',
    'braile',
    'braille',
    'autocad',
    'biblioteca',
    'maquete',
    'vidro',
    'desenho',
  ];
  for (const kw of keywords) {
    if (normA.includes(kw) && normB.includes(kw)) {
      return true;
    }
  }

  // Fallback por fronteira de palavras inteiras (impede "sala 1" de casar com "sala 10")
  const escapedA = normA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedB = normB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`(?:^|\\s)${escapedA}(?:$|\\s)`).test(normB) ||
    new RegExp(`(?:^|\\s)${escapedB}(?:$|\\s)`).test(normA)
  );
}

/**
 * Verifica se o texto `aula.sala` da grade curricular oficial corresponde ao `Room` informado.
 */
export function doesCurriculumClassMatchRoom(
  aulaSala: string,
  room: Pick<Room, 'id' | 'codigo' | 'nome'>
): boolean {
  const normAula = normalizeRoomToken(aulaSala);
  const normId = (room.id || '').toUpperCase().trim();
  const normCodigo = (room.codigo || '').toUpperCase().trim();

  if (!normAula) return false;

  // Salas numeradas: SALA-001 .. SALA-012 -> casa exatamente "sala 1" / "sala 01", sem confundir 1 com 10/11/12
  const salaMatch = normId.match(/^SALA-0*(\d+)$/);
  if (salaMatch) {
    const num = salaMatch[1];
    const regex = new RegExp(`\\bsala\\s*(?:de\\s*aula\\s*)?0*${num}\\b`, 'i');
    return regex.test(normAula);
  }

  if (normId === 'LAB-001' || normCodigo === 'LAB-INFO-01') {
    return /\blab(?:oratorio)?\s*(?:de\s*)?info(?:rmatica)?\s*0*1\b/i.test(normAula);
  }
  if (normId === 'LAB-002' || normId === 'LAB-002A' || normCodigo.startsWith('LAB-INFO-02')) {
    return /\blab(?:oratorio)?\s*(?:de\s*)?info(?:rmatica)?\s*0*2\b/i.test(normAula);
  }
  if (normId === 'LAB-003' || normCodigo === 'LAB-ARQ-COMP') {
    return (
      /\blab(?:oratorio)?\s*(?:(?:de\s*)?info(?:rmatica)?\s*)?0*3\b/i.test(normAula) ||
      normAula.includes('arq')
    );
  }
  if (normId === 'LAB-004' || normId.startsWith('BRA-') || normCodigo.includes('BRAILE')) {
    return normAula.includes('braile') || normAula.includes('braille');
  }
  if (normId.startsWith('CAD-') || normCodigo.includes('CAD')) {
    return /\bcad\b/i.test(normAula) || normAula.includes('autocad');
  }
  if (normId.startsWith('QUI-') || normCodigo.includes('QUIMICA')) {
    return normAula.includes('quimica');
  }
  if (normId === 'LAB-007' || normCodigo.includes('HIDRA')) {
    return normAula.includes('hidraulica');
  }
  if (normId === 'LAB-008' || normCodigo.includes('ELETRO')) {
    return normAula.includes('eletrotecnica');
  }
  if (normId === 'LAB-009' || normCodigo.includes('FIS')) {
    return normAula.includes('fisica');
  }
  if (normId === 'LAB-005' || normCodigo.includes('MAT')) {
    return normAula.includes('materiais');
  }
  if (normId === 'LAB-006' || normCodigo.includes('INSTAL')) {
    return normAula.includes('instalacoes') || normAula.includes('construcoes');
  }
  if (normId.startsWith('AUD-') || normCodigo.includes('AUDITORIO')) {
    return normAula.includes('auditorio') || normAula.includes('teatro');
  }
  if (normId.startsWith('BIB-') || normCodigo.includes('BIBLIOTECA')) {
    return normAula.includes('biblioteca');
  }
  if (normId.startsWith('DES-') || normCodigo.includes('DESENHO')) {
    return normAula.includes('desenho');
  }
  if (normId.startsWith('MAQ-') || normCodigo.includes('MAQUETE')) {
    return normAula.includes('maquete');
  }
  if (normId.startsWith('VID-') || normCodigo.includes('VIDRO')) {
    return normAula.includes('vidro');
  }

  return doRoomNamesMatch(aulaSala, room.nome);
}

/**
 * Retorna todas as aulas regulares da grade curricular (`AULA_GRADE`) alocadas na sala e data informadas.
 */
export function getCurriculumClassesForRoomOnDate(
  room: Room | undefined | null,
  dateISO: string
): CalendarEvent[] {
  if (!room || !dateISO) return [];
  const dayName = getDayNameFromISO(dateISO);
  if (dayName === 'Domingo') return [];

  return GRADE_CURRICULAR_FATEC.filter(
    (aula) => aula.diaSemana === dayName && doesCurriculumClassMatchRoom(aula.sala, room)
  ).sort((a, b) => (a.horarioInicio || '').localeCompare(b.horarioInicio || ''));
}

/**
 * Retorna todas as datas ISO (`>= minDateISO`) que possuem ao menos 1 horário liberado pelo ADM
 * em `available_slots` para a sala informada.
 */
export function getReleasedDatesForRoom(
  room: Room | undefined | null,
  minDateISO: string,
  availableSlotsOverride?: AvailableSlot[]
): string[] {
  if (!room) return [];
  const rawSlots = availableSlotsOverride ?? useAvailableSlotsStore.getState().slots;
  const allSlots = Array.isArray(rawSlots) ? rawSlots : [];
  const dateSet = new Set<string>();

  for (const slot of allSlots) {
    if (!slot?.data || slot.data < minDateISO) continue;
    if (!isSlotActiveOrReleased(slot)) continue;
    if (!matchesSlotRoom(slot, room)) continue;
    dateSet.add(slot.data);
  }

  return Array.from(dateSet).sort((a, b) => a.localeCompare(b));
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
 * REGRA 1.2 (BLOQUEIO PADRÃO + LIBERAÇÃO EXPLÍCITA `available_slots`) —
 * Retorna os horários efetivamente liberados pelo Administrador para uma sala e data específicas.
 * Por padrão, NENHUM horário aparece disponível para o Usuário/Aluno sem um registro ativo/liberado
 * na coleção `available_slots` para aquela sala e data.
 */
export function getReleasedBlocksForRoomOnDate(
  room: Room | undefined | null,
  dateISO: string,
  config: ScheduleConfig,
  exceptions: ScheduleException[],
  now: Date = new Date(),
  availableSlotsOverride?: AvailableSlot[]
): {
  released: boolean;
  blocks: (TimeBlock & { availableSlotId?: string })[];
  janelaInicio: string;
  janelaFim: string;
  reason?: string;
  exception?: ScheduleException;
} {
  const safeJanelaInicio = config?.janelaInicio || '07:00';
  const safeJanelaFim = config?.janelaFim || '22:00';
  const safeExceptions = Array.isArray(exceptions) ? exceptions : [];

  if (!room || !dateISO) {
    return {
      released: false,
      blocks: [],
      janelaInicio: safeJanelaInicio,
      janelaFim: safeJanelaFim,
      reason: 'Selecione uma sala e uma data válidas.',
    };
  }

  const normalizedDate = normalizeDateToISO(dateISO);

  const spaceCheck = isSpaceReleasedByAdmin(room, now);
  if (!spaceCheck.released) {
    return {
      released: false,
      blocks: [],
      janelaInicio: safeJanelaInicio,
      janelaFim: safeJanelaFim,
      reason: spaceCheck.reason,
    };
  }

  if (config && config.reservasAbertas === false) {
    return {
      released: false,
      blocks: [],
      janelaInicio: safeJanelaInicio,
      janelaFim: safeJanelaFim,
      reason: 'A abertura de novos agendamentos encontra-se suspensa pela Coordenação.',
    };
  }

  // Verifica exceção específica da sala primeiro; caso não exista, verifica exceção global ('TODAS')
  const roomSpecificException = safeExceptions.find(
    (ex) => ex?.data === normalizedDate && ex.salaId === room.firestoreId
  );
  const globalException = safeExceptions.find(
    (ex) => ex?.data === normalizedDate && (!ex.salaId || ex.salaId === 'TODAS')
  );
  const exception = roomSpecificException || globalException;

  if (exception?.fechado) {
    return {
      released: false,
      blocks: [],
      janelaInicio: safeJanelaInicio,
      janelaFim: safeJanelaFim,
      reason: `Data fechada pelo ADM (${exception.titulo}${
        exception.motivo ? `: ${exception.motivo}` : ''
      }).`,
      exception,
    };
  }

  const rawSlots = availableSlotsOverride ?? useAvailableSlotsStore.getState().slots;
  const allSlots = Array.isArray(rawSlots) ? rawSlots : [];
  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, normalizedDate);

  // Filtra apenas os documentos de `available_slots` com status `liberado`/`ativo`/`disponivel` para a sala e data,
  // excluindo eventuais sobreposições com aulas regulares da grade acadêmica.
  const explicitReleased = allSlots
    .filter((slot) => {
      if (!slot || slot.data !== normalizedDate) return false;
      if (!matchesSlotRoom(slot, room)) return false;
      if (!isSlotActiveOrReleased(slot)) return false;

      const overlapsClass = curriculumClasses.some(
        (aula) => slot.inicio < aula.horarioFim && slot.fim > aula.horarioInicio
      );
      return !overlapsClass;
    })
    .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

  const baseJanelaInicio = exception?.janelaInicio || safeJanelaInicio;
  const baseJanelaFim = exception?.janelaFim || safeJanelaFim;

  // Se o ADM liberou explicitamente horários em `available_slots` para esta sala e data,
  // respeita imediatamente a liberação explícita da coordenação.
  if (explicitReleased.length > 0) {
    const releasedBlocks = explicitReleased.map((slot) => ({
      id: slot.id,
      availableSlotId: slot.id,
      label: slot.label || `Horário ${slot.inicio}–${slot.fim}`,
      inicio: normalizeTimeHHMM(slot.inicio),
      fim: normalizeTimeHHMM(slot.fim),
      ativo: true,
    }));

    const effectiveJanelaInicio = releasedBlocks.reduce(
      (min, b) => (b.inicio < min ? b.inicio : min),
      releasedBlocks[0].inicio
    );
    const effectiveJanelaFim = releasedBlocks.reduce(
      (max, b) => (b.fim > max ? b.fim : max),
      releasedBlocks[0].fim
    );

    return {
      released: true,
      blocks: releasedBlocks,
      janelaInicio: effectiveJanelaInicio,
      janelaFim: effectiveJanelaFim,
      exception,
    };
  }

  if (!exception && isSundayOrHoliday(normalizedDate)) {
    return {
      released: false,
      blocks: [],
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      reason: 'Não há horários liberados aos domingos ou feriados oficiais.',
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
      released: false,
      blocks: [],
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      reason: `O administrador não habilitou agendamentos para ${dayName}.`,
    };
  }

  return {
    released: false,
    blocks: [],
    janelaInicio: baseJanelaInicio,
    janelaFim: baseJanelaFim,
    reason: `${UNAVAILABLE_AWAITING_RELEASE_LABEL} para esta sala em ${formatDataBR(normalizedDate)}.`,
    exception,
  };
}

export type RoomSlotVisualState =
  | 'LIBERADO'
  | 'AGUARDANDO_LIBERACAO'
  | 'OCUPADO_AULA'
  | 'OCUPADO_RESERVA_OUTRO'
  | 'OCUPADO_RESERVA_PROPRIA'
  | 'ENCERRADO';

export function isSlotOccupiedByReservation(state: RoomSlotVisualState): boolean {
  return state === 'OCUPADO_RESERVA_OUTRO' || state === 'OCUPADO_RESERVA_PROPRIA';
}

export interface RoomScheduleSlotView {
  key: string;
  availableSlotId?: string;
  inicio: string;
  fim: string;
  label: string;
  state: RoomSlotVisualState;
  selectableForUser: boolean;
  statusBadge: string;
  statusDetail: string;
  curriculumClass?: CalendarEvent;
  reservation?: Reservation;
  rawAvailableSlot?: AvailableSlot;
}

/**
 * Monta a grade completa de slots da sala para uma data específica com os 5 estados visuais oficiais:
 * - `OCUPADO_AULA`: Aulas regulares da grade -> Status `"Ocupado"` (Azul, bloqueado)
 * - `OCUPADO_RESERVA_OUTRO`: Reservado por outro usuário -> Status `"Reservado"` (Vermelho, bloqueado)
 * - `OCUPADO_RESERVA_PROPRIA`: Reservado pelo próprio usuário logado -> Status `"Sua Reserva"` (Verde, exibe detalhes)
 * - `LIBERADO`: Horários liberados pelo ADM -> Status `"Disponível"` (Destaque interativo, clicável)
 * - `AGUARDANDO_LIBERACAO` / `ENCERRADO`: Horários não liberados -> Status `"Indisponível"` (Cinza, bloqueado)
 */
export function getRoomScheduleSlotsForDate(params: {
  room: Room | undefined | null;
  dateISO: string;
  config: ScheduleConfig;
  exceptions: ScheduleException[];
  availableSlots: AvailableSlot[];
  reservations: Reservation[];
  currentUserId?: string;
  now?: Date;
}): {
  slots: RoomScheduleSlotView[];
  curriculumClasses: CalendarEvent[];
  reservableCount: number;
} {
  const {
    room,
    dateISO,
    config,
    exceptions,
    availableSlots,
    reservations,
    currentUserId = useAuthStore.getState().user?.id,
    now = new Date(),
  } = params;

  if (!room || !dateISO) {
    return { slots: [], curriculumClasses: [], reservableCount: 0 };
  }

  const normalizedDate = normalizeDateToISO(dateISO);
  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, normalizedDate);
  const safeReservations = Array.isArray(reservations) ? reservations : [];
  const safeAvailableSlots = Array.isArray(availableSlots) ? availableSlots : [];
  const safeExceptions = Array.isArray(exceptions) ? exceptions : [];

  const activeReservationsForRoom = safeReservations
    .filter((r) => {
      if (!r || r.data !== normalizedDate) return false;
      if (r.status !== 'PENDENTE' && r.status !== 'CONFIRMADA') return false;
      if (r.salaId === room.firestoreId) return true;
      if (room.id && (r.salaInstitutionalId === room.id || r.salaId === room.id)) return true;
      if (r.salaNome && room.nome && doRoomNamesMatch(r.salaNome, room.nome)) return true;
      return false;
    })
    .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

  const roomAvailableDocs = safeAvailableSlots.filter(
    (s) => s?.data === normalizedDate && matchesSlotRoom(s, room)
  );

  // Constrói o conjunto de faixas horárias candidatas: blocos institucionais + slots liberados + reservas ativas
  const templateBlocks =
    Array.isArray(room.blocosHorarios) && room.blocosHorarios.length > 0
      ? room.blocosHorarios
      : Array.isArray(config?.blocosPadrao)
      ? config.blocosPadrao
      : [];

  const candidateMap = new Map<
    string,
    { inicio: string; fim: string; label: string }
  >();

  for (const blk of templateBlocks) {
    if (!blk) continue;
    const inicio = normalizeTimeHHMM(blk.inicio);
    const fim = normalizeTimeHHMM(blk.fim);
    if (!inicio || !fim || inicio >= fim) continue;
    const key = `${inicio}_${fim}`;
    candidateMap.set(key, {
      inicio,
      fim,
      label: blk.label || `Bloco ${inicio}–${fim}`,
    });
  }

  for (const slotDoc of roomAvailableDocs) {
    const inicio = normalizeTimeHHMM(slotDoc.inicio);
    const fim = normalizeTimeHHMM(slotDoc.fim);
    if (!inicio || !fim || inicio >= fim) continue;
    const key = `${inicio}_${fim}`;
    if (!candidateMap.has(key)) {
      candidateMap.set(key, {
        inicio,
        fim,
        label: slotDoc.label || `Horário ${inicio}–${fim}`,
      });
    } else if (slotDoc.label) {
      candidateMap.set(key, {
        inicio,
        fim,
        label: slotDoc.label,
      });
    }
  }

  for (const res of activeReservationsForRoom) {
    const inicio = normalizeTimeHHMM(res.inicio);
    const fim = normalizeTimeHHMM(res.fim);
    if (!inicio || !fim || inicio >= fim) continue;
    const key = `${inicio}_${fim}`;
    if (!candidateMap.has(key)) {
      candidateMap.set(key, {
        inicio,
        fim,
        label: `Horário ${inicio}–${fim}`,
      });
    }
  }

  const spaceCheck = isSpaceReleasedByAdmin(room, now);
  const roomSpecificException = safeExceptions.find(
    (ex) => ex?.data === normalizedDate && ex.salaId === room.firestoreId
  );
  const globalException = safeExceptions.find(
    (ex) => ex?.data === normalizedDate && (!ex.salaId || ex.salaId === 'TODAS')
  );
  const exception = roomSpecificException || globalException;
  const dayName = getDayNameFromISO(normalizedDate);

  const hasExplicitAdminSlotOnDate = roomAvailableDocs.some((s) => isSlotActiveOrReleased(s));

  const isDateOperational =
    spaceCheck.released &&
    (config ? config.reservasAbertas !== false : true) &&
    !exception?.fechado &&
    (hasExplicitAdminSlotOnDate ||
      ((Boolean(exception) || !isSundayOrHoliday(normalizedDate)) &&
        (Boolean(exception) ||
          (dayName !== 'Domingo' &&
            (!Array.isArray(config?.diasSemanaPermitidos) ||
              config.diasSemanaPermitidos.length === 0 ||
              config.diasSemanaPermitidos.includes(dayName))))));

  const todayISO = getTodayLocalISO(now);
  const nowWithTolerance = new Date(now.getTime() - 60000);

  const sortedCandidates = Array.from(candidateMap.values()).sort((a, b) =>
    (a.inicio || '').localeCompare(b.inicio || '')
  );

  const slots: RoomScheduleSlotView[] = sortedCandidates.map((cand) => {
    const key = `${cand.inicio}_${cand.fim}`;
    const matchingRes = activeReservationsForRoom.find((r) => {
      const rInicio = normalizeTimeHHMM(r.inicio);
      const rFim = normalizeTimeHHMM(r.fim);
      return cand.inicio < rFim && cand.fim > rInicio;
    });
    const matchingClass = curriculumClasses.find(
      (aula) => cand.inicio < aula.horarioFim && cand.fim > aula.horarioInicio
    );
    const matchingSlotDoc = roomAvailableDocs.find(
      (s) =>
        normalizeTimeHHMM(s.inicio) === cand.inicio &&
        normalizeTimeHHMM(s.fim) === cand.fim
    );

    if (matchingRes) {
      const isOwnReservation = Boolean(currentUserId && matchingRes.usuarioId === currentUserId);
      if (isOwnReservation) {
        return {
          key,
          availableSlotId: matchingSlotDoc?.id,
          inicio: cand.inicio,
          fim: cand.fim,
          label: cand.label,
          state: 'OCUPADO_RESERVA_PROPRIA',
          selectableForUser: false,
          statusBadge: 'Sua Reserva',
          statusDetail:
            matchingRes.status === 'CONFIRMADA'
              ? 'Reservado por você · Check-in confirmado (clique para ver detalhes)'
              : 'Reservado por você · Aguardando check-in via QR Code (clique para ver detalhes)',
          reservation: matchingRes,
          rawAvailableSlot: matchingSlotDoc,
        };
      }

      return {
        key,
        availableSlotId: matchingSlotDoc?.id,
        inicio: cand.inicio,
        fim: cand.fim,
        label: cand.label,
        state: 'OCUPADO_RESERVA_OUTRO',
        selectableForUser: false,
        statusBadge: 'Reservado',
        statusDetail: 'Reservado por outro usuário neste horário',
        reservation: matchingRes,
        rawAvailableSlot: matchingSlotDoc,
      };
    }

    if (matchingClass) {
      return {
        key,
        availableSlotId: matchingSlotDoc?.id,
        inicio: cand.inicio,
        fim: cand.fim,
        label: cand.label,
        state: 'OCUPADO_AULA',
        selectableForUser: false,
        statusBadge: 'Ocupado',
        statusDetail: `Aula regular: ${matchingClass.materia} (${matchingClass.curso} · ${matchingClass.semestre}º Sem)`,
        curriculumClass: matchingClass,
        rawAvailableSlot: matchingSlotDoc,
      };
    }

    if (isDateOperational && matchingSlotDoc && isSlotActiveOrReleased(matchingSlotDoc)) {
      if (normalizedDate < todayISO) {
        return {
          key,
          availableSlotId: matchingSlotDoc.id,
          inicio: cand.inicio,
          fim: cand.fim,
          label: cand.label,
          state: 'ENCERRADO',
          selectableForUser: false,
          statusBadge: 'Indisponível',
          statusDetail: 'Indisponível - Data encerrada',
          rawAvailableSlot: matchingSlotDoc,
        };
      }

      if (normalizedDate === todayISO) {
        const slotStart = createSafeLocalDateTime(normalizedDate, cand.inicio);
        if (slotStart < nowWithTolerance) {
          return {
            key,
            availableSlotId: matchingSlotDoc.id,
            inicio: cand.inicio,
            fim: cand.fim,
            label: cand.label,
            state: 'ENCERRADO',
            selectableForUser: false,
            statusBadge: 'Indisponível',
            statusDetail: 'Indisponível - Horário já iniciado hoje',
            rawAvailableSlot: matchingSlotDoc,
          };
        }
      }

      return {
        key,
        availableSlotId: matchingSlotDoc.id,
        inicio: cand.inicio,
        fim: cand.fim,
        label: cand.label,
        state: 'LIBERADO',
        selectableForUser: true,
        statusBadge: 'Disponível',
        statusDetail: 'Liberado pelo ADM · Clique para selecionar e reservar',
        rawAvailableSlot: matchingSlotDoc,
      };
    }

    return {
      key,
      availableSlotId: matchingSlotDoc?.id,
      inicio: cand.inicio,
      fim: cand.fim,
      label: cand.label,
      state: 'AGUARDANDO_LIBERACAO',
      selectableForUser: false,
      statusBadge: 'Indisponível',
      statusDetail: UNAVAILABLE_AWAITING_RELEASE_LABEL,
      rawAvailableSlot: matchingSlotDoc,
    };
  });

  const reservableCount = slots.filter((s) => s.selectableForUser).length;

  return {
    slots,
    curriculumClasses,
    reservableCount,
  };
}

/**
 * Valida diretamente no Firestore a existência de um registro explícito em `available_slots`
 * com status `liberado`, `ativo` ou `disponivel` para a sala, data e faixa horária informadas.
 */
export async function verifyAvailableSlotFirestore(
  room: Room,
  dateISO: string,
  inicio: string,
  fim: string,
  candidateSlotId?: string
): Promise<AvailableSlot> {
  const normDate = normalizeDateToISO(dateISO);
  const normInicio = normalizeTimeHHMM(inicio);
  const normFim = normalizeTimeHHMM(fim);

  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, normDate);
  const classConflict = curriculumClasses.find(
    (aula) => normInicio < aula.horarioFim && normFim > aula.horarioInicio
  );
  if (classConflict) {
    throw new Error(
      `Horário ocupado por aula regular da grade acadêmica (${classConflict.materia} das ${classConflict.horarioInicio} às ${classConflict.horarioFim}).`
    );
  }

  const matchesTargetSlot = (hydrated: AvailableSlot): boolean =>
    matchesSlotRoom(hydrated, room) &&
    hydrated.data === normDate &&
    hydrated.inicio === normInicio &&
    hydrated.fim === normFim &&
    isSlotActiveOrReleased(hydrated);

  // 1. Verifica primeiro pelo `candidateSlotId` ou slot já sincronizado em memória (`onSnapshot`)
  const storeSlots = useAvailableSlotsStore.getState().slots;
  const safeStoreSlots = Array.isArray(storeSlots) ? storeSlots : [];
  const inMemorySlot = safeStoreSlots.find((s) => s && matchesTargetSlot(s));

  const directIdsToTry = Array.from(
    new Set(
      [
        candidateSlotId,
        inMemorySlot?.id,
        buildAvailableSlotId(room.firestoreId, normDate, normInicio, normFim),
        room.id ? buildAvailableSlotId(room.id, normDate, normInicio, normFim) : undefined,
      ].filter((id): id is string => Boolean(id && id.trim()))
    )
  );

  for (const slotId of directIdsToTry) {
    try {
      const directSnap = await getDoc(doc(db, 'available_slots', slotId));
      if (directSnap.exists()) {
        const hydrated = hydrateAvailableSlotDoc(
          directSnap.id,
          (directSnap.data() || {}) as Record<string, unknown>,
          room.nome
        );
        if (matchesTargetSlot(hydrated)) {
          return hydrated;
        }
      }
    } catch (err) {
      console.warn('[Reservas] Falha ao consultar slot direto:', slotId, err);
    }
  }

  // 2. Fallback para consultas indexadas cobrindo tanto `salaId`/`roomId` quanto `data`/`date`
  const fallbackQueries = [
    query(
      collection(db, 'available_slots'),
      where('salaId', '==', room.firestoreId),
      where('data', '==', normDate)
    ),
    ...(room.id
      ? [
          query(
            collection(db, 'available_slots'),
            where('salaInstitutionalId', '==', room.id),
            where('data', '==', normDate)
          ),
          query(
            collection(db, 'available_slots'),
            where('salaId', '==', room.id),
            where('data', '==', normDate)
          ),
        ]
      : []),
    query(
      collection(db, 'available_slots'),
      where('roomId', '==', room.firestoreId)
    ),
    ...(room.id
      ? [query(collection(db, 'available_slots'), where('roomId', '==', room.id))]
      : []),
  ];

  for (const qRef of fallbackQueries) {
    try {
      const snap = await getDocs(qRef);
      for (const d of snap.docs) {
        const hydrated = hydrateAvailableSlotDoc(
          d.id,
          (d.data() || {}) as Record<string, unknown>,
          room.nome
        );
        if (matchesTargetSlot(hydrated)) {
          return hydrated;
        }
      }
    } catch (err) {
      console.warn('[Reservas] Aviso na consulta complementar de available_slots:', err);
    }
  }

  throw new Error(
    `${UNAVAILABLE_AWAITING_RELEASE_LABEL}. Este horário não consta como liberado pelo Administrador para ${room.nome} em ${formatDataBR(normDate)}.`
  );
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
  const safeReservations = Array.isArray(reservations) ? reservations : [];

  const consuming = safeReservations.filter(
    (r) =>
      r?.usuarioId === userId &&
      (r.data || '') >= weekBounds.startISO &&
      (r.data || '') <= weekBounds.endISO &&
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

  const safePunishments = Array.isArray(punishments) ? punishments : [];
  const userBlockedDate = user.blockedDate ? normalizeDateToISO(user.blockedDate) : '';
  const matchingPunishment = safePunishments.find(
    (p) =>
      p?.usuarioId === user.id &&
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

  const safePunishments = Array.isArray(punishments) ? punishments : [];
  const activePunishment = safePunishments
    .filter((p) => p?.usuarioId === user.id && p.ativa && Boolean(p.blockedDate))
    .sort((a, b) => (b.dataInicio || 0) - (a.dataInicio || 0))[0];

  if (activePunishment?.blockedDate) {
    return normalizeDateToISO(activePunishment.blockedDate);
  }

  return null;
}
