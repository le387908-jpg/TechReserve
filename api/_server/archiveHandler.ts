/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  ApiAuthError,
  authenticateApiRequest,
  getPrivilegedFirestore,
} from './firebaseAdmin.ts';
import { checkRateLimit, extractClientIp } from './rateLimiter.ts';
import { buildSlotLockId } from './expireHandler.ts';
import { parseSaoPauloDateTimeMs } from './checkInHandler.ts';

const ArchiveRequestSchema = z.object({
  reservationId: z.string().trim().min(1).max(128),
  justificativa: z.string().trim().max(500).optional(),
});

export interface ServerArchiveResponse {
  httpStatus: number;
  body: {
    success: boolean;
    code:
      | 'ARCHIVED_WITHOUT_PENALTY'
      | 'ALREADY_PROCESSED'
      | 'NOT_EXPIRED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED'
      | 'BAD_REQUEST'
      | 'SERVICE_UNAVAILABLE'
      | 'SERVER_ERROR';
    message: string;
    reservationId?: string;
  };
}

/**
 * Processa a regularização administrativa de uma reserva antiga pendente,
 * arquivando-a como CANCELADA sem aplicação de falta/punição ao usuário e sem envio de WhatsApp.
 *
 * Garante estritamente:
 * 1. Todas as leituras (tx.get) ocorrem antes de qualquer escrita (tx.update/tx.set/tx.delete).
 * 2. Rejeição explícita de datas/horários inválidos ou não finitos.
 * 3. Validação temporal no fuso America/Sao_Paulo (término < serverNow).
 * 4. Validação de titularidade de slot_locks (apenas o lock da própria reserva é removido).
 * 5. Auditoria transacional atômica comitada junto com a reserva.
 * 6. Desabilitação segura do modo REST sem transações atômicas para evitar alterações parciais.
 */
export async function processServerReservationArchive(req: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}): Promise<ServerArchiveResponse> {
  const clientIp = extractClientIp(req);
  const rateCheck = checkRateLimit({
    scope: 'reservations_archive',
    identifier: clientIp,
    maxRequests: 30,
    windowMs: 60 * 1000,
  });

  if (!rateCheck.allowed) {
    return {
      httpStatus: 429,
      body: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Muitas solicitações de regularização. Aguarde alguns instantes.',
      },
    };
  }

  // 1. Autenticação e RBAC (Exclusivo para ADMIN)
  let authUser;
  try {
    authUser = await authenticateApiRequest(req, { requireAdmin: true });
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return {
        httpStatus: err.statusCode || 401,
        body: {
          success: false,
          code: err.statusCode === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
          message: err.message,
        },
      };
    }
    return {
      httpStatus: 401,
      body: {
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Falha na autenticação da solicitação.',
      },
    };
  }

  if (!authUser.isAdmin) {
    return {
      httpStatus: 403,
      body: {
        success: false,
        code: 'FORBIDDEN',
        message: 'Operação exclusiva para administradores.',
      },
    };
  }

  // 2. Validação dos parâmetros
  const parsed = ArchiveRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'BAD_REQUEST',
        message: parsed.error.issues[0]?.message || 'Parâmetros inválidos.',
      },
    };
  }

  const { reservationId, justificativa } = parsed.data;
  const reasonText =
    justificativa?.trim() ||
    'Reserva regularizada administrativamente sem aplicação de falta.';

  const serverNow = Date.now();

  try {
    const adminDb = getPrivilegedFirestore();

    // 3. Rejeita o caminho REST sem transações atômicas para impedir alterações parciais
    if (!adminDb) {
      return {
        httpStatus: 503,
        body: {
          success: false,
          code: 'SERVICE_UNAVAILABLE',
          message:
            'A regularização administrativa requer ambiente transacional do Firebase Admin SDK indisponível no modo REST. Nenhuma alteração foi realizada.',
          reservationId,
        },
      };
    }

    // 4. Transação Atômica: TODAS as leituras antes de QUALQUER escrita
    await adminDb.runTransaction(async (tx) => {
      // --- ETAPA 1: TODAS AS LEITURAS ---
      const resRef = adminDb.collection('reservas').doc(reservationId);
      const resSnap = await tx.get(resRef);

      if (!resSnap.exists) {
        throw new Error('RESERVATION_NOT_FOUND');
      }

      const resData = resSnap.data() || {};
      const currentStatus = String(resData.status || '');

      if (currentStatus !== 'PENDENTE') {
        throw new Error(`ALREADY_PROCESSED:${currentStatus}`);
      }

      const resDataStr = String(resData.data || '').trim();
      const resFimStr = String(resData.fim || '').trim();
      const resInicioStr = String(resData.inicio || '').trim();
      const salaId = String(resData.salaId || '').trim();

      // Leitura do slot_lock ANTES de qualquer escrita
      const slotLockId = buildSlotLockId(salaId, resDataStr, resInicioStr, resFimStr);
      const lockRef = slotLockId ? adminDb.collection('slot_locks').doc(slotLockId) : null;
      const lockSnap = lockRef ? await tx.get(lockRef) : null;

      // --- ETAPA 2: TODAS AS VALIDAÇÕES ---
      // Validação Temporal Estrita no fuso America/Sao_Paulo:
      // Rejeita datas/horários ausentes, vazios, inválidos ou não finitos
      if (!resDataStr || !resFimStr) {
        throw new Error('INVALID_DATE_TIME');
      }

      const endMs = parseSaoPauloDateTimeMs(resDataStr, resFimStr);
      if (!Number.isFinite(endMs) || endMs <= 0) {
        throw new Error('INVALID_DATE_TIME');
      }

      // Rejeita reservas futuras ou vigentes (só permite arquivamento se término < serverNow)
      if (serverNow <= endMs) {
        throw new Error('NOT_EXPIRED');
      }

      // Validação de titularidade do slot_lock: só excluir se o lock ainda pertencer a esta reserva
      const shouldDeleteLock = Boolean(
        lockRef &&
        lockSnap &&
        lockSnap.exists &&
        lockSnap.data()?.reservaId === reservationId
      );

      // --- ETAPA 3: TODAS AS ESCRITAS (APENAS APÓS TODAS AS LEITURAS) ---
      // Escrita 1: Atualiza a reserva para CANCELADA (sem punição ao solicitante)
      tx.update(resRef, {
        status: 'CANCELADA',
        observacoes: reasonText,
        regularizacaoTipo: 'ARQUIVAMENTO_SEM_FALTA',
        regularizadoPorId: authUser.uid,
        regularizadoPorNome: authUser.nome || 'Administrador',
        regularizadoEm: serverNow,
        updatedAt: serverNow,
      });

      // Escrita 2: Libera o slot_locks associado exclusivamente se comprovada a titularidade
      if (shouldDeleteLock && lockRef) {
        tx.delete(lockRef);
      }

      // Escrita 3: Auditoria Transacional Atômica (comitada na mesma transação, sem duplicações)
      const logRef = adminDb.collection('logs').doc();
      tx.set(logRef, {
        acao: 'REGULARIZACAO_ARQUIVAR_SEM_FALTA',
        entidade: 'RESERVAS',
        reservaId: reservationId,
        usuarioId: authUser.uid,
        usuarioNome: authUser.nome || 'Administrador',
        dataHora: serverNow,
        timestamp: serverNow,
        createdAt: serverNow,
        justificativa: reasonText,
        punicaoAplicada: false,
        detalhes: `Reserva ${reservationId} em "${resData.salaNome || salaId}" (${resDataStr} ${resInicioStr}-${resFimStr}) arquivada administrativamente sem aplicação de falta por ${authUser.nome || 'Administrador'}. Justificativa: ${reasonText}`,
      });
    });

    return {
      httpStatus: 200,
      body: {
        success: true,
        code: 'ARCHIVED_WITHOUT_PENALTY',
        message: 'Reserva arquivada administrativamente sem aplicação de falta com sucesso.',
        reservationId,
      },
    };
  } catch (err: any) {
    if (err?.message === 'RESERVATION_NOT_FOUND') {
      return {
        httpStatus: 404,
        body: {
          success: false,
          code: 'NOT_FOUND',
          message: 'Reserva não encontrada para regularização.',
          reservationId,
        },
      };
    }
    if (err?.message === 'INVALID_DATE_TIME') {
      return {
        httpStatus: 400,
        body: {
          success: false,
          code: 'BAD_REQUEST',
          message:
            'A reserva possui data ou horário de término inválido ou não informado. Não é possível regularizar.',
          reservationId,
        },
      };
    }
    if (err?.message === 'NOT_EXPIRED') {
      return {
        httpStatus: 400,
        body: {
          success: false,
          code: 'NOT_EXPIRED',
          message:
            'Apenas reservas cujo horário de término já expirou podem ser regularizadas administrativamente. Para reservas vigentes ou futuras, utilize o fluxo regular de cancelamento.',
          reservationId,
        },
      };
    }
    if (err?.message?.startsWith('ALREADY_PROCESSED')) {
      const parts = err.message.split(':');
      return {
        httpStatus: 409,
        body: {
          success: false,
          code: 'ALREADY_PROCESSED',
          message: `A reserva já foi processada anteriormente (status: ${parts[1] || 'não pendente'}).`,
          reservationId,
        },
      };
    }
    console.error('[ArchiveHandler] Erro ao arquivar reserva:', err);
    return {
      httpStatus: 500,
      body: {
        success: false,
        code: 'SERVER_ERROR',
        message: 'Erro interno no servidor ao arquivar reserva.',
        reservationId,
      },
    };
  }
}
