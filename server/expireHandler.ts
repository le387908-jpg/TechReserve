/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  ApiAuthError,
  authenticateApiRequest,
  getPrivilegedFirestore,
  serverAtomicPatchDocument,
  serverGetDocument,
  serverQueryDocumentsByField,
  serverSetDocument,
  writeServerAuditLog,
} from './firebaseAdmin.ts';
import { checkRateLimit, extractClientIp } from './rateLimiter.ts';
import { getSaoPauloTodayISO, parseSaoPauloDateTimeMs } from './checkInHandler.ts';
import { dispatchWhatsAppMessage } from './whatsappGateway.ts';

const ExpireRequestSchema = z.object({
  reservationId: z.string().trim().min(1).max(128).optional(),
  allowPastDateReview: z.boolean().optional().default(false),
});

export const CHECKIN_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutos regulamentares

export function formatDataBR(isoDate: string): string {
  const clean = String(isoDate || '').trim();
  const parts = clean.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return clean;
}

export function formatNoShowTag(dateStr: string): string {
  return `[BLOQUEIO NO-SHOW: ${formatDataBR(dateStr)}]`;
}

export function calculateCheckInDeadline(startTime: string): string {
  const [h, m] = String(startTime || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return startTime;
  const totalMins = h * 60 + m + 5;
  const deadlineH = Math.floor(totalMins / 60) % 24;
  const deadlineM = totalMins % 60;
  return `${String(deadlineH).padStart(2, '0')}:${String(deadlineM).padStart(2, '0')}`;
}

export function buildSlotLockId(
  salaId: string,
  data: string,
  inicio: string,
  fim: string
): string {
  const cleanSala = String(salaId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanData = String(data || '').replace(/[^0-9-]/g, '');
  const cleanInicio = String(inicio || '').replace(/[^0-9]/g, '');
  const cleanFim = String(fim || '').replace(/[^0-9]/g, '');
  return `${cleanSala}_${cleanData}_${cleanInicio}_${cleanFim}`.slice(0, 128);
}

export function buildNoShowMessage(params: {
  userName: string;
  roomName: string;
  roomCode?: string;
  date: string;
  startTime: string;
  endTime: string;
  checkInDeadline: string;
}): string {
  const roomLabel =
    params.roomCode && params.roomCode !== params.roomName
      ? `${params.roomName} (${params.roomCode})`
      : params.roomName;
  const formattedDate = formatDataBR(params.date);
  const timeSlot = `${params.startTime} às ${params.endTime}`;

  return [
    `⚠️ *TechReserve — Alerta de No-Show / Bloqueio*`,
    ``,
    `Olá, *${params.userName}*.`,
    `❌ Sua ausência foi registrada porque o check-in via QR Code não foi realizado até as *${params.checkInDeadline}* (tolerância de *5 minutos*).`,
    ``,
    `📍 Sala/Laboratório liberada: *${roomLabel}*`,
    `📅 Data da ausência: *${formattedDate}*`,
    `⏰ Horário: *${timeSlot}*`,
    ``,
    `⚠️ *Status do Perfil:*`,
    `Você ficará *bloqueado para novos agendamentos na data ${formattedDate}*. Para outras datas da semana, sua cota permanece liberada normalmente.`,
  ].join('\n');
}

export interface ExpireResultDetail {
  reservationId: string;
  salaNome: string;
  usuarioId: string;
  data: string;
  status: 'PUNIDA' | 'SKIPPED' | 'REQUIRES_MANUAL_REVIEW';
  reason?: string;
  whatsappDelivered?: boolean;
}

export interface ServerExpireResponse {
  httpStatus: number;
  body: {
    success: boolean;
    code:
      | 'EXPIRED_SUCCESSFULLY'
      | 'ALREADY_PROCESSED'
      | 'ALREADY_CONFIRMED'
      | 'WITHIN_DEADLINE'
      | 'REQUIRES_MANUAL_REVIEW'
      | 'NO_EXPIRED_RESERVATIONS'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED'
      | 'BAD_REQUEST'
      | 'SERVER_ERROR';
    message: string;
    processedCount?: number;
    requiresReviewCount?: number;
    results?: ExpireResultDetail[];
  };
}

/**
 * Processa a expiração autoritativa de reservas vencidas no servidor.
 */
export async function processServerReservationExpiration(req: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}): Promise<ServerExpireResponse> {
  const clientIp = extractClientIp(req);
  const rateCheck = checkRateLimit({
    scope: 'reservations_expire',
    identifier: clientIp,
    maxRequests: 60,
    windowMs: 60 * 1000,
  });

  if (!rateCheck.allowed) {
    return {
      httpStatus: 429,
      body: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Muitas solicitações de reconciliação de reservas. Aguarde alguns instantes.',
      },
    };
  }

  // 1. Autenticação e RBAC
  let authUser;
  try {
    authUser = await authenticateApiRequest(req);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return {
        httpStatus: err.statusCode || 401,
        body: {
          success: false,
          code: 'UNAUTHORIZED',
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

  // 2. Validação do corpo da requisição
  const parsedBody = ExpireRequestSchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'BAD_REQUEST',
        message: parsedBody.error.issues[0]?.message || 'Parâmetros inválidos.',
      },
    };
  }

  const { reservationId, allowPastDateReview } = parsedBody.data;

  // Proteção de autorização: somente administradores podem ativar allowPastDateReview
  const effectiveAllowPastDateReview = Boolean(authUser.isAdmin && allowPastDateReview);

  // 3. Relógio e data oficial do servidor (America/Sao_Paulo)
  const serverNow = Date.now();
  const todayISO = getSaoPauloTodayISO(serverNow);

  // 4. Seleção das reservas elegíveis
  type ReservationCandidate = {
    id: string;
    data: Record<string, unknown>;
    updateTime?: string;
  };

  const candidates: ReservationCandidate[] = [];

  if (reservationId) {
    const docSnap = await serverGetDocument('reservas', reservationId, authUser.idToken);
    if (!docSnap.exists) {
      return {
        httpStatus: 404,
        body: {
          success: false,
          code: 'NOT_FOUND',
          message: 'Reserva não localizada no servidor.',
        },
      };
    }

    const ownerUid = String(docSnap.data.usuarioId || '');
    if (!authUser.isAdmin && ownerUid !== authUser.uid) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'FORBIDDEN',
          message: 'Você só pode processar a expiração da sua própria reserva.',
        },
      };
    }

    candidates.push({
      id: docSnap.id,
      data: docSnap.data,
      updateTime: docSnap.updateTime,
    });
  } else {
    // Busca no servidor:
    // Usuários comuns só reconciliam suas próprias reservas; admins podem reconciliar pendências globais
    const filters: Array<{ field: string; value: string | number | boolean }> = [
      { field: 'status', value: 'PENDENTE' },
    ];

    if (!authUser.isAdmin) {
      filters.push({ field: 'usuarioId', value: authUser.uid });
    }

    const fetchedDocs = await serverQueryDocumentsByField({
      collectionId: 'reservas',
      filters,
      limitCount: authUser.isAdmin ? 40 : 15,
      idToken: authUser.idToken,
    });

    for (const d of fetchedDocs) {
      candidates.push({
        id: d.id,
        data: d.data,
        updateTime: d.updateTime,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      httpStatus: 200,
      body: {
        success: true,
        code: 'NO_EXPIRED_RESERVATIONS',
        message: 'Nenhuma reserva pendente para expiração no momento.',
        processedCount: 0,
        requiresReviewCount: 0,
        results: [],
      },
    };
  }

  // 5. Avaliação e Processamento Atômico
  const processedResults: ExpireResultDetail[] = [];
  let processedCount = 0;
  let requiresReviewCount = 0;

  for (const candidate of candidates) {
    const resId = candidate.id;
    const resData = candidate.data;
    const currentStatus = String(resData.status || '');
    const resDateStr = String(resData.data || '').trim();
    const resInicioStr = String(resData.inicio || '').trim();
    const resFimStr = String(resData.fim || '').trim();
    const salaNome = String(resData.salaNome || 'Sala');
    const salaInstitutionalId = String(resData.salaInstitutionalId || '');
    const salaId = String(resData.salaId || '');
    const usuarioId = String(resData.usuarioId || '');

    // Idempotência: Se já não estiver PENDENTE
    if (currentStatus !== 'PENDENTE') {
      if (reservationId) {
        return {
          httpStatus: 200,
          body: {
            success: true,
            code: 'ALREADY_PROCESSED',
            message: `A reserva ${resId} já se encontra com status ${currentStatus}.`,
            processedCount: 0,
            requiresReviewCount: 0,
          },
        };
      }
      continue;
    }

    // Se já tiver check-in realizado
    if (resData.checkInRealizado === true) {
      if (reservationId) {
        return {
          httpStatus: 409,
          body: {
            success: false,
            code: 'ALREADY_CONFIRMED',
            message: 'A reserva possui check-in presencial confirmado e não pode ser cancelada por No-Show.',
          },
        };
      }
      continue;
    }

    // Validação da Janela Temporal de Tolerância (5 minutos)
    const startMs = parseSaoPauloDateTimeMs(resDateStr, resInicioStr);
    const storedExpiracao =
      typeof resData.checkInExpiracao === 'number' && resData.checkInExpiracao > 0
        ? resData.checkInExpiracao
        : Number.isFinite(startMs)
        ? startMs + CHECKIN_TOLERANCE_MS
        : 0;

    // Se ainda estiver dentro do prazo regulamentar
    if (storedExpiracao > 0 && serverNow <= storedExpiracao) {
      if (reservationId) {
        return {
          httpStatus: 400,
          body: {
            success: false,
            code: 'WITHIN_DEADLINE',
            message: 'A reserva ainda está dentro do prazo regulamentar de tolerância para check-in (5 minutos).',
          },
        };
      }
      continue;
    }

    // Validação Retroativa: Reservas de datas anteriores (ex: dias passados)
    // Não aplica punição automática sem autorização explícita do administrador
    const isPastDate = resDateStr < todayISO;
    if (isPastDate && !effectiveAllowPastDateReview) {
      requiresReviewCount++;
      processedResults.push({
        reservationId: resId,
        salaNome,
        usuarioId,
        data: resDateStr,
        status: 'REQUIRES_MANUAL_REVIEW',
        reason: 'Reserva de data anterior requer autorização administrativa explícita para processamento retroativo.',
      });

      if (reservationId) {
        return {
          httpStatus: 400,
          body: {
            success: false,
            code: 'REQUIRES_MANUAL_REVIEW',
            message: 'Reserva de data anterior requer autorização administrativa explícita para processamento retroativo.',
            processedCount: 0,
            requiresReviewCount: 1,
            results: processedResults,
          },
        };
      }
      continue;
    }

    // Executa a transação atômica de No-Show
    try {
      const blockedDate = resDateStr;
      const motivoPunicao = `${formatNoShowTag(blockedDate)} (ausência de check-in presencial via QR Code em 5 minutos)`;
      const punicaoMotivo = motivoPunicao;
      const slotLockId = buildSlotLockId(salaId, resDateStr, resInicioStr, resFimStr);
      const punishmentId = `pun_${resId}`;

      const adminDb = getPrivilegedFirestore();
      let targetUserName = String(resData.usuarioNome || 'Usuário');
      let targetUserEmail = String(resData.usuarioEmail || '');
      let targetUserPhone = '';
      let targetWhatsappEnabled = true;

      if (adminDb) {
        // Transação atômica via Admin SDK
        await adminDb.runTransaction(async (tx) => {
          const resRef = adminDb.collection('reservas').doc(resId);
          const currentResSnap = await tx.get(resRef);

          if (!currentResSnap.exists) {
            throw new Error('RESERVATION_NOT_FOUND');
          }

          const currentResData = currentResSnap.data() || {};
          if (
            currentResData.status !== 'PENDENTE' ||
            currentResData.checkInRealizado === true
          ) {
            throw new Error('ALREADY_PROCESSED');
          }

          // Busca dados do usuário para verificar role e aplicar bloqueio no dia exato
          const userRef = adminDb.collection('users').doc(usuarioId);
          const userSnap = await tx.get(userRef);
          let userIsAdmin = false;

          if (userSnap.exists) {
            const uData = userSnap.data() || {};
            userIsAdmin = uData.role === 'ADMIN';
            targetUserName = String(uData.nome || targetUserName);
            targetUserEmail = String(uData.email || targetUserEmail);
            targetUserPhone = String(uData.phone || uData.phoneFormatted || '');
            targetWhatsappEnabled = uData.whatsappNotificationsEnabled !== false;

            // Administradores não recebem suspensão disciplinar por No-Show
            if (!userIsAdmin) {
              tx.update(userRef, {
                blockedDate,
                punidoAte: null,
                motivoPunicao,
                updatedAt: serverNow,
              });
            }
          }

          // Atualiza a reserva para PUNIDA
          tx.update(resRef, {
            status: 'PUNIDA',
            updatedAt: serverNow,
            blockedDate,
            punicaoMotivo,
            observacoes: `Reserva cancelada automaticamente por No-Show. ${formatNoShowTag(blockedDate)} (cota semanal liberada para outras datas).`,
            whatsappNoShowEnviado: false,
          });

          // Registra no histórico de punições se não for administrador
          if (!userIsAdmin) {
            const punRef = adminDb.collection('punishments').doc(punishmentId);
            tx.set(punRef, {
              id: punishmentId,
              usuarioId,
              usuarioNome: targetUserName,
              usuarioEmail: targetUserEmail,
              reservaId: resId,
              categoriaMotivo: 'NO_SHOW',
              motivo: punicaoMotivo,
              blockedDate,
              dataInicio: serverNow,
              tipo: 'AUTOMATICA',
              aplicadoPorId: 'SISTEMA',
              aplicadoPorNome: 'Sistema (No-Show Automático)',
              ativa: true,
              createdAt: serverNow,
              updatedAt: serverNow,
            });
          }

          // Libera o slot_locks associado para liberar a sala
          if (slotLockId) {
            const lockRef = adminDb.collection('slot_locks').doc(slotLockId);
            const lockSnap = await tx.get(lockRef);
            if (lockSnap.exists && lockSnap.data()?.reservaId === resId) {
              tx.delete(lockRef);
            }
          }
        });
      } else {
        // Fallback REST com controle de concorrência otimista (Zero-Config)
        const userDoc = await serverGetDocument('users', usuarioId, authUser.idToken);
        const userIsAdmin = userDoc.exists && userDoc.data.role === 'ADMIN';
        if (userDoc.exists) {
          targetUserName = String(userDoc.data.nome || targetUserName);
          targetUserEmail = String(userDoc.data.email || targetUserEmail);
          targetUserPhone = String(userDoc.data.phone || userDoc.data.phoneFormatted || '');
          targetWhatsappEnabled = userDoc.data.whatsappNotificationsEnabled !== false;
        }

        if (!userIsAdmin && userDoc.exists) {
          await serverAtomicPatchDocument({
            collectionId: 'users',
            docId: usuarioId,
            patch: {
              blockedDate,
              punidoAte: null,
              motivoPunicao,
              updatedAt: serverNow,
            },
            idToken: authUser.idToken,
          });
        }

        await serverAtomicPatchDocument({
          collectionId: 'reservas',
          docId: resId,
          expectedUpdateTime: candidate.updateTime,
          patch: {
            status: 'PUNIDA',
            updatedAt: serverNow,
            blockedDate,
            punicaoMotivo,
            observacoes: `Reserva cancelada automaticamente por No-Show. ${formatNoShowTag(blockedDate)} (cota semanal liberada para outras datas).`,
            whatsappNoShowEnviado: false,
          },
          idToken: authUser.idToken,
        });

        if (!userIsAdmin) {
          await serverSetDocument({
            collectionId: 'punishments',
            docId: punishmentId,
            idToken: authUser.idToken,
            data: {
              id: punishmentId,
              usuarioId,
              usuarioNome: targetUserName,
              usuarioEmail: targetUserEmail,
              reservaId: resId,
              categoriaMotivo: 'NO_SHOW',
              motivo: punicaoMotivo,
              blockedDate,
              dataInicio: serverNow,
              tipo: 'AUTOMATICA',
              aplicadoPorId: 'SISTEMA',
              aplicadoPorNome: 'Sistema (No-Show Automático)',
              ativa: true,
              createdAt: serverNow,
              updatedAt: serverNow,
            },
          });
        }
      }

      // Log de Auditoria Imutável no Servidor
      await writeServerAuditLog({
        acao: 'NO_SHOW_AUTOMATICO',
        actorUid: authUser.uid,
        actorName: authUser.nome || 'Servidor TechReserve',
        entidade: 'RESERVAS',
        detalhes: `No-Show automático processado para "${salaNome}" (${formatDataBR(blockedDate)} às ${resInicioStr}). ${formatNoShowTag(blockedDate)}. Sala liberada.`,
        idToken: authUser.idToken,
      });

      // Disparo de notificação via WhatsApp (somente após banco comitado com sucesso)
      let whatsappDelivered = false;
      if (targetWhatsappEnabled && targetUserPhone) {
        try {
          const deadlineStr = calculateCheckInDeadline(resInicioStr);
          const alertMessage = buildNoShowMessage({
            userName: targetUserName,
            roomName: salaNome,
            roomCode: salaInstitutionalId,
            date: blockedDate,
            startTime: resInicioStr,
            endTime: resFimStr,
            checkInDeadline: deadlineStr,
          });

          const waResult = await dispatchWhatsAppMessage({
            to: targetUserPhone,
            message: alertMessage,
            eventType: 'RESERVATION_NO_SHOW',
            metadata: {
              reservationId: resId,
              usuarioId,
              salaNome,
              date: blockedDate,
            },
          });

          whatsappDelivered = Boolean(waResult.payload?.delivered);

          if (whatsappDelivered) {
            await serverAtomicPatchDocument({
              collectionId: 'reservas',
              docId: resId,
              patch: { whatsappNoShowEnviado: true },
              idToken: authUser.idToken,
            }).catch(() => {});
          }
        } catch (waErr) {
          console.warn('[ExpireServer] Falha secundária no envio de WhatsApp de No-Show:', waErr);
        }
      }

      processedCount++;
      processedResults.push({
        reservationId: resId,
        salaNome,
        usuarioId,
        data: blockedDate,
        status: 'PUNIDA',
        whatsappDelivered,
      });
    } catch (txErr: any) {
      if (txErr?.message === 'ALREADY_PROCESSED') {
        processedResults.push({
          reservationId: resId,
          salaNome,
          usuarioId,
          data: resDateStr,
          status: 'SKIPPED',
          reason: 'Reserva já atualizada concorrentemente.',
        });
      } else {
        console.error(`[ExpireServer] Erro ao processar reserva ${resId}:`, txErr);
      }
    }
  }

  return {
    httpStatus: 200,
    body: {
      success: true,
      code: 'EXPIRED_SUCCESSFULLY',
      message:
        processedCount > 0
          ? `${processedCount} reserva(s) expirada(s) processada(s) com sucesso.`
          : 'Reconciliação concluída sem alterações adicionais.',
      processedCount,
      requiresReviewCount,
      results: processedResults,
    },
  };
}
