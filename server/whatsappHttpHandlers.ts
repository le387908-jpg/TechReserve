/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  ApiAuthError,
  authenticateApiRequest,
  writeServerAuditLog,
} from './firebaseAdmin';
import { checkRateLimit, extractClientIp } from './rateLimiter';
import {
  connectGatewayInstance,
  disconnectGatewayInstance,
  dispatchWhatsAppMessage,
  getGatewayStatus,
} from './whatsappGateway';

const InstanceNameSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[a-zA-Z0-9_-]*$/, 'Nome de instância inválido.')
  .optional();

const ConnectBodySchema = z.object({
  phone: z.string().trim().max(24).optional(),
  forceRecreate: z.boolean().optional().default(false),
  instanceName: InstanceNameSchema,
});

const DisconnectBodySchema = z.object({
  instanceName: InstanceNameSchema,
});

const SendBodySchema = z.object({
  to: z
    .string()
    .trim()
    .min(10, 'Número de destino inválido.')
    .max(20, 'Número de destino inválido.')
    .regex(/^\+?\d{10,19}$/, 'Formato de telefone inválido.'),
  message: z
    .string()
    .trim()
    .min(1, 'Mensagem vazia.')
    .max(4096, 'Mensagem excede o limite máximo permitido (4096 caracteres).'),
  eventType: z
    .enum([
      'RESERVATION_CONFIRMED',
      'RESERVATION_CANCELLED',
      'RESERVATION_REMINDER_START',
      'RESERVATION_VACATE_10MIN',
      'RESERVATION_NO_SHOW',
      'PUNISHMENT_APPLIED',
      'WHATSAPP_TEST_ALERT',
    ])
    .optional(),
  instanceName: InstanceNameSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function parseJsonBody(rawBody: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
  if (!rawBody) return { ok: true, data: {} };
  if (typeof rawBody === 'string') {
    if (!rawBody.trim()) return { ok: true, data: {} };
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === 'object' ? { ok: true, data: parsed } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (typeof rawBody === 'object') {
    return { ok: true, data: rawBody as Record<string, unknown> };
  }
  return { ok: false };
}

function normalizeComparableDigits(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
}

export async function handleProtectedWhatsAppStatus(req: any, res: any): Promise<void> {
  const ip = extractClientIp(req);
  try {
    const authUser = await authenticateApiRequest(req);
    const rl = checkRateLimit({
      scope: 'wa_status',
      identifier: `${authUser.uid}:${ip}`,
      maxRequests: 60,
      windowMs: 60 * 1000,
    });
    if (!rl.allowed) {
      res.setHeader?.('Retry-After', String(rl.retryAfterSeconds));
      res.status(429).json({
        configured: false,
        provider: 'EVOLUTION',
        connected: false,
        state: 'close',
        instanceName: 'techreserve',
        message: 'Limite de consultas excedido. Aguarde alguns segundos.',
      });
      return;
    }

    const rawInstance =
      typeof req.query?.instance === 'string' ? req.query.instance : undefined;
    const parsedInstance = InstanceNameSchema.safeParse(rawInstance);
    if (!parsedInstance.success) {
      res.status(400).json({ error: 'Parâmetro instance inválido.' });
      return;
    }

    const status = await getGatewayStatus(parsedInstance.data);

    // Oculta metadados operacionais sensíveis para usuários não administradores
    if (!authUser.isAdmin) {
      res.status(200).json({
        configured: status.configured,
        provider: status.provider,
        connected: status.connected,
        state: status.state,
        instanceName: status.instanceName,
      });
      return;
    }

    res.status(200).json(status);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error('[WhatsAppAPI] Erro em GET /api/whatsapp/status:', err);
    res.status(500).json({
      configured: false,
      provider: 'EVOLUTION',
      connected: false,
      state: 'close',
      instanceName: 'techreserve',
      message: 'Erro interno ao consultar status do WhatsApp.',
    });
  }
}

export async function handleProtectedWhatsAppConnect(req: any, res: any): Promise<void> {
  const ip = extractClientIp(req);
  try {
    const authUser = await authenticateApiRequest(req, { requireAdmin: true });
    const rl = checkRateLimit({
      scope: 'wa_connect',
      identifier: `${authUser.uid}:${ip}`,
      maxRequests: 10,
      windowMs: 60 * 1000,
    });
    if (!rl.allowed) {
      res.setHeader?.('Retry-After', String(rl.retryAfterSeconds));
      res.status(429).json({
        success: false,
        connected: false,
        state: 'close',
        instanceName: 'techreserve',
        error: `Muitas solicitações de conexão. Aguarde ${rl.retryAfterSeconds}s.`,
      });
      return;
    }

    const bodyResult = parseJsonBody(req.body);
    if (!bodyResult.ok) {
      res.status(400).json({ success: false, error: 'Payload JSON inválido.' });
      return;
    }

    const parsed = ConnectBodySchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.issues[0]?.message || 'Parâmetros inválidos.',
      });
      return;
    }

    const result = await connectGatewayInstance({
      phone: parsed.data.phone,
      forceRecreate: parsed.data.forceRecreate,
      instanceName: parsed.data.instanceName,
    });

    await writeServerAuditLog({
      acao: 'WHATSAPP_GATEWAY_CONNECT',
      actorUid: authUser.uid,
      actorName: authUser.nome,
      entidade: 'WHATSAPP',
      detalhes: `Solicitação administrativa de conexão/pareamento da instância "${result.instanceName}" (estado: ${result.state}).`,
      idToken: authUser.idToken,
    });

    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      res.status(err.statusCode).json({
        success: false,
        connected: false,
        state: 'close',
        error: err.message,
      });
      return;
    }
    console.error('[WhatsAppAPI] Erro em POST /api/whatsapp/connect:', err);
    res.status(500).json({
      success: false,
      connected: false,
      state: 'close',
      error: 'Erro interno ao processar conexão do WhatsApp.',
    });
  }
}

export async function handleProtectedWhatsAppDisconnect(req: any, res: any): Promise<void> {
  const ip = extractClientIp(req);
  try {
    const authUser = await authenticateApiRequest(req, { requireAdmin: true });
    const rl = checkRateLimit({
      scope: 'wa_disconnect',
      identifier: `${authUser.uid}:${ip}`,
      maxRequests: 8,
      windowMs: 60 * 1000,
    });
    if (!rl.allowed) {
      res.setHeader?.('Retry-After', String(rl.retryAfterSeconds));
      res.status(429).json({
        success: false,
        message: `Muitas solicitações. Aguarde ${rl.retryAfterSeconds}s.`,
      });
      return;
    }

    const bodyResult = parseJsonBody(req.body);
    if (!bodyResult.ok) {
      res.status(400).json({ success: false, message: 'Payload JSON inválido.' });
      return;
    }

    const parsed = DisconnectBodySchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Parâmetros inválidos.',
      });
      return;
    }

    const result = await disconnectGatewayInstance(parsed.data.instanceName);

    await writeServerAuditLog({
      acao: 'WHATSAPP_GATEWAY_DISCONNECT',
      actorUid: authUser.uid,
      actorName: authUser.nome,
      entidade: 'WHATSAPP',
      detalhes: `Sessão da instância WhatsApp "${parsed.data.instanceName || 'techreserve'}" desconectada pelo ADM.`,
      idToken: authUser.idToken,
    });

    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      res.status(err.statusCode).json({
        success: false,
        message: err.message,
      });
      return;
    }
    console.error('[WhatsAppAPI] Erro em POST /api/whatsapp/disconnect:', err);
    res.status(500).json({
      success: false,
      message: 'Erro interno ao desconectar sessão do WhatsApp.',
    });
  }
}

export async function handleProtectedWhatsAppSend(req: any, res: any): Promise<void> {
  const ip = extractClientIp(req);
  try {
    const authUser = await authenticateApiRequest(req);
    const rl = checkRateLimit({
      scope: 'wa_send',
      identifier: `${authUser.uid}:${ip}`,
      maxRequests: authUser.isAdmin ? 45 : 12,
      windowMs: 60 * 1000,
    });
    if (!rl.allowed) {
      res.setHeader?.('Retry-After', String(rl.retryAfterSeconds));
      res.status(429).json({
        success: false,
        delivered: false,
        error: `Limite de envios atingido. Aguarde ${rl.retryAfterSeconds}s.`,
      });
      return;
    }

    const bodyResult = parseJsonBody(req.body);
    if (!bodyResult.ok) {
      res.status(400).json({
        success: false,
        delivered: false,
        error: 'Payload JSON inválido.',
      });
      return;
    }

    const parsed = SendBodySchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        delivered: false,
        error: parsed.error.issues[0]?.message || 'Parâmetros de mensagem inválidos.',
      });
      return;
    }

    // Impede que usuários não-ADM utilizem a rota para disparar mensagens para números de terceiros
    if (!authUser.isAdmin) {
      if (parsed.data.eventType === 'PUNISHMENT_APPLIED') {
        res.status(403).json({
          success: false,
          delivered: false,
          error: 'Evento exclusivo da Coordenação.',
        });
        return;
      }

      const targetComparable = normalizeComparableDigits(parsed.data.to);
      const ownComparable = normalizeComparableDigits(authUser.phone);

      if (!ownComparable || targetComparable !== ownComparable) {
        res.status(403).json({
          success: false,
          delivered: false,
          error: 'Usuários só podem receber notificações no próprio telefone cadastrado no perfil.',
        });
        return;
      }
    }

    const { httpStatus, payload } = await dispatchWhatsAppMessage({
      to: parsed.data.to,
      message: parsed.data.message,
      eventType: parsed.data.eventType,
      instanceName: parsed.data.instanceName,
      metadata: parsed.data.metadata,
    });

    // Remove detalhes brutos internos de upstream para evitar vazamento de infraestrutura
    const safePayload = { ...payload };
    if (!authUser.isAdmin) {
      delete safePayload.endpoint;
      delete safePayload.details;
    }

    res.status(httpStatus).json(safePayload);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      res.status(err.statusCode).json({
        success: false,
        delivered: false,
        error: err.message,
      });
      return;
    }
    console.error('[WhatsAppAPI] Erro em POST /api/whatsapp/send:', err);
    res.status(500).json({
      success: false,
      delivered: false,
      error: 'Erro interno no serviço de envio do WhatsApp.',
    });
  }
}
