/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'ADMIN' | 'USUARIO';
export type UserVinculo = 'ALUNO' | 'SERVIDOR' | 'COORDENACAO';
export type CalendarCourse = 'GTI' | 'GEEE';

/**
 * Interface padronizada do Perfil de Usuário no Firestore (`users/{userId}`),
 * contemplando os campos solicitados para integração Firebase + WhatsApp API.
 */
export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string; // Somente dígitos sanitizados (ex: "11912345678")
  phoneFormatted?: string; // Formato com máscara (ex: "(11) 91234-5678")
  course?: CalendarCourse;
  semester?: number | null;
  role: UserRole;
  whatsappNotificationsEnabled: boolean;
}

/**
 * Entidade completa de Usuário do TechReserve (compatível com `UserProfile` e governança ADM).
 */
export interface User {
  id: string;
  nome: string;
  name?: string; // Espelho padronizado para `users/{userId}`
  email: string;
  phone?: string; // Número sanitizado sem máscara (ex: "11912345678")
  phoneFormatted?: string; // Número com máscara visual (ex: "(11) 91234-5678")
  whatsappNotificationsEnabled?: boolean; // Preferência de alertas via WhatsApp
  ra?: string; // Registro Acadêmico / Matrícula Institucional
  tipoVinculo?: UserVinculo;
  dataNascimento?: string;
  role: UserRole;
  aprovado: boolean;
  bloqueado: boolean;
  inativo?: boolean;
  blockedDate?: string | null; // Data única bloqueada por No-Show/suspensão pontual (YYYY-MM-DD)
  punidoAte?: number | null; // Campo legado opcional (não utilizado para bloqueios multi-dias)
  motivoPunicao?: string | null;
  createdAt: number;
  updatedAt: number;
  avatarUrl?: string;
  curso?: CalendarCourse;
  course?: CalendarCourse; // Espelho padronizado para `users/{userId}`
  semestre?: number | null;
  semester?: number | null; // Espelho padronizado para `users/{userId}`
  authCodeSubmitted?: string;
}

export type WhatsAppEventType =
  | 'RESERVATION_CONFIRMED'
  | 'RESERVATION_CANCELLED'
  | 'RESERVATION_REMINDER_START'
  | 'RESERVATION_VACATE_10MIN'
  | 'RESERVATION_NO_SHOW'
  | 'PUNISHMENT_APPLIED'
  | 'WHATSAPP_TEST_ALERT';

export interface WhatsAppSendPayload {
  phone: string;
  message: string;
  eventType: WhatsAppEventType;
  instanceName?: string;
  metadata?: Record<string, unknown>;
}

export interface WhatsAppDispatchResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  delivered?: boolean;
  needsQrConnection?: boolean;
  mode?: string;
  to?: string;
  instanceName?: string;
  upstreamStatus?: number;
  endpoint?: string;
  details?: string;
  eventType: WhatsAppEventType;
  timestamp: number;
}

export interface WhatsAppGatewayStatus {
  configured: boolean;
  hasApiToken?: boolean;
  provider: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK';
  connected: boolean;
  state: 'open' | 'connecting' | 'close' | 'missing' | 'unconfigured' | 'ready';
  instanceName: string;
  profileName?: string;
  ownerNumber?: string;
  message?: string;
}

export interface WhatsAppGatewayConnectResult {
  success: boolean;
  connected: boolean;
  state: string;
  instanceName: string;
  qrCodeBase64?: string;
  pairingCode?: string;
  profileName?: string;
  ownerNumber?: string;
  error?: string;
}

export type SpaceCategory = 'SALA' | 'LABORATORIO' | 'AUDITORIO' | 'ESPECIAL';
export type RoomStatus = 'ATIVO' | 'DISPONIVEL' | 'RESERVADO' | 'EM_USO' | 'MANUTENCAO' | 'INATIVO';
export type RealtimeSpaceStatus = 'DISPONIVEL' | 'RESERVADO' | 'EM_USO' | 'MANUTENCAO';

export interface Room {
  firestoreId: string;
  id: string; // Institutional ID (e.g. SALA-001, LAB-001, AUD-001)
  codigo: string; // Institutional Code (e.g. LAB-INFO-01)
  nome: string;
  categoria?: SpaceCategory;
  andar: string;
  capacidade: number;
  descricao: string;
  equipamentos: string[];
  imagem: string;
  status: RoomStatus;
  liberadaParaReserva?: boolean; // Pré-requisito explícito de liberação pelo ADM (padrão true)
  blocosHorarios?: TimeBlock[]; // Blocos de horários específicos liberados pelo ADM para esta sala
  statusManual?: RealtimeSpaceStatus | null;
  bloqueadaAte?: number | null;
  motivoBloqueio?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type Space = Room;

export type ReservationStatus = 'PENDENTE' | 'CONFIRMADA' | 'CANCELADA' | 'CONCLUIDA' | 'PUNIDA';

export interface Reservation {
  id: string;
  salaId: string;
  salaInstitutionalId: string;
  salaNome: string;
  usuarioId: string;
  data: string; // ISO string YYYY-MM-DD
  inicio: string; // HH:mm
  fim: string; // HH:mm
  availableSlotId?: string; // ID do registro explícito em `available_slots` liberado pelo ADM
  checkInExpiracao?: number | null; // timestamp (início + 5 minutos de tolerância)
  checkInRealizado?: boolean;
  status: ReservationStatus;
  observacoes?: string;
  blockedDate?: string | null; // Data exata bloqueada (YYYY-MM-DD) quando status === 'PUNIDA'
  punicaoMotivo?: string;
  punicaoFim?: number;
  ocultoParaUsuario?: boolean;
  // Flags de controle de envio único das notificações de ciclo de vida via WhatsApp
  whatsappConfirmacaoEnviada?: boolean;
  whatsappLembreteInicioEnviado?: boolean;
  whatsappAlertaDesocupacaoEnviado?: boolean;
  whatsappNoShowEnviado?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AvailableSlotStatus = 'liberado' | 'ativo' | 'disponivel' | 'bloqueado' | 'inativo';

/**
 * Registro explícito de liberação de horário pelo Administrador na coleção `available_slots`.
 * Por padrão, nenhum horário fica disponível para o Usuário/Aluno sem este registro ativo.
 */
export interface AvailableSlot {
  id: string;
  salaId: string; // Firestore doc ID em `salas` (ou `roomId` normalizado)
  salaInstitutionalId?: string; // Ex: LAB-001, SALA-003
  salaNome: string;
  data: string; // YYYY-MM-DD (ou `date` normalizado)
  inicio: string; // HH:mm
  fim: string; // HH:mm
  timeSlot?: string; // Ex: "19:00 - 19:50"
  label?: string;
  status: AvailableSlotStatus;
  ativo: boolean;
  liberadoPorId?: string;
  liberadoPorNome?: string;
  createdAt: number;
  updatedAt: number;
}

export type DayOfWeek = 'Segunda' | 'Terça' | 'Quarta' | 'Quinta' | 'Sexta' | 'Sábado';

/**
 * Bloco padrão ou customizado de horário (ex: aula de 50 minutos)
 */
export interface TimeBlock {
  id: string;
  label: string;
  inicio: string; // HH:mm
  fim: string; // HH:mm
  ativo: boolean;
}

/**
 * Configuração global centralizada de abertura e janelas operacionais (coleção `schedules`, doc `global_config`)
 */
export interface ScheduleConfig {
  id: string;
  tipoDoc: 'GLOBAL_CONFIG';
  reservasAbertas: boolean;
  horaAberturaSistema: number;
  janelaInicio: string;
  janelaFim: string;
  duracaoBlocoPadraoMinutos: number;
  intervaloEntreBlocosMinutos: number;
  antecedenciaMaximaDias: number;
  diasSemanaPermitidos: DayOfWeek[];
  blocosPadrao: TimeBlock[];
  updatedAt: number;
  updatedBy?: string;
}

/**
 * Exceção de horário para uma data específica (coleção `schedules`)
 */
export interface ScheduleException {
  id: string;
  tipoDoc: 'EXCEPTION';
  data: string; // YYYY-MM-DD
  titulo: string;
  fechado: boolean;
  janelaInicio?: string;
  janelaFim?: string;
  salaId?: string;
  salaNome?: string;
  blocosCustomizados?: TimeBlock[];
  motivo?: string;
  createdAt: number;
  updatedAt: number;
}

export type PunishmentCategory =
  | 'NO_SHOW'
  | 'MAU_USO'
  | 'ATRASO'
  | 'DESCUMPRIMENTO_NORMAS'
  | 'OUTRO';

export interface PunishmentRecord {
  id: string;
  usuarioId: string;
  usuarioNome: string;
  usuarioEmail?: string;
  usuarioRa?: string;
  reservaId?: string;
  categoriaMotivo?: PunishmentCategory;
  motivo: string;
  blockedDate: string; // Data exata da falta/bloqueio (YYYY-MM-DD) — sem bloqueio multi-dias
  duracaoDias?: number; // Campo legado opcional
  dataInicio: number;
  dataFim?: number; // Campo legado opcional
  tipo: 'AUTOMATICA' | 'MANUAL';
  aplicadoPorId?: string;
  aplicadoPorNome?: string;
  ativa: boolean;
  revogadaEm?: number;
  revogadaPorNome?: string;
}

export type Punishment = PunishmentRecord;

export interface AdminAuthConfig {
  codeAuth: string;
  allowAdminSignup: boolean;
  updatedAt: number;
  updatedBy: string;
  updatedByName: string;
}

export interface WhatsAppIntegrationSettings {
  whatsappConnected: boolean;
  isConfigured: boolean;
  instanceName: string;
  provider: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK';
  updatedAt: number;
  updatedBy: string;
  updatedByName: string;
}

export type LogEntity =
  | 'USERS'
  | 'SALAS'
  | 'RESERVAS'
  | 'PUNIDAS'
  | 'HORARIOS'
  | 'SISTEMA'
  | 'CHAMADOS'
  | 'WHATSAPP';

export interface Log {
  id: string;
  acao: string;
  usuarioId: string;
  usuarioNome: string;
  entidade: LogEntity;
  detalhes: string;
  createdAt: number;
}

export type CalendarEventType = 'AULA_GRADE' | 'RESERVA_USUARIO';

export interface CalendarEvent {
  id: string;
  tipo: CalendarEventType;
  curso: CalendarCourse;
  semestre: number;
  diaSemana: DayOfWeek;
  materia: string;
  professor?: string;
  solicitante?: string;
  usuarioId?: string;
  sala: string;
  salaId?: string;
  salaInstitutionalId?: string;
  horarioInicio: string;
  horarioFim: string;
  cor: 'azul' | 'verde' | 'vermelho';
  status?: string;
  data?: string;
  observacoes?: string;
  reservationId?: string;
}

/**
 * Infere a categoria pedagógica do ambiente caso o documento legado não possua o campo `categoria`.
 */
export function inferSpaceCategory(
  room?: Partial<Pick<Room, 'id' | 'codigo' | 'nome' | 'categoria'>> | null
): SpaceCategory {
  if (!room) return 'SALA';
  if (room.categoria) return room.categoria;
  const ref = `${room.id || ''} ${room.codigo || ''} ${room.nome || ''}`.toUpperCase();
  if (ref.includes('AUD') || ref.includes('TEATRO')) return 'AUDITORIO';
  if (ref.includes('LAB') || ref.includes('QUI-') || ref.includes('CAD-') || ref.includes('BRA-')) return 'LABORATORIO';
  if (ref.includes('SALA-0') || ref.includes('SALA DE AULA')) return 'SALA';
  return 'ESPECIAL';
}

/**
 * Calcula o status operacional em tempo real de um espaço considerando overrides administrativos,
 * bloqueios temporários e reservas em andamento / agendadas hoje.
 */
export function resolveRoomRealtimeStatus(
  room?: Room | null,
  reservations: Reservation[] = [],
  now: Date = new Date()
): {
  status: RealtimeSpaceStatus;
  currentReservation?: Reservation;
  nextReservation?: Reservation;
  isTemporarilyBlocked: boolean;
} {
  if (!room) {
    return { status: 'DISPONIVEL', isTemporarilyBlocked: false };
  }

  const nowMs = now.getTime();
  const isTemporarilyBlocked = Boolean(room.bloqueadaAte && room.bloqueadaAte > nowMs);

  if (
    room.status === 'MANUTENCAO' ||
    room.status === 'INATIVO' ||
    room.statusManual === 'MANUTENCAO' ||
    isTemporarilyBlocked
  ) {
    return { status: 'MANUTENCAO', isTemporarilyBlocked };
  }

  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const safeReservations = Array.isArray(reservations) ? reservations : [];

  const activeToday = safeReservations
    .filter(
      (r) =>
        Boolean(r) &&
        (r.salaId === room.firestoreId || r.salaInstitutionalId === room.id) &&
        r.data === todayISO &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
    )
    .sort((a, b) => (a?.inicio || '').localeCompare(b?.inicio || ''));

  const currentReservation = activeToday.find(
    (r) => Boolean(r?.inicio && r?.fim) && nowHHMM >= r.inicio && nowHHMM < r.fim
  );
  const nextReservation = activeToday.find((r) => Boolean(r?.inicio) && r.inicio > nowHHMM);

  if (room.statusManual === 'EM_USO' || room.status === 'EM_USO') {
    return { status: 'EM_USO', currentReservation, nextReservation, isTemporarilyBlocked: false };
  }
  if (room.statusManual === 'RESERVADO' || room.status === 'RESERVADO') {
    return { status: 'RESERVADO', currentReservation, nextReservation, isTemporarilyBlocked: false };
  }

  if (currentReservation) {
    return {
      status: currentReservation.status === 'CONFIRMADA' ? 'EM_USO' : 'RESERVADO',
      currentReservation,
      nextReservation,
      isTemporarilyBlocked: false,
    };
  }

  if (nextReservation) {
    return { status: 'RESERVADO', nextReservation, isTemporarilyBlocked: false };
  }

  return { status: 'DISPONIVEL', isTemporarilyBlocked: false };
}
