/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contexto dinâmico para o template de Confirmação de Reserva.
 */
export interface ConfirmationTemplateVars {
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string; // Formato DD/MM/YYYY
  timeSlot: string; // Ex.: "19:00 às 19:50"
  startTime: string; // Ex.: "19:00"
  endTime: string; // Ex.: "19:50"
  checkInDeadline?: string; // Ex.: "19:05"
  isAdmin?: boolean;
}

/**
 * Contexto dinâmico para o template de Lembrete de Reserva (10 min antes).
 */
export interface ReminderTemplateVars {
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string; // Formato DD/MM/YYYY
  timeSlot: string; // Ex.: "19:00 às 19:50"
  startTime: string; // Ex.: "19:00"
  endTime: string; // Ex.: "19:50"
  checkInDeadline?: string; // Ex.: "19:05"
  minutesBefore?: number; // Padrão: 10
  isAdmin?: boolean;
}

/**
 * Contexto dinâmico para o template de Alerta de No-Show / Bloqueio na data específica.
 */
export interface NoShowTemplateVars {
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string; // Formato DD/MM/YYYY (data específica bloqueada)
  timeSlot: string; // Ex.: "19:00 às 19:50"
  startTime: string; // Ex.: "19:00"
  endTime: string; // Ex.: "19:50"
  checkInDeadline?: string; // Ex.: "19:05"
}

/**
 * Contexto dinâmico para o template de Bloqueio / Restrição Manual pela Coordenação.
 */
export interface ManualBlockTemplateVars {
  userName: string;
  blockedDate: string; // Formato DD/MM/YYYY
  reason: string;
}

/**
 * Contexto dinâmico para o template de Desocupação (10 min antes do término).
 */
export interface VacateWarningTemplateVars {
  userName: string;
  roomName: string;
  roomCode?: string;
  date?: string;
  timeSlot: string;
  endTime: string;
}

/**
 * Contexto dinâmico para o template de Cancelamento de Reserva.
 */
export interface CancellationTemplateVars {
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string; // Formato DD/MM/YYYY
  timeSlot: string; // Ex.: "19:00 às 19:50"
  cancelledBy: 'USUARIO' | 'ADMIN';
  reason?: string;
}

/**
 * Contexto dinâmico para o template de Teste / Validação de WhatsApp.
 */
export interface TestAlertTemplateVars {
  userName: string;
  displayPhone: string;
}

/**
 * Tolerância oficial para leitura do QR Code após o início da reserva (em minutos).
 */
export const CHECKIN_TOLERANCE_MINUTES = 5;

/**
 * Calcula o horário limite de check-in somando minutos ao horário de início (`HH:mm`).
 * Exemplo: `calculateCheckInDeadline("19:00", 5)` -> `"19:05"`.
 */
export function calculateCheckInDeadline(
  startTime: string,
  toleranceMinutes = CHECKIN_TOLERANCE_MINUTES
): string {
  const match = String(startTime || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return startTime;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return startTime;

  const totalMinutes = (hours * 60 + minutes + toleranceMinutes) % (24 * 60);
  const nextHours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const nextMinutes = String(totalMinutes % 60).padStart(2, '0');
  return `${nextHours}:${nextMinutes}`;
}

/**
 * Sanitiza textos interpolados em negrito do WhatsApp (`*texto*`), evitando espaços nas bordas
 * ou asteriscos internos que quebrariam a formatação visual no aplicativo.
 */
function cleanVar(value: string | undefined | null, fallback: string): string {
  const cleaned = String(value || '')
    .replace(/\*/g, '')
    .trim();
  return cleaned || fallback;
}

function formatRoomDisplay(roomName: string, roomCode?: string): string {
  const safeRoom = cleanVar(roomName, 'Ambiente Institucional');
  const safeCode = cleanVar(roomCode, '');
  if (!safeCode || safeRoom.toLowerCase().includes(safeCode.toLowerCase())) {
    return safeRoom;
  }
  return `${safeRoom} (${safeCode})`;
}

/**
 * Constante centralizada de templates das notificações automáticas via WhatsApp do TechReserve.
 * Facilita futuras alterações de texto, emojis e layout sem acoplamento com a camada HTTP da Evolution API.
 */
export const WHATSAPP_TEMPLATES = {
  /**
   * 1. Template: Confirmação de Reserva
   */
  RESERVATION_CONFIRMED: (vars: ConfirmationTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const roomLabel = formatRoomDisplay(vars.roomName, vars.roomCode);
    const date = cleanVar(vars.date, '--/--/----');
    const timeSlot = cleanVar(
      vars.timeSlot,
      `${cleanVar(vars.startTime, '--:--')} às ${cleanVar(vars.endTime, '--:--')}`
    );
    const deadline = cleanVar(
      vars.checkInDeadline || calculateCheckInDeadline(vars.startTime),
      vars.startTime
    );

    const checkInBlock = vars.isAdmin
      ? [
          `✅ *Acesso Administrativo:*`,
          `Sua reserva institucional já está liberada automaticamente, sem necessidade de check-in presencial.`,
        ].join('\n')
      : [
          `📲 *Check-in na entrada:*`,
          `Ao chegar ao local, abra o TechReserve e escaneie o *QR Code* fixado na entrada do ambiente até as *${deadline}* (tolerância de *${CHECKIN_TOLERANCE_MINUTES} minutos*) para confirmar sua presença. Bom uso!`,
        ].join('\n');

    return [
      `✅ *TechReserve — Reserva Confirmada!*`,
      ``,
      `Olá, *${userName}*! Tudo certo com o seu agendamento. Confira os detalhes abaixo:`,
      ``,
      `👤 Aluno/Responsável: *${userName}*`,
      `📍 Sala/Laboratório: *${roomLabel}*`,
      `📅 Data: *${date}*`,
      `⏰ Horário: *${timeSlot}*`,
      ``,
      checkInBlock,
    ].join('\n');
  },

  /**
   * 2. Template: Lembrete de Reserva (10 min antes)
   */
  RESERVATION_REMINDER: (vars: ReminderTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const roomLabel = formatRoomDisplay(vars.roomName, vars.roomCode);
    const date = cleanVar(vars.date, '--/--/----');
    const timeSlot = cleanVar(
      vars.timeSlot,
      `${cleanVar(vars.startTime, '--:--')} às ${cleanVar(vars.endTime, '--:--')}`
    );
    const minutesBefore = vars.minutesBefore ?? 10;
    const deadline = cleanVar(
      vars.checkInDeadline || calculateCheckInDeadline(vars.startTime),
      vars.startTime
    );

    const checkInAlert = vars.isAdmin
      ? `✅ Seu acesso administrativo já se encontra confirmado e liberado para este horário.`
      : [
          `⏳ *Horário limite para Check-in: ${deadline}*`,
          `Lembre-se de realizar o check-in escaneando o *QR Code* na entrada com tolerância máxima de *${CHECKIN_TOLERANCE_MINUTES} minutos* após o início (*${vars.startTime}* às *${deadline}*). Após esse limite, a reserva é cancelada automaticamente por ausência.`,
        ].join('\n');

    return [
      `🔔 *TechReserve — Lembrete de Reserva*`,
      ``,
      `Olá, *${userName}*! ⏳ Sua reserva começa em *${minutesBefore} minutos*.`,
      ``,
      `📍 Sala/Laboratório: *${roomLabel}*`,
      `📅 Data: *${date}*`,
      `⏰ Horário: *${timeSlot}*`,
      ``,
      checkInAlert,
    ].join('\n');
  },

  /**
   * 3. Template: Alerta de No-Show / Bloqueio
   */
  RESERVATION_NO_SHOW: (vars: NoShowTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const roomLabel = formatRoomDisplay(vars.roomName, vars.roomCode);
    const date = cleanVar(vars.date, '--/--/----');
    const timeSlot = cleanVar(
      vars.timeSlot,
      `${cleanVar(vars.startTime, '--:--')} às ${cleanVar(vars.endTime, '--:--')}`
    );
    const deadline = cleanVar(
      vars.checkInDeadline || calculateCheckInDeadline(vars.startTime),
      vars.startTime
    );

    return [
      `⚠️ *TechReserve — Alerta de No-Show / Bloqueio*`,
      ``,
      `Olá, *${userName}*.`,
      `❌ Sua ausência foi registrada porque o check-in via QR Code não foi realizado até as *${deadline}* (tolerância de *${CHECKIN_TOLERANCE_MINUTES} minutos*).`,
      ``,
      `📍 Sala/Laboratório liberada: *${roomLabel}*`,
      `📅 Data da ausência: *${date}*`,
      `⏰ Horário: *${timeSlot}*`,
      ``,
      `⚠️ *Status do Perfil:*`,
      `Você ficará *bloqueado para novos agendamentos na data ${date}*. Para outras datas da semana, sua cota permanece liberada normalmente.`,
    ].join('\n');
  },

  /**
   * 4. Template complementar: Bloqueio / Restrição Manual aplicada pela Coordenação
   */
  PUNISHMENT_APPLIED: (vars: ManualBlockTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const blockedDate = cleanVar(vars.blockedDate, '--/--/----');
    const reason = cleanVar(vars.reason, 'Descumprimento das normas de uso');

    return [
      `⚠️ *TechReserve — Aviso de Bloqueio de Agendamento*`,
      ``,
      `Olá, *${userName}*.`,
      `❌ A Coordenação registrou uma restrição de agendamento em seu perfil.`,
      ``,
      `📅 Data bloqueada: *${blockedDate}*`,
      `📌 Motivo: *${reason}*`,
      ``,
      `⚠️ Você ficará *bloqueado para agendamentos na data ${blockedDate}*.`,
    ].join('\n');
  },

  /**
   * 5. Template complementar: Alerta de Desocupação (10 min antes do término)
   */
  VACATE_WARNING_10MIN: (vars: VacateWarningTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const roomLabel = formatRoomDisplay(vars.roomName, vars.roomCode);
    const endTime = cleanVar(vars.endTime, '--:--');
    const timeSlot = cleanVar(vars.timeSlot, `término às ${endTime}`);

    return [
      `⏳ *TechReserve — Aviso de Encerramento (10 min)*`,
      ``,
      `Olá, *${userName}*! Faltam *10 minutos* para o término do seu horário de uso.`,
      ``,
      `📍 Sala/Laboratório: *${roomLabel}*`,
      `⏰ Horário reservado: *${timeSlot}* (encerramento às *${endTime}*)`,
      ``,
      `Por gentileza, inicie a organização das bancadas/equipamentos e libere o espaço pontualmente para o próximo agendamento. Obrigado!`,
    ].join('\n');
  },

  /**
   * 6. Template complementar: Cancelamento de Reserva
   */
  RESERVATION_CANCELLED: (vars: CancellationTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const roomLabel = formatRoomDisplay(vars.roomName, vars.roomCode);
    const date = cleanVar(vars.date, '--/--/----');
    const timeSlot = cleanVar(vars.timeSlot, '--:--');
    const originText =
      vars.cancelledBy === 'ADMIN'
        ? 'pela *Coordenação / Administração*'
        : 'por solicitação no *seu perfil*';

    return [
      `❌ *TechReserve — Reserva Cancelada*`,
      ``,
      `Olá, *${userName}*. Informamos que sua reserva foi cancelada ${originText}.`,
      ``,
      `📍 Sala/Laboratório: *${roomLabel}*`,
      `📅 Data: *${date}*`,
      `⏰ Horário: *${timeSlot}*`,
      ...(vars.reason ? [`📌 Observação: *${cleanVar(vars.reason, '')}*`] : []),
      ``,
      `✅ O ambiente foi liberado e sua cota semanal permanece disponível para novos agendamentos.`,
    ].join('\n');
  },

  /**
   * 7. Template complementar: Teste de Validação do WhatsApp
   */
  WHATSAPP_TEST_ALERT: (vars: TestAlertTemplateVars): string => {
    const userName = cleanVar(vars.userName, 'Usuário');
    const displayPhone = cleanVar(vars.displayPhone, '');

    return [
      `✅ *TechReserve — WhatsApp Validado com Sucesso!*`,
      ``,
      `Olá, 👤 *${userName}*! Seu número *${displayPhone}* está ativo e pronto para receber notificações automáticas:`,
      ``,
      `✅ *Confirmação e cancelamento* de reservas`,
      `🔔 *Lembrete prévio* (*10 min* antes do início)`,
      `⏳ *Aviso de desocupação* (*10 min* antes do término)`,
      `⚠️ *Alerta de No-Show / Bloqueio* por ausência de check-in`,
    ].join('\n');
  },
} as const;
