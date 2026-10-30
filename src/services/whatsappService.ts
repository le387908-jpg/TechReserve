/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Reservation,
  User,
  WhatsAppDispatchResult,
  WhatsAppEventType,
  WhatsAppGatewayConnectResult,
  WhatsAppGatewayStatus,
  WhatsAppSendPayload,
} from '../types';
import { formatDataBR } from '../utils/dateUtils';
import { formatPhoneMask, toWhatsAppApiPhone } from '../utils/phoneUtils';
import { useLogStore } from '../store/useLogStore';
import { useAdminSettingsStore } from '../store/useAdminSettingsStore';
import {
  calculateCheckInDeadline,
  CHECKIN_TOLERANCE_MINUTES,
  WHATSAPP_TEMPLATES,
} from './whatsappTemplates';

export { calculateCheckInDeadline, CHECKIN_TOLERANCE_MINUTES, WHATSAPP_TEMPLATES };
export type {
  CancellationTemplateVars,
  ConfirmationTemplateVars,
  ManualBlockTemplateVars,
  NoShowTemplateVars,
  ReminderTemplateVars,
  TestAlertTemplateVars,
  VacateWarningTemplateVars,
} from './whatsappTemplates';

/**
 * Configuração da integração WhatsApp (Evolution API / Meta Cloud / Webhook).
 *
 * Arquitetura:
 * - As requisições `POST` são enviadas para `/api/whatsapp/send` (rota server-side Express / Vercel),
 *   que encaminha para `/message/sendText/{instance}` na Evolution API mantendo `WHATSAPP_API_TOKEN` protegido no servidor.
 * - Caso o ambiente seja estático sem `/api/whatsapp/send` e `VITE_WHATSAPP_API_URL` esteja preenchida,
 *   realiza fallback direto para `${VITE_WHATSAPP_API_URL}/message/sendText/${instance}`.
 */
const viteEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env || {};

function sanitizeClientUrl(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = String(raw).trim().replace(/^['"`]+|['"`]+$/g, '');
  const match = trimmed.match(/https?:\/\/[^\s\]"')]+/i);
  return (match ? match[0] : trimmed).replace(/\/+$/, '');
}

const ENV_DIRECT_API_URL = sanitizeClientUrl(viteEnv.VITE_WHATSAPP_API_URL);
const ENV_PROXY_ENDPOINT = String(
  viteEnv.VITE_WHATSAPP_PROXY_URL || '/api/whatsapp/send'
).trim();
const ENV_PROVIDER = String(viteEnv.VITE_WHATSAPP_PROVIDER || 'EVOLUTION')
  .trim()
  .toUpperCase();
const ENV_DEFAULT_INSTANCE = String(viteEnv.VITE_WHATSAPP_INSTANCE || 'techreserve')
  .trim()
  .replace(/[^a-zA-Z0-9_-]/g, '') || 'techreserve';

// Tolerância de 50s para absorver eventual cold-start do provedor externo (ex.: Render)
const REQUEST_TIMEOUT_MS = 50000;

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
 * Obtém o nome da instância Evolution API salva no Firestore (`settings/whatsapp_integration`)
 * ou definida nas variáveis de ambiente.
 */
function getConfiguredInstanceName(explicitInstance?: string): string {
  if (explicitInstance && explicitInstance.trim()) {
    return explicitInstance.trim().replace(/[^a-zA-Z0-9_-]/g, '') || ENV_DEFAULT_INSTANCE;
  }
  const storeInstance = useAdminSettingsStore.getState().whatsappIntegration?.instanceName;
  if (storeInstance && storeInstance.trim()) {
    return storeInstance.trim().replace(/[^a-zA-Z0-9_-]/g, '') || ENV_DEFAULT_INSTANCE;
  }
  return ENV_DEFAULT_INSTANCE;
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
      options: {
        delay: 300,
        presence: 'composing',
        linkPreview: false,
      },
      textMessage: {
        text: message,
      },
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
 * Consulta o status operacional do Gateway WhatsApp no backend (`/api/whatsapp/status`).
 */
export async function getWhatsAppGatewayStatus(
  instanceName?: string
): Promise<WhatsAppGatewayStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const resolvedInstance = getConfiguredInstanceName(instanceName);

  try {
    const query = resolvedInstance ? `?instance=${encodeURIComponent(resolvedInstance)}` : '';
    const res = await fetch(`/api/whatsapp/status${query}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      return {
        configured: Boolean(ENV_DIRECT_API_URL),
        provider: 'EVOLUTION',
        connected: false,
        state: ENV_DIRECT_API_URL ? 'ready' : 'unconfigured',
        instanceName: resolvedInstance,
        message: 'Serviço de status WhatsApp indisponível.',
      };
    }

    return (await res.json()) as WhatsAppGatewayStatus;
  } catch {
    return {
      configured: Boolean(ENV_DIRECT_API_URL),
      provider: 'EVOLUTION',
      connected: false,
      state: 'close',
      instanceName: resolvedInstance,
      message: 'Não foi possível verificar o status do Gateway WhatsApp no momento.',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Solicita a conexão da instância WhatsApp institucional e geração de QR Code / Código de Pareamento (`/api/whatsapp/connect`).
 */
export async function connectWhatsAppGateway(options?: {
  phone?: string;
  forceRecreate?: boolean;
  instanceName?: string;
}): Promise<WhatsAppGatewayConnectResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const resolvedInstance = getConfiguredInstanceName(options?.instanceName);

  try {
    const res = await fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ...(options || {}),
        instanceName: resolvedInstance,
      }),
      signal: controller.signal,
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        success: false,
        connected: false,
        state: 'close',
        instanceName: resolvedInstance,
        error: 'Rota /api/whatsapp/connect indisponível neste ambiente.',
      };
    }

    return (await res.json()) as WhatsAppGatewayConnectResult;
  } catch (err) {
    return {
      success: false,
      connected: false,
      state: 'close',
      instanceName: resolvedInstance,
      error:
        err instanceof Error
          ? err.message
          : 'Tempo limite ou erro de rede ao gerar QR Code do WhatsApp.',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Desconecta a sessão atual do WhatsApp institucional (`/api/whatsapp/disconnect`).
 */
export async function disconnectWhatsAppGateway(
  instanceName?: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const resolvedInstance = getConfiguredInstanceName(instanceName);
  try {
    const res = await fetch('/api/whatsapp/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ instanceName: resolvedInstance }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      success: Boolean(res.ok && data?.success !== false),
      message: data?.message || 'Sessão desconectada.',
    };
  } catch {
    return {
      success: false,
      message: 'Não foi possível desconectar a sessão no momento.',
    };
  }
}

/**
 * Verifica se o usuário possui número válido cadastrado e optou por receber alertas via WhatsApp,
 * formatando o número estritamente como `55 + DDD + Número` sem caracteres especiais.
 */
export function canReceiveWhatsAppAlerts(
  user:
    | Pick<User, 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>
    | null
    | undefined
): { allowed: boolean; apiNumber: string; reason?: string } {
  if (!user) {
    console.warn('[WhatsApp] Envio ignorado: usuário de destino não identificado.');
    return { allowed: false, apiNumber: '', reason: 'Usuário não identificado.' };
  }

  if (user.whatsappNotificationsEnabled === false) {
    console.log('[WhatsApp] Envio ignorado: notificações desativadas nas preferências do usuário.');
    return {
      allowed: false,
      apiNumber: '',
      reason: 'Notificações via WhatsApp desativadas nas preferências do usuário.',
    };
  }

  const candidatePhone = user.phone || user.phoneFormatted || '';
  const apiNumber = toWhatsAppApiPhone(candidatePhone);

  if (!apiNumber || apiNumber.length < 12) {
    console.warn('[WhatsApp] Envio ignorado: telefone ausente ou inválido no perfil do usuário.', {
      rawPhone: candidatePhone,
      formattedAttempt: apiNumber,
    });
    return {
      allowed: false,
      apiNumber: '',
      reason: 'Número de WhatsApp ausente ou inválido no perfil do usuário.',
    };
  }

  return {
    allowed: true,
    apiNumber,
  };
}

/**
 * Envia mensagem de WhatsApp via Evolution API (`/message/sendText/{instance}`) através da rota `/api/whatsapp/send`
 * (ou diretamente via `VITE_WHATSAPP_API_URL` caso em hospedagem estática).
 * Garante formatação DDI + DDD sem caracteres especiais (ex.: `55119XXXXXXXX`) e registra logs detalhados no console.
 */
export async function sendWhatsAppMessage(
  payload: WhatsAppSendPayload,
  customEndpoint?: string
): Promise<WhatsAppDispatchResult> {
  const timestamp = Date.now();
  const apiPhone = toWhatsAppApiPhone(payload.phone);
  const instanceName = getConfiguredInstanceName(payload.instanceName);

  if (!apiPhone || apiPhone.length < 12 || /\D/.test(apiPhone)) {
    console.error('[WhatsApp][Erro de Formatação] Número de destino inválido para envio:', {
      eventType: payload.eventType,
      rawPhone: payload.phone,
      sanitizedApiPhone: apiPhone,
    });
    return {
      success: false,
      skipped: true,
      reason: 'Número de telefone inválido para envio (esperado DDI+DDD+Número apenas com dígitos).',
      eventType: payload.eventType,
      timestamp,
    };
  }

  const targetEndpoint = customEndpoint || ENV_PROXY_ENDPOINT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  console.log('[WhatsApp][Envio Iniciado]', {
    eventType: payload.eventType,
    to: apiPhone,
    instance: instanceName,
    proxyEndpoint: targetEndpoint,
    evolutionTargetPath: `/message/sendText/${instanceName}`,
  });

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: apiPhone,
        message: payload.message,
        eventType: payload.eventType,
        instanceName,
        metadata: payload.metadata || {},
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const isHtmlFallback = !contentType.includes('application/json');

    // Fallback direto para `${VITE_WHATSAPP_API_URL}/message/sendText/${instanceName}` em hospedagem puramente estática
    if ((response.status === 404 || isHtmlFallback) && !customEndpoint && ENV_DIRECT_API_URL) {
      clearTimeout(timeoutId);
      const directController = new AbortController();
      const directTimeout = setTimeout(() => directController.abort(), REQUEST_TIMEOUT_MS);

      try {
        const cleanBase = ENV_DIRECT_API_URL.replace(/\/(manager|docs|swagger)\/?$/i, '');
        const directEndpoint =
          ENV_PROVIDER === 'EVOLUTION' && !/\/message\/sendText\//i.test(cleanBase)
            ? `${cleanBase}/message/sendText/${encodeURIComponent(instanceName)}`
            : cleanBase;

        console.log('[WhatsApp][Fallback Direto Evolution API]', {
          eventType: payload.eventType,
          to: apiPhone,
          endpoint: directEndpoint,
        });

        const directResponse = await fetch(directEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildDirectProviderBody(apiPhone, payload.message, payload.eventType, payload.metadata)
          ),
          signal: directController.signal,
        });

        const directText = await directResponse.text().catch(() => '');
        clearTimeout(directTimeout);

        if (!directResponse.ok) {
          console.error('[WhatsApp][Erro Fallback Direto Evolution API]', {
            eventType: payload.eventType,
            to: apiPhone,
            endpoint: directEndpoint,
            httpStatus: directResponse.status,
            responseBody: directText.slice(0, 400),
          });
          return {
            success: false,
            delivered: false,
            upstreamStatus: directResponse.status,
            endpoint: directEndpoint,
            details: directText.slice(0, 400),
            reason: `Falha HTTP ${directResponse.status} ao enviar mensagem para a Evolution API.`,
            to: apiPhone,
            instanceName,
            eventType: payload.eventType,
            timestamp,
          };
        }

        console.log('[WhatsApp][Envio Concluído via Endpoint Direto]', {
          eventType: payload.eventType,
          to: apiPhone,
          endpoint: directEndpoint,
        });

        return {
          success: true,
          delivered: true,
          mode: 'DIRECT_ENV_URL',
          endpoint: directEndpoint,
          to: apiPhone,
          instanceName,
          eventType: payload.eventType,
          timestamp,
        };
      } finally {
        clearTimeout(directTimeout);
      }
    }

    if (isHtmlFallback) {
      console.error('[WhatsApp][Erro de Rota] /api/whatsapp/send retornou HTML em vez de JSON:', {
        httpStatus: response.status,
        targetEndpoint,
      });
      return {
        success: false,
        delivered: false,
        reason: 'Serviço de envio WhatsApp (/api/whatsapp/send) indisponível neste ambiente.',
        to: apiPhone,
        instanceName,
        eventType: payload.eventType,
        timestamp,
      };
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.success === false) {
      const errorReason =
        data?.error || `Falha HTTP ${response.status} ao comunicar com a Evolution API.`;

      console.error('[WhatsApp][Erro na Resposta da API]', {
        eventType: payload.eventType,
        to: apiPhone,
        instance: data?.instanceName || instanceName,
        proxyHttpStatus: response.status,
        evolutionHttpStatus: data?.status,
        evolutionEndpoint: data?.endpoint || `/message/sendText/${instanceName}`,
        error: errorReason,
        details: data?.details || null,
      });

      return {
        success: false,
        delivered: false,
        needsQrConnection: Boolean(data?.needsQrConnection),
        upstreamStatus: typeof data?.status === 'number' ? data.status : response.status,
        endpoint: data?.endpoint,
        details: data?.details,
        instanceName: data?.instanceName || instanceName,
        reason: errorReason,
        to: apiPhone,
        eventType: payload.eventType,
        timestamp,
      };
    }

    console.log('[WhatsApp][Envio Concluído]', {
      eventType: payload.eventType,
      to: data?.to || apiPhone,
      instance: data?.instanceName || instanceName,
      delivered: Boolean(data?.delivered),
      mode: data?.mode || 'LIVE_EVOLUTION',
      endpoint: data?.endpoint || `/message/sendText/${instanceName}`,
    });

    return {
      success: true,
      delivered: Boolean(data?.delivered),
      mode: data?.mode || 'LIVE_EVOLUTION',
      endpoint: data?.endpoint,
      instanceName: data?.instanceName || instanceName,
      to: data?.to || apiPhone,
      eventType: payload.eventType,
      timestamp,
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    const reason = isAbort
      ? 'O servidor de WhatsApp demorou para responder (iniciando instância). Aguarde alguns segundos e tente novamente.'
      : error instanceof Error
      ? error.message
      : 'Falha de rede no envio WhatsApp.';

    console.error('[WhatsApp][Exceção no Envio]', {
      eventType: payload.eventType,
      to: apiPhone,
      instance: instanceName,
      targetEndpoint,
      error: reason,
    });

    return {
      success: false,
      delivered: false,
      reason,
      to: apiPhone,
      instanceName,
      eventType: payload.eventType,
      timestamp,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Alias semântico de disparo de notificação WhatsApp para uso direto em fluxos de reserva.
 */
export const triggerNotification = sendWhatsAppMessage;

/**
 * Registra trilha auditável do disparo WhatsApp na coleção `logs` do Firestore.
 */
async function registerWhatsAppLog(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted'>,
  eventType: WhatsAppEventType,
  summary: string,
  result: WhatsAppDispatchResult
): Promise<void> {
  try {
    const maskedPhone = formatPhoneMask(user.phone || user.phoneFormatted) || 'Sem número';
    await useLogStore.getState().addLog({
      acao: `WHATSAPP_${eventType}`,
      usuarioId: user.id,
      usuarioNome: user.nome || 'Usuário',
      entidade: 'WHATSAPP',
      detalhes: `${summary} · Destino: ${maskedPhone} (${result.to || 'N/A'}) · Status: ${
        result.delivered
          ? `Entregue (${result.instanceName || 'Evolution API'})`
          : result.success
          ? 'Registrado (Homologação)'
          : `Falha (${result.reason || 'erro'})`
      }`.slice(0, 800),
    });
  } catch {
    // Falha secundária de auditoria não interrompe o fluxo principal da reserva
  }
}

/* ============================================================================
 * 1. CONFIRMAÇÃO DE RESERVA
 * ========================================================================== */

export async function sendReservationConfirmation(
  input: DirectReservationAlertInput
): Promise<WhatsAppDispatchResult> {
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const timeSlot = `${input.startTime} às ${input.endTime}`;
  const checkInDeadline = calculateCheckInDeadline(input.startTime);

  const message = WHATSAPP_TEMPLATES.RESERVATION_CONFIRMED({
    userName: input.userName,
    roomName: input.roomName,
    roomCode: input.roomCode,
    date: formattedDate,
    timeSlot,
    startTime: input.startTime,
    endTime: input.endTime,
    checkInDeadline,
    isAdmin: input.isAdmin,
  });

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_CONFIRMED',
    metadata: {
      reservationId: input.reservationId || null,
      userName: input.userName,
      roomName: input.roomName,
      room: input.roomCode || input.roomName,
      date: formattedDate,
      timeSlot,
      start: input.startTime,
      end: input.endTime,
      checkInDeadline,
    },
  });
}

export async function notifyReservationConfirmed(
  user: Pick<
    User,
    'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled' | 'role'
  >,
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
 * 2. LEMBRETES DE RESERVA (10 MIN ANTES DO INÍCIO E DESOCUPAÇÃO 10 MIN ANTES DO FIM)
 * ========================================================================== */

export async function sendReservationReminder(
  input: DirectReservationAlertInput & { minutesBefore?: number }
): Promise<WhatsAppDispatchResult> {
  const minutesBefore = input.minutesBefore ?? 10;
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const timeSlot = `${input.startTime} às ${input.endTime}`;
  const checkInDeadline = calculateCheckInDeadline(input.startTime);

  const message = WHATSAPP_TEMPLATES.RESERVATION_REMINDER({
    userName: input.userName,
    roomName: input.roomName,
    roomCode: input.roomCode,
    date: formattedDate,
    timeSlot,
    startTime: input.startTime,
    endTime: input.endTime,
    checkInDeadline,
    minutesBefore,
    isAdmin: input.isAdmin,
  });

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_REMINDER_START',
    metadata: {
      reservationId: input.reservationId || null,
      userName: input.userName,
      roomName: input.roomName,
      date: formattedDate,
      timeSlot,
      checkInDeadline,
      minutesBefore,
    },
  });
}

export async function notifyUpcomingReservationReminder(
  user: Pick<
    User,
    'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled' | 'role'
  >,
  reservation: Pick<
    Reservation,
    'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'
  >,
  minutesBefore = 10
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
    `Lembrete prévio (${minutesBefore} min) enviado para ${reservation.salaNome} (${reservation.inicio})`,
    result
  );

  return result;
}

export async function notifyVacateWarning10Min(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<
    Reservation,
    'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'
  >
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

  const formattedDate = formatDataBR(reservation.data);
  const timeSlot = `${reservation.inicio} às ${reservation.fim}`;

  const message = WHATSAPP_TEMPLATES.VACATE_WARNING_10MIN({
    userName: user.nome,
    roomName: reservation.salaNome,
    roomCode: reservation.salaInstitutionalId,
    date: formattedDate,
    timeSlot,
    endTime: reservation.fim,
  });

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'RESERVATION_VACATE_10MIN',
    metadata: {
      reservationId: reservation.id,
      userName: user.nome,
      roomName: reservation.salaNome,
      room: reservation.salaInstitutionalId,
      date: formattedDate,
      timeSlot,
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
 * 3. ALERTA DE NO-SHOW E RESTRIÇÃO DISCIPLINAR DE DIA ÚNICO
 * ========================================================================== */

export async function sendNoShowAlert(
  input: DirectReservationAlertInput
): Promise<WhatsAppDispatchResult> {
  const formattedDate = input.date.includes('-') ? formatDataBR(input.date) : input.date;
  const timeSlot = `${input.startTime} às ${input.endTime}`;
  const checkInDeadline = calculateCheckInDeadline(input.startTime);

  const message = WHATSAPP_TEMPLATES.RESERVATION_NO_SHOW({
    userName: input.userName,
    roomName: input.roomName,
    roomCode: input.roomCode,
    date: formattedDate,
    timeSlot,
    startTime: input.startTime,
    endTime: input.endTime,
    checkInDeadline,
  });

  return sendWhatsAppMessage({
    phone: input.phone,
    message,
    eventType: 'RESERVATION_NO_SHOW',
    metadata: {
      reservationId: input.reservationId || null,
      userName: input.userName,
      roomName: input.roomName,
      room: input.roomCode || input.roomName,
      date: formattedDate,
      timeSlot,
      start: input.startTime,
      checkInDeadline,
    },
  });
}

export async function notifyNoShowAutoCancelled(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<
    Reservation,
    'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'
  >
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

export async function notifyManualPunishmentApplied(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>,
  blockedDateISO: string,
  reason: string
): Promise<WhatsAppDispatchResult> {
  const eligibility = canReceiveWhatsAppAlerts(user);
  if (!eligibility.allowed) {
    return {
      success: false,
      skipped: true,
      reason: eligibility.reason,
      eventType: 'PUNISHMENT_APPLIED',
      timestamp: Date.now(),
    };
  }

  const formattedDate = formatDataBR(blockedDateISO);
  const message = WHATSAPP_TEMPLATES.PUNISHMENT_APPLIED({
    userName: user.nome,
    blockedDate: formattedDate,
    reason,
  });

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'PUNISHMENT_APPLIED',
    metadata: {
      userId: user.id,
      userName: user.nome,
      blockedDate: formattedDate,
    },
  });

  await registerWhatsAppLog(
    user,
    'PUNISHMENT_APPLIED',
    `Aviso de restrição pontual para ${formattedDate}`,
    result
  );

  return result;
}

/* ============================================================================
 * 4. CANCELAMENTO E VALIDAÇÃO DE CONEXÃO
 * ========================================================================== */

export async function notifyReservationCancelled(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>,
  reservation: Pick<
    Reservation,
    'id' | 'salaNome' | 'salaInstitutionalId' | 'data' | 'inicio' | 'fim'
  >,
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
  const timeSlot = `${reservation.inicio} às ${reservation.fim}`;

  const message = WHATSAPP_TEMPLATES.RESERVATION_CANCELLED({
    userName: user.nome,
    roomName: reservation.salaNome,
    roomCode: reservation.salaInstitutionalId,
    date: dataBR,
    timeSlot,
    cancelledBy,
    reason,
  });

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'RESERVATION_CANCELLED',
    metadata: {
      reservationId: reservation.id,
      userName: user.nome,
      roomName: reservation.salaNome,
      date: dataBR,
      timeSlot,
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

export async function sendTestWhatsAppAlert(
  user: Pick<User, 'id' | 'nome' | 'phone' | 'phoneFormatted' | 'whatsappNotificationsEnabled'>
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

  const displayPhone = formatPhoneMask(user.phone || user.phoneFormatted);

  const message = WHATSAPP_TEMPLATES.WHATSAPP_TEST_ALERT({
    userName: user.nome,
    displayPhone,
  });

  const result = await sendWhatsAppMessage({
    phone: eligibility.apiNumber,
    message,
    eventType: 'WHATSAPP_TEST_ALERT',
    metadata: { userId: user.id, userName: user.nome },
  });

  await registerWhatsAppLog(
    user,
    'WHATSAPP_TEST_ALERT',
    `Disparo de validação de WhatsApp solicitado pelo perfil`,
    result
  );

  return result;
}
