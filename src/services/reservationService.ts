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
  isSlotActiveOrReleased,
  matchesSlotRoom,
  useAvailableSlotsStore,
} from '../store/useAvailableSlotsStore';

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
 * Normaliza texto removendo acentos e pontuação supérflua para casamento seguro entre
 * nomes da grade curricular (`1º. andar Sala 3`) e cadastro de salas (`Sala de Aula 03...`).
 */
function normalizeRoomToken(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verifica se o texto `aula.sala` da grade curricular oficial corresponde ao `Room` informado.
 */
export function doesCurriculumClassMatchRoom(
  aulaSala: string,
  room: Pick<Room, 'id' | 'codigo' | 'nome'>
): boolean {
  const normAula = normalizeRoomToken(aulaSala);
  const normNome = normalizeRoomToken(room.nome);
  const normId = (room.id || '').toUpperCase().trim();
  const normCodigo = (room.codigo || '').toUpperCase().trim();

  if (!normAula) return false;
  if (normNome && (normAula.includes(normNome) || normNome.includes(normAula))) {
    return true;
  }

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

  return false;
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
  ).sort((a, b) => a.horarioInicio.localeCompare(b.horarioInicio));
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
  if (!room) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: 'Selecione uma sala válida.',
    };
  }

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
  const roomSpecificException = exceptions.find(
    (ex) => ex.data === dateISO && ex.salaId === room.firestoreId
  );
  const globalException = exceptions.find(
    (ex) => ex.data === dateISO && (!ex.salaId || ex.salaId === 'TODAS')
  );
  const exception = roomSpecificException || globalException;

  if (exception?.fechado) {
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

  if (!exception && isSundayOrHoliday(dateISO)) {
    return {
      released: false,
      blocks: [],
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: 'Não há horários liberados aos domingos ou feriados oficiais.',
    };
  }

  const dayName = getDayNameFromISO(dateISO);
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
      janelaInicio: config.janelaInicio,
      janelaFim: config.janelaFim,
      reason: `O administrador não habilitou agendamentos para ${dayName}.`,
    };
  }

  const allSlots = availableSlotsOverride ?? useAvailableSlotsStore.getState().slots;
  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, dateISO);

  // Filtra apenas os documentos de `available_slots` com status `liberado` ou `ativo` para a sala e data,
  // excluindo eventuais sobreposições com aulas regulares da grade acadêmica.
  const explicitReleased = allSlots
    .filter((slot) => {
      if (slot.data !== dateISO) return false;
      if (!matchesSlotRoom(slot, room)) return false;
      if (!isSlotActiveOrReleased(slot)) return false;

      const overlapsClass = curriculumClasses.some(
        (aula) => slot.inicio < aula.horarioFim && slot.fim > aula.horarioInicio
      );
      return !overlapsClass;
    })
    .sort((a, b) => a.inicio.localeCompare(b.inicio));

  const baseJanelaInicio = exception?.janelaInicio || config.janelaInicio;
  const baseJanelaFim = exception?.janelaFim || config.janelaFim;

  if (explicitReleased.length === 0) {
    return {
      released: false,
      blocks: [],
      janelaInicio: baseJanelaInicio,
      janelaFim: baseJanelaFim,
      reason: `${UNAVAILABLE_AWAITING_RELEASE_LABEL} para esta sala em ${formatDataBR(dateISO)}.`,
      exception,
    };
  }

  const releasedBlocks = explicitReleased.map((slot) => ({
    id: slot.id,
    availableSlotId: slot.id,
    label: slot.label || `Horário ${slot.inicio}–${slot.fim}`,
    inicio: slot.inicio,
    fim: slot.fim,
    ativo: true,
  }));

  const effectiveJanelaInicio = releasedBlocks.reduce(
    (min, b) => (b.inicio < min ? b.inicio : min),
    baseJanelaInicio
  );
  const effectiveJanelaFim = releasedBlocks.reduce(
    (max, b) => (b.fim > max ? b.fim : max),
    baseJanelaFim
  );

  return {
    released: true,
    blocks: releasedBlocks,
    janelaInicio: effectiveJanelaInicio,
    janelaFim: effectiveJanelaFim,
    exception,
  };
}

export type RoomSlotVisualState =
  | 'LIBERADO'
  | 'AGUARDANDO_LIBERACAO'
  | 'OCUPADO_AULA'
  | 'OCUPADO_RESERVA'
  | 'ENCERRADO';

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
 * Monta a grade completa de slots da sala para uma data específica:
 * - Apenas slots com registro explícito `liberado` ou `ativo` em `available_slots` (e sem conflitos) ficam `selectableForUser: true`.
 * - Aulas regulares da grade aparecem como ocupação acadêmica (`OCUPADO_AULA`).
 * - Reservas ativas aparecem como ocupadas (`OCUPADO_RESERVA`).
 * - Todos os demais horários permanecem desabilitados com "Indisponível - Aguardando liberação da coordenação".
 */
export function getRoomScheduleSlotsForDate(params: {
  room: Room | undefined | null;
  dateISO: string;
  config: ScheduleConfig;
  exceptions: ScheduleException[];
  availableSlots: AvailableSlot[];
  reservations: Reservation[];
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
    now = new Date(),
  } = params;

  if (!room || !dateISO) {
    return { slots: [], curriculumClasses: [], reservableCount: 0 };
  }

  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, dateISO);

  const activeReservationsForRoom = reservations
    .filter(
      (r) =>
        (r.salaId === room.firestoreId || r.salaInstitutionalId === room.id) &&
        r.data === dateISO &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
    )
    .sort((a, b) => a.inicio.localeCompare(b.inicio));

  const roomAvailableDocs = availableSlots.filter(
    (s) => s.data === dateISO && matchesSlotRoom(s, room)
  );

  // Constrói o conjunto de faixas horárias candidatas: blocos institucionais da sala/config + slots customizados em `available_slots`
  const templateBlocks =
    room.blocosHorarios && room.blocosHorarios.length > 0
      ? room.blocosHorarios
      : config.blocosPadrao || [];

  const candidateMap = new Map<
    string,
    { inicio: string; fim: string; label: string }
  >();

  for (const blk of templateBlocks) {
    if (!blk.inicio || !blk.fim || blk.inicio >= blk.fim) continue;
    const key = `${blk.inicio}_${blk.fim}`;
    candidateMap.set(key, {
      inicio: blk.inicio,
      fim: blk.fim,
      label: blk.label || `Bloco ${blk.inicio}–${blk.fim}`,
    });
  }

  for (const slotDoc of roomAvailableDocs) {
    if (!slotDoc.inicio || !slotDoc.fim || slotDoc.inicio >= slotDoc.fim) continue;
    const key = `${slotDoc.inicio}_${slotDoc.fim}`;
    if (!candidateMap.has(key)) {
      candidateMap.set(key, {
        inicio: slotDoc.inicio,
        fim: slotDoc.fim,
        label: slotDoc.label || `Horário ${slotDoc.inicio}–${slotDoc.fim}`,
      });
    } else if (slotDoc.label) {
      candidateMap.set(key, {
        inicio: slotDoc.inicio,
        fim: slotDoc.fim,
        label: slotDoc.label,
      });
    }
  }

  const spaceCheck = isSpaceReleasedByAdmin(room, now);
  const roomSpecificException = exceptions.find(
    (ex) => ex.data === dateISO && ex.salaId === room.firestoreId
  );
  const globalException = exceptions.find(
    (ex) => ex.data === dateISO && (!ex.salaId || ex.salaId === 'TODAS')
  );
  const exception = roomSpecificException || globalException;
  const dayName = getDayNameFromISO(dateISO);

  const isDateOperational =
    spaceCheck.released &&
    config.reservasAbertas &&
    !exception?.fechado &&
    (Boolean(exception) || !isSundayOrHoliday(dateISO)) &&
    (Boolean(exception) ||
      (dayName !== 'Domingo' &&
        (!config.diasSemanaPermitidos ||
          config.diasSemanaPermitidos.length === 0 ||
          config.diasSemanaPermitidos.includes(dayName))));

  const todayISO = getTodayLocalISO(now);
  const nowWithTolerance = new Date(now.getTime() - 60000);

  const sortedCandidates = Array.from(candidateMap.values()).sort((a, b) =>
    a.inicio.localeCompare(b.inicio)
  );

  const slots: RoomScheduleSlotView[] = sortedCandidates.map((cand) => {
    const key = `${cand.inicio}_${cand.fim}`;
    const matchingRes = activeReservationsForRoom.find(
      (r) => cand.inicio < r.fim && cand.fim > r.inicio
    );
    const matchingClass = curriculumClasses.find(
      (aula) => cand.inicio < aula.horarioFim && cand.fim > aula.horarioInicio
    );
    const matchingSlotDoc = roomAvailableDocs.find(
      (s) => s.inicio === cand.inicio && s.fim === cand.fim
    );

    if (matchingRes) {
      return {
        key,
        availableSlotId: matchingSlotDoc?.id,
        inicio: cand.inicio,
        fim: cand.fim,
        label: cand.label,
        state: 'OCUPADO_RESERVA',
        selectableForUser: false,
        statusBadge: 'Reservado',
        statusDetail: 'Indisponível - Horário já reservado',
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
        statusBadge: 'Aula da Grade',
        statusDetail: `Ocupado - Aula regular (${matchingClass.materia} · ${matchingClass.curso} ${matchingClass.semestre}º Sem)`,
        curriculumClass: matchingClass,
        rawAvailableSlot: matchingSlotDoc,
      };
    }

    if (isDateOperational && matchingSlotDoc && isSlotActiveOrReleased(matchingSlotDoc)) {
      if (dateISO === todayISO) {
        const slotStart = createSafeLocalDateTime(dateISO, cand.inicio);
        if (slotStart < nowWithTolerance) {
          return {
            key,
            availableSlotId: matchingSlotDoc.id,
            inicio: cand.inicio,
            fim: cand.fim,
            label: cand.label,
            state: 'ENCERRADO',
            selectableForUser: false,
            statusBadge: 'Encerrado',
            statusDetail: 'Indisponível - Horário já iniciado',
            rawAvailableSlot: matchingSlotDoc,
          };
        }
      }

      const rawStatus = String(matchingSlotDoc.status || 'liberado').toLowerCase();
      return {
        key,
        availableSlotId: matchingSlotDoc.id,
        inicio: cand.inicio,
        fim: cand.fim,
        label: cand.label,
        state: 'LIBERADO',
        selectableForUser: true,
        statusBadge: rawStatus === 'ativo' ? 'Ativo' : 'Liberado',
        statusDetail: 'Liberado pela coordenação - Disponível para agendamento',
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
      statusBadge: 'Bloqueado',
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
 * com status `liberado` ou `ativo` para a sala, data e faixa horária informadas.
 */
export async function verifyAvailableSlotFirestore(
  room: Room,
  dateISO: string,
  inicio: string,
  fim: string
): Promise<AvailableSlot> {
  const curriculumClasses = getCurriculumClassesForRoomOnDate(room, dateISO);
  const classConflict = curriculumClasses.find(
    (aula) => inicio < aula.horarioFim && fim > aula.horarioInicio
  );
  if (classConflict) {
    throw new Error(
      `Horário ocupado por aula regular da grade acadêmica (${classConflict.materia} das ${classConflict.horarioInicio} às ${classConflict.horarioFim}).`
    );
  }

  // 1. Tenta o ID determinístico padrão primeiro (1 leitura rápida)
  const deterministicId = buildAvailableSlotId(room.firestoreId, dateISO, inicio, fim);
  const directSnap = await getDoc(doc(db, 'available_slots', deterministicId));
  if (directSnap.exists()) {
    const raw = directSnap.data() as Partial<AvailableSlot>;
    const hydrated: AvailableSlot = {
      id: directSnap.id,
      salaId: String(raw.salaId || ''),
      salaInstitutionalId: raw.salaInstitutionalId ? String(raw.salaInstitutionalId) : undefined,
      salaNome: String(raw.salaNome || room.nome),
      data: String(raw.data || ''),
      inicio: String(raw.inicio || ''),
      fim: String(raw.fim || ''),
      label: raw.label ? String(raw.label) : undefined,
      status: (String(raw.status || 'bloqueado').toLowerCase() as AvailableSlot['status']),
      ativo: typeof raw.ativo === 'boolean' ? raw.ativo : false,
      createdAt: Number(raw.createdAt || 0),
      updatedAt: Number(raw.updatedAt || 0),
    };
    if (
      matchesSlotRoom(hydrated, room) &&
      hydrated.data === dateISO &&
      hydrated.inicio === inicio &&
      hydrated.fim === fim &&
      isSlotActiveOrReleased(hydrated)
    ) {
      return hydrated;
    }
  }

  // 2. Fallback para documentos criados em `available_slots` com IDs customizados
  const qBySala = query(
    collection(db, 'available_slots'),
    where('salaId', '==', room.firestoreId),
    where('data', '==', dateISO)
  );
  const snapBySala = await getDocs(qBySala);
  for (const d of snapBySala.docs) {
    const raw = d.data() as Partial<AvailableSlot>;
    const hydrated: AvailableSlot = {
      id: d.id,
      salaId: String(raw.salaId || ''),
      salaInstitutionalId: raw.salaInstitutionalId ? String(raw.salaInstitutionalId) : undefined,
      salaNome: String(raw.salaNome || room.nome),
      data: String(raw.data || ''),
      inicio: String(raw.inicio || ''),
      fim: String(raw.fim || ''),
      label: raw.label ? String(raw.label) : undefined,
      status: (String(raw.status || 'bloqueado').toLowerCase() as AvailableSlot['status']),
      ativo: typeof raw.ativo === 'boolean' ? raw.ativo : false,
      createdAt: Number(raw.createdAt || 0),
      updatedAt: Number(raw.updatedAt || 0),
    };
    if (
      hydrated.inicio === inicio &&
      hydrated.fim === fim &&
      isSlotActiveOrReleased(hydrated)
    ) {
      return hydrated;
    }
  }

  if (room.id) {
    const qByInst = query(
      collection(db, 'available_slots'),
      where('salaInstitutionalId', '==', room.id),
      where('data', '==', dateISO)
    );
    const snapByInst = await getDocs(qByInst);
    for (const d of snapByInst.docs) {
      const raw = d.data() as Partial<AvailableSlot>;
      const hydrated: AvailableSlot = {
        id: d.id,
        salaId: String(raw.salaId || ''),
        salaInstitutionalId: raw.salaInstitutionalId ? String(raw.salaInstitutionalId) : undefined,
        salaNome: String(raw.salaNome || room.nome),
        data: String(raw.data || ''),
        inicio: String(raw.inicio || ''),
        fim: String(raw.fim || ''),
        label: raw.label ? String(raw.label) : undefined,
        status: (String(raw.status || 'bloqueado').toLowerCase() as AvailableSlot['status']),
        ativo: typeof raw.ativo === 'boolean' ? raw.ativo : false,
        createdAt: Number(raw.createdAt || 0),
        updatedAt: Number(raw.updatedAt || 0),
      };
      if (
        hydrated.inicio === inicio &&
        hydrated.fim === fim &&
        isSlotActiveOrReleased(hydrated)
      ) {
        return hydrated;
      }
    }
  }

  throw new Error(
    `${UNAVAILABLE_AWAITING_RELEASE_LABEL}. Este horário não consta como liberado pelo Administrador para ${room.nome} em ${formatDataBR(dateISO)}.`
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
