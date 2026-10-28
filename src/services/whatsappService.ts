/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Reservation,
  User,
  WhatsAppDispatchResult,
  WhatsAppEventType,
  WhatsAppSendPayload,
} from '../types';
import { formatDataBR } from '../utils/dateUtils';
import { formatPhoneMask, toWhatsAppApiPhone, validatePhoneNumber } from '../utils/phoneUtils';
import { useLogStore } from '../store/useLogStore';

/**
 * Configuração da integração WhatsApp carregada a partir das variáveis de ambiente (`.env`).
 *
 * Arquitetura de segurança:
 * - Por padrão, as requisições `POST` são enviadas para `/api/whatsapp/send` (rota proxy no backend Express),
 *   que lê `WHATSAPP_API_URL`, `WHATSAPP_API_TOKEN` e `WHATSAPP_PROVIDER` do `.env` no servidor sem expor credenciais no navegador.
 * - Caso a aplicação rode em hospedagem puramente estática e `VITE_WHATSAPP_API_URL` esteja definida no `.env`,
 *   o serviço utiliza essa URL como endpoint HTTP/Webhook direto via `fetch` (`POST`).
 */
const viteEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env || {};

const ENV_DIRECT_API_URL = String(viteEnv.VITE_WHATSAPP_API_URL || '').trim();
const ENV_PROXY_ENDPOINT = String(
  viteEnv.VITE_WHATSAPP_PROXY_URL || '/api/whatsapp/send'
).trim();
const ENV_PROVIDER = String(viteEnv.VITE_WHATSAPP_PROVIDER || 'WEBHOOK')
  .trim()
  .toUpperCase();
const REQUEST_TIMEOUT_MS = 10000;

export interface DirectReservationAlertInput {
  phone: string;
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string; // YYYY-MM-DD ou DD/MM/YYYY
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  reservationId?: string;
  isAdmin?: boolean;
}

/**
 * Monta o corpo JSON compatível com o provedor configurado quando utilizado endpoint direto (`VITE_WHATSAPP_API_URL`).
 */
function buildDirectProviderBody(
  apiPhone: string,
  message: string,
  eventType: WhatsAppEventType,
  metadata?: Record<string, unknown>
): Record<string, unknown> {
  if (ENV_PROVIDER === 'META_CLOUD') {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: apiPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: message,
      },
    };
  }

  if (ENV_PROVIDER === 'EVOLUTION') {
    return {
      number: apiPhone,
      text: message,
    };
  }

  return {
    to: apiPhone,
    message,
    eventType,
    source: 'TechReserve',
    timestamp: Date.now(),
    metadata: metadata || {},
  };
}

/**
 * Verifica se o usuário possui número válido cadastrado e optou por receber alertas via WhatsApp.
 */
export function canReceiveWhatsAppAlerts(
  user: Pick<User, 'phone' | 'whatsappNotificationsEnabled'> | null | undefined
): { allowed: boolean; apiNumber: string; reason?: string } {
  if (!user) {
    return { allowed: false, apiNumber: '', reason: 'Usuário não identificado.' };
  }

  if (user.whatsappNotificationsEnabled === false) {
    return {
      allowed: false,
      apiNumber: '',
      reason: 'Notificações via WhatsApp desativadas nas preferências do usuário.',
    };
  }

  const validation = validatePhoneNumber(user.phone);
  if (!validation.isValid) {
    return {
      allowed: false,
      apiNumber: '',
      reason: validation.error || 'Número de WhatsApp ausente ou inválido no perfil.',
    };
  }

  return {
    allowed: true,
    apiNumber: validation.apiNumber,
  };
}

/**
 * Envia mensagem de WhatsApp via HTTP `POST` utilizando `fetch`.
 *
 * 1. Sanitiza o telefone para padrão internacional sem máscara (`5511912345678`).
 * 2. Realiza `fetch` (`POST`) para o proxy `/api/whatsapp/send` (que consome `WHATSAPP_API_URL` e `WHATSAPP_API_TOKEN` do `.env`).
 * 3. Se o proxy não estiver disponível (ex.: deploy estático, HTTP 404) e `VITE_WHATSAPP_API_URL` estiver configurada no `.env`,
 *    dispara diretamente via `fetch` (`POST`) para a URL configurada.
 */
export async function sendWhatsAppMessage(
  payload: WhatsAppSendPayload,
  customEndpoint?: string
): Promise<WhatsAppDispatchResult> {
  const timestamp = Date.now();
  const apiPhone = toWhatsAppApiPhone(payload.phone);

  if (!apiPhone || apiPhone.length < 12) {
    return {
      success: false,
      skipped: true,
      reason: 'Número de telefone inválido para envio.',
      eventType: payload.eventType,
      timestamp,
    };
  }

  const targetEndpoint = customEndpoint || ENV_PROXY_ENDPOINT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: apiPhone,
        message: payload.message,
        eventType: payload.eventType,
        metadata: payload.metadata || {},
      }),
      signal: controller.signal,
    });

    // Fallback para `VITE_WHATSAPP_API_URL` caso o backend proxy retorne 404 em ambiente estático
    if (response.status === 404 && !customEndpoint && ENV_DIRECT_API_URL) {
      clearTimeout(timeoutId);
      const directController = new AbortController();
      const directTimeout = setTimeout(() => directController.abort(), REQUEST_TIMEOUT_MS);

      try {
        const directResponse = await fetch(ENV_DIRECT_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildDirectProviderBody(apiPhone, payload.message, payload.eventType, payload.metadata)
          ),
          signal: directController.signal,
        });

        clearTimeout(directTimeout);

        if (!directResponse.ok) {
          return {
            success: false,
            delivered: false,
            reason: `Falha HTTP ${directResponse.status} ao enviar mensagem para a API WhatsApp.`,
            to: apiPhone,
            eventType: payload.eventType,
            timestamp,
          };
        }

        return {
          success: true,
          delivered: true,
          mode: 'DIRECT_ENV_URL',
          to: apiPhone,
          eventType: payload.eventType,
          timestamp,
        };
      } finally {
        clearTimeout(directTimeout);
      }
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.success === false) {
      return {
        success: false,
        delivered: false,
        reason: data?.error || `Falha HTTP ${response.status} ao comunicar com serviço WhatsApp.`,
        to: apiPhone,
        eventType: payload.eventType,
        timestamp,
      };
    }

    return {
      success: true,
      delivered: Boolean(data?.delivered),
      mode: data?.mode || 'WEBHOOK',
      to: apiPhone,
      eventType: payload.eventType,
      timestamp,
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    return {
      success: false,
      delivered: false,
      reason: isAbort
        ? 'Tempo limite excedido ao comunicar com a API do WhatsApp.'
        : error instanceof Error
        ? error.message
        : 'Falha de rede no envio WhatsApp.',
      to: apiPhone,
      eventType: payload.eventType,
      timestamp,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Registra trilha auditável do disparo WhatsApp na coleção `logs` do Firestore.
 */
async function registerWhatsAppLog(
  user: Pick<User, 'id' | 'nome' | 'phone'>,
  eventType: WhatsAppEventType,
  summary: string,
  result: WhatsAppDispatchResult
): Promise<void> {
  try {
    const maskedPhone = formatPhoneMask(user.phone) || 'Sem número';
    await useLogStore.getState().addLog({
      acao: `WHATSAPP_${eventType}`,
      usuarioId: user.id,
      usuarioNome: user.nome || 'Usuário',
      entidade: 'WHATSAPP',
      detalhes: `${summary} · Destino: ${maskedPhone} · Status: ${
        result.delivered
          ? 'Entregue via API'
          : result.success
          ? 'Registrado (Homologação)'
          : `Falha (${result.reason || 'erro'})`
      }`,
    });
  } catch {
    // Falha secundária de auditoria não interrompe o fluxo principal da reserva
  }
}

/* ============================================================================
 * 1. CONFIRMAÇÃO DE RESERVA
 * ========================================================================== */

/**
 * Envia confirmação de agendamento via `POST` contendo resumo da sala, data e bloco de horário.
 */
export async function sendReservationConfirmation(
  input: DirectReservationAlertInput
): Promise<WhatsAppDispatchResult> {
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const roomLabel = input.roomCode ? `${input.roomName} (${input.roomCode})` : input.roomName;
  const checkInInstruction = input.isAdmin
    ? 'Reserva administrativa confirmada automaticamente.'
    : 'Importante: realize o check-in presencial via QR Code na porta do ambiente em até 5 minutos após o início para evitar cancelamento por No-Show.';

  const message = [
    `*TechReserve — Confirmação de Agendamento*`,
    `Olá, *${input.userName}*! Sua solicitação de reserva foi registrada.`,
    ``,
    `• *Ambiente:* ${roomLabel}`,
    `• *Data:* ${formattedDate}`,
    `• *Bloco de Horário:* ${input.startTime} às ${input.endTime}`,
    ``,
    checkInInstruction,
  ].join('\n');

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_CONFIRMED',
    metadata: {
      reservationId: input.reservationId || null,
      room: input.roomCode || input.roomName,
      date: input.date,
      start: input.startTime,
      end: input.endTime,
    },
  });
}

/**
 * Dispara confirmação de agendamento validando preferências do usuário (`whatsappNotificationsEnabled`) e registrando log.
 */
export async function notifyReservationConfirmed(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled' | 'role'>,
  reservation: Pick<
    Reservation,
    'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim' | 'status'
  >
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'RESERVATION_CONFIRMED',
      timestamp: Date.now(),
    };
  }

  const result = await sendReservationConfirmation({
    phone: eligibility.apiNumber,
    userName: user.nome,
    roomName: reservation.salaNome,
    roomCode: reservation.salaInstitutionalId,
    date: reservation.data,
    startTime: reservation.inicio,
    endTime: reservation.fim,
    reservationId: reservation.id,
    isAdmin: user.role === 'ADMIN',
  });

  await registerWhatsAppLog(
    user,
    'RESERVATION_CONFIRMED',
    `Confirmação de agendamento em ${reservation.salaNome} (${formatDataBR(reservation.data)} ${reservation.inicio}-${reservation.fim})`,
    result
  );

  return result;
}

/* ============================================================================
 * 2. LEMBRETES DE RESERVA (PRÉ-INÍCIO E DESOCUPAÇÃO FALTANDO 10 MINUTOS)
 * ========================================================================== */

/**
 * Envia lembrete prévio de início da reserva via `POST`.
 */
export async function sendReservationReminder(
  input: DirectReservationAlertInput & { minutesBefore?: number }
): Promise<WhatsAppDispatchResult> {
  const minutesBefore = input.minutesBefore ?? 15;
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const roomLabel = input.roomCode ? `${input.roomName} (${input.roomCode})` : input.roomName;

  const message = [
    `*TechReserve — Lembrete de Início de Reserva*`,
    `Olá, *${input.userName}*! Sua reserva começará em aproximadamente *${minutesBefore} minutos*.`,
    ``,
    `• *Ambiente:* ${roomLabel}`,
    `• *Data:* ${formattedDate}`,
    `• *Início:* ${input.startTime} (Término: ${input.endTime})`,
    ``,
    input.isAdmin
      ? `Seu acesso administrativo já está liberado.`
      : `Lembre-se de escanear o *QR Code* do ambiente em até *5 minutos* após ${input.startTime} para confirmar sua presença.`,
  ].join('\n');

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_REMINDER_START',
    metadata: {
      reservationId: input.reservationId || null,
      minutesBefore,
    },
  });
}

/**
 * Dispara lembrete prévio de início respeitando opt-in do usuário e registrando auditoria.
 */
export async function notifyUpcomingReservationReminder(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled' | 'role'>,
  reservation: Pick<Reservation, 'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'>,
  minutesBefore = 15
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'RESERVATION_REMINDER_START',
      timestamp: Date.now(),
    };
  }

  const result = await sendReservationReminder({
    phone: eligibility.apiNumber,
    userName: user.nome,
    roomName: reservation.salaNome,
    roomCode: reservation.salaInstitutionalId,
    date: reservation.data,
    startTime: reservation.inicio,
    endTime: reservation.fim,
    reservationId: reservation.id,
    isAdmin: user.role === 'ADMIN',
    minutesBefore,
  });

  await registerWhatsAppLog(
    user,
    'RESERVATION_REMINDER_START',
    `Lembrete prévio enviado para ${reservation.salaNome} (${reservation.inicio})`,
    result
  );

  return result;
}

/**
 * Alerta de Desocupação (faltando 10 minutos para o término do bloco de 50 minutos),
 * orientando a organização dos equipamentos e liberação pontual do espaço.
 */
export async function notifyVacateWarning10Min(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<Reservation, 'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'>
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'RESERVATION_VACATE_10MIN',
      timestamp: Date.now(),
    };
  }

  const message = [
    `*TechReserve — Alerta de Desocupação (10 Minutos Restantes)*`,
    `Olá, *${user.nome}*. Faltam *10 minutos* para o encerramento oficial do seu bloco de uso às *${reservation.fim}*.`,
    ``,
    `• *Ambiente:* ${reservation.salaNome} (${reservation.salaInstitutionalId})`,
    `• *Encerramento do Bloco:* ${reservation.fim}`,
    ``,
    `Por gentileza, inicie a organização das bancadas/equipamentos, desligue projetores ou computadores utilizados e libere o espaço pontualmente para a próxima turma.`,
  ].join('\n');

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'RESERVATION_VACATE_10MIN',
    metadata: {
      reservationId: reservation.id,
      room: reservation.salaInstitutionalId,
      endTime: reservation.fim,
    },
  });

  await registerWhatsAppLog(
    user,
    'RESERVATION_VACATE_10MIN',
    `Alerta de desocupação (10 min restantes) em ${reservation.salaNome}`,
    result
  );

  return result;
}

/* ============================================================================
 * 3. ALERTA DE NO-SHOW (AUSÊNCIA DE CHECK-IN EM 5 MINUTOS)
 * ========================================================================== */

/**
 * Envia alerta de No-Show via `POST` quando a reserva expira após 5 minutos sem check-in via QR Code.
 */
export async function sendNoShowAlert(
  input: DirectReservationAlertInput
): Promise<WhatsAppDispatchResult> {
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const roomLabel = input.roomCode ? `${input.roomName} (${input.roomCode})` : input.roomName;

  const message = [
    `*TechReserve — Aviso de No-Show (Ausência de Check-in)*`,
    `Olá, *${input.userName}*. Sua reserva foi cancelada automaticamente por exceder o limite de *5 minutos* sem check-in presencial via QR Code.`,
    ``,
    `• *Ambiente Liberado:* ${roomLabel}`,
    `• *Data / Bloco:* ${formattedDate} (${input.startTime} às ${input.endTime})`,
    `• *Status:* Punição de No-Show: Bloqueado apenas em ${formattedDate}`,
    ``,
    `Você está impossibilitado de realizar novas reservas exclusivamente no restante do dia *${formattedDate}*. Sua cota semanal de 1 reserva permanece liberada para agendar em outras datas.`,
  ].join('\n');

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_NO_SHOW',
    metadata: {
      reservationId: input.reservationId || null,
      room: input.roomCode || input.roomName,
      date: input.date,
      start: input.startTime,
    },
  });
}

/**
 * Dispara aviso de No-Show validando preferências do usuário e registrando auditoria no Firestore.
 */
export async function notifyNoShowAutoCancelled(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<Reservation, 'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'>
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'RESERVATION_NO_SHOW',
      timestamp: Date.now(),
    };
  }

  const result = await sendNoShowAlert({
    phone: eligibility.apiNumber,
    userName: user.nome,
    roomName: reservation.salaNome,
    roomCode: reservation.salaInstitutionalId,
    date: reservation.data,
    startTime: reservation.inicio,
    endTime: reservation.fim,
    reservationId: reservation.id,
  });

  await registerWhatsAppLog(
    user,
    'RESERVATION_NO_SHOW',
    `Notificação de No-Show automático em ${reservation.salaNome}`,
    result
  );

  return result;
}

/* ============================================================================
 * 4. CANCELAMENTO E VALIDAÇÃO DE CONEXÃO
 * ========================================================================== */

/**
 * Notifica cancelamento de reserva (solicitado pelo próprio usuário ou pela administração).
 */
export async function notifyReservationCancelled(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<Reservation, 'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'>,
  cancelledBy: 'USUARIO' | 'ADMIN',
  reason?: string
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'RESERVATION_CANCELLED',
      timestamp: Date.now(),
    };
  }

  const dataBR = formatDataBR(reservation.data);
  const originLabel =
    cancelledBy === 'ADMIN'
      ? 'pela Coordenação / Administração'
      : 'por solicitação no seu perfil';

  const message = [
    `*TechReserve — Reserva Cancelada*`,
    `Olá, *${user.nome}*. Informamos que sua reserva foi cancelada ${originLabel}.`,
    ``,
    `• *Ambiente:* ${reservation.salaNome} (${reservation.salaInstitutionalId})`,
    `• *Data:* ${dataBR}`,
    `• *Horário:* ${reservation.inicio} às ${reservation.fim}`,
    ...(reason ? [`• *Observação:* ${reason}`] : []),
    ``,
    `O espaço já se encontra liberado para outros agendamentos acadêmicos.`,
  ].join('\n');

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'RESERVATION_CANCELLED',
    metadata: {
      reservationId: reservation.id,
      cancelledBy,
      reason: reason || null,
    },
  });

  await registerWhatsAppLog(
    user,
    'RESERVATION_CANCELLED',
    `Aviso de cancelamento (${cancelledBy}) em ${reservation.salaNome}`,
    result
  );

  return result;
}

/**
 * Envia um alerta de validação imediata a pedido do usuário na tela de Configurações / Edição de Perfil.
 */
export async function sendTestWhatsAppAlert(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'whatsappNotificationsEnabled'>
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'WHATSAPP_TEST_ALERT',
      timestamp: Date.now(),
    };
  }

  const message = [
    `*TechReserve — Validação de Alertas WhatsApp*`,
    `Olá, *${user.nome}*! Seu número *${formatPhoneMask(user.phone)}* está configurado e apto a receber:`,
    `• Confirmações e cancelamentos de reservas;`,
    `• Lembretes prévios de início de aula/uso;`,
    `• Alertas de desocupação faltando 10 minutos;`,
    `• Avisos de expiração de check-in (No-Show).`,
  ].join('\n');

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'WHATSAPP_TEST_ALERT',
    metadata: { userId: user.id },
  });

  await registerWhatsAppLog(
    user,
    'WHATSAPP_TEST_ALERT',
    `Disparo de validação de WhatsApp solicitado pelo perfil`,
    result
  );

  return result;
}
