/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  ApiAuthError,
  authenticateApiRequest,
  serverAtomicPatchDocument,
  serverGetDocument,
  serverQueryDocumentsByField,
  writeServerAuditLog,
} from './firebaseAdmin';
import { checkRateLimit, extractClientIp } from './rateLimiter';

const CheckInRequestSchema = z.object({
  qrData: z.string().trim().min(1, 'Código QR não informado.').max(256, 'Código QR inválido.'),
  reservationId: z.string().trim().min(1).max(128).optional(),
  clientScannedAt: z.number().int().positive().optional(),
});

const VALID_INSTITUTIONAL_PREFIXES = [
  'SALA-',
  'LAB-',
  'BIB-',
  'AUD-',
  'VID-',
  'CAD-',
  'DES-',
  'MAQ-',
  'BRA-',
  'QUI-',
];

const EARLY_CHECKIN_LEAD_MS = 15 * 60 * 1000; // Permite leitura até 15 min antes do início (após lembrete de 10 min)
const DEFAULT_CHECKIN_TOLERANCE_MS = 5 * 60 * 1000; // Tolerância institucional vigente (5 min após o início)

/**
 * Obtém a data ISO ('YYYY-MM-DD') oficial no fuso horário institucional (America/Sao_Paulo).
 */
export function getSaoPauloTodayISO(nowMs: number = Date.now()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(nowMs));
}

/**
 * Converte data ISO ('YYYY-MM-DD') + horário ('HH:mm') no fuso America/Sao_Paulo (-03:00)
 * para epoch em milissegundos, garantindo consistência idêntica em Cloud Run / Vercel (UTC) e Brasil.
 */
export function parseSaoPauloDateTimeMs(dateISO: string, timeHHMM: string): number {
  const cleanDate = String(dateISO || '').trim();
  const cleanTime = String(timeHHMM || '').trim();
  const dateMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = cleanTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    return NaN;
  }
  const hh = timeMatch[1].padStart(2, '0');
  const mm = timeMatch[2].padStart(2, '0');
  // Fatec Franco da Rocha opera permanentemente em America/Sao_Paulo (UTC-03:00, sem horário de verão)
  return Date.parse(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${hh}:${mm}:00.000-03:00`);
}

function extractRoomIdentifierFromQr(rawQr: string): string {
  const safeQr = String(rawQr || '').trim();
  if (safeQr.toUpperCase().startsWith('TECHRESERVE:')) {
    const parts = safeQr.split(':');
    return (parts[2] ? safeQr.substring(12) : parts[1] || '').trim();
  }
  return safeQr;
}

export interface ServerCheckInResponse {
  httpStatus: number;
  body: {
    success: boolean;
    reservationId?: string;
    salaNome?: string;
    checkInTimestamp?: number;
    code?:
      | 'CHECKIN_CONFIRMED'
      | 'ALREADY_CONFIRMED'
      | 'EXPIRED_DEADLINE'
      | 'TOO_EARLY'
      | 'WRONG_ROOM'
      | 'NOT_FOUND'
      | 'INVALID_QR'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED'
      | 'CONFLICT'
      | 'SERVER_ERROR';
    message: string;
  };
}

export async function processServerQrCheckIn(req: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}): Promise<ServerCheckInResponse> {
  const ip = extractClientIp(req);

  let authUser;
  try {
    authUser = await authenticateApiRequest(req);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return {
        httpStatus: err.statusCode,
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
        message: 'Falha ao validar sessão do usuário.',
      },
    };
  }

  const rl = checkRateLimit({
    scope: 'qr_checkin',
    identifier: `${authUser.uid}:${ip}`,
    maxRequests: 20,
    windowMs: 60 * 1000,
  });

  if (!rl.allowed) {
    return {
      httpStatus: 429,
      body: {
        success: false,
        code: 'RATE_LIMITED',
        message: `Muitas tentativas de leitura em sequência. Aguarde ${rl.retryAfterSeconds}s e tente novamente.`,
      },
    };
  }

  let rawBody: unknown = req.body;
  if (typeof rawBody === 'string') {
    try {
      rawBody = JSON.parse(rawBody || '{}');
    } catch {
      return {
        httpStatus: 400,
        body: {
          success: false,
          code: 'INVALID_QR',
          message: 'Payload JSON inválido.',
        },
      };
    }
  }

  const parsed = CheckInRequestSchema.safeParse(rawBody || {});
  if (!parsed.success) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'INVALID_QR',
        message: parsed.error.issues[0]?.message || 'Dados de check-in inválidos.',
      },
    };
  }

  const { qrData, reservationId } = parsed.data;
  const scannedCode = extractRoomIdentifierFromQr(qrData);

  if (!scannedCode || scannedCode.length > 128) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'INVALID_QR',
        message: 'Identificador da sala não encontrado no código QR.',
      },
    };
  }

  const upperCode = scannedCode.toUpperCase();
  const looksLikeInstitutional = VALID_INSTITUTIONAL_PREFIXES.some((p) =>
    upperCode.startsWith(p)
  );
  const looksLikeFirestoreId = /^[a-zA-Z0-9_-]{8,128}$/.test(scannedCode);

  if (!looksLikeInstitutional && !looksLikeFirestoreId) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'INVALID_QR',
        message:
          'Código QR inválido. Certifique-se de escanear o código institucional da sala (ex: SALA-001, LAB-001).',
      },
    };
  }

  try {
    // 1. Resolve a sala oficial no Firestore
    let resolvedRoom: {
      firestoreId: string;
      id: string;
      codigo: string;
      nome: string;
    } | null = null;

    const byInstId = await serverQueryDocumentsByField({
      collectionId: 'salas',
      filters: [{ field: 'id', value: upperCode }],
      limitCount: 1,
      idToken: authUser.idToken,
    });

    if (byInstId.length > 0) {
      const r = byInstId[0];
      resolvedRoom = {
        firestoreId: r.id,
        id: String(r.data.id || r.id),
        codigo: String(r.data.codigo || ''),
        nome: String(r.data.nome || upperCode),
      };
    } else {
      const byCodigo = await serverQueryDocumentsByField({
        collectionId: 'salas',
        filters: [{ field: 'codigo', value: upperCode }],
        limitCount: 1,
        idToken: authUser.idToken,
      });

      if (byCodigo.length > 0) {
        const r = byCodigo[0];
        resolvedRoom = {
          firestoreId: r.id,
          id: String(r.data.id || r.id),
          codigo: String(r.data.codigo || ''),
          nome: String(r.data.nome || upperCode),
        };
      } else {
        const directRoom = await serverGetDocument('salas', scannedCode, authUser.idToken);
        if (directRoom.exists) {
          resolvedRoom = {
            firestoreId: directRoom.id,
            id: String(directRoom.data.id || directRoom.id),
            codigo: String(directRoom.data.codigo || ''),
            nome: String(directRoom.data.nome || scannedCode),
          };
        }
      }
    }

    if (!resolvedRoom) {
      return {
        httpStatus: 404,
        body: {
          success: false,
          code: 'NOT_FOUND',
          message: `Sala ${scannedCode} não encontrada no inventário institucional. Verifique o código QR.`,
        },
      };
    }

    // 2. Relógio oficial do servidor (jamais confia no relógio do cliente nem estende prazos offline)
    const serverNow = Date.now();
    const todayISO = getSaoPauloTodayISO(serverNow);

    // 3. Localiza a reserva alvo e valida propriedade e sala
    let targetDoc: {
      id: string;
      data: Record<string, unknown>;
      updateTime?: string;
    } | null = null;

    if (reservationId) {
      const specific = await serverGetDocument('reservas', reservationId, authUser.idToken);
      if (!specific.exists) {
        return {
          httpStatus: 404,
          body: {
            success: false,
            code: 'NOT_FOUND',
            message: 'Reserva não localizada no servidor.',
          },
        };
      }
      targetDoc = {
        id: specific.id,
        data: specific.data,
        updateTime: specific.updateTime,
      };
    } else {
      const userTodayReservations = await serverQueryDocumentsByField({
        collectionId: 'reservas',
        filters: [
          { field: 'usuarioId', value: authUser.uid },
          { field: 'data', value: todayISO },
        ],
        limitCount: 20,
        idToken: authUser.idToken,
      });

      const matchingRoomDocs = userTodayReservations
        .filter((docItem) => {
          const rSalaId = String(docItem.data.salaId || '');
          const rInstId = String(docItem.data.salaInstitutionalId || '');
          return (
            rSalaId === resolvedRoom!.firestoreId ||
            (resolvedRoom!.id && rInstId.toUpperCase() === resolvedRoom!.id.toUpperCase())
          );
        })
        .sort((a, b) => String(a.data.inicio || '').localeCompare(String(b.data.inicio || '')));

      if (matchingRoomDocs.length === 0) {
        return {
          httpStatus: 400,
          body: {
            success: false,
            code: 'WRONG_ROOM',
            message: 'erro ao realizar check-in, Código QR inválido para esta sala',
          },
        };
      }

      targetDoc =
        matchingRoomDocs.find(
          (d) => d.data.status === 'PENDENTE' && d.data.checkInRealizado !== true
        ) || matchingRoomDocs[0];
    }

    const resData = targetDoc.data;
    const ownerUid = String(resData.usuarioId || '');

    if (ownerUid !== authUser.uid && !authUser.isAdmin) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'UNAUTHORIZED',
          message: 'Você só pode realizar check-in na sua própria reserva.',
        },
      };
    }

    const resSalaId = String(resData.salaId || '');
    const resInstId = String(resData.salaInstitutionalId || '');
    const roomMatches =
      resSalaId === resolvedRoom.firestoreId ||
      (resolvedRoom.id && resInstId.toUpperCase() === resolvedRoom.id.toUpperCase()) ||
      (resolvedRoom.id && resSalaId.toUpperCase() === resolvedRoom.id.toUpperCase());

    if (!roomMatches) {
      return {
        httpStatus: 400,
        body: {
          success: false,
          code: 'WRONG_ROOM',
          message: 'erro ao realizar check-in, Código QR inválido para esta sala',
        },
      };
    }

    const currentStatus = String(resData.status || '');
    const alreadyCheckedIn = resData.checkInRealizado === true || currentStatus === 'CONFIRMADA';

    if (alreadyCheckedIn) {
      return {
        httpStatus: 409,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'ALREADY_CONFIRMED',
          message: 'erro no check-in, código QR incompatível com sua reserva atual',
        },
      };
    }

    if (currentStatus === 'CANCELADA') {
      return {
        httpStatus: 409,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'CONFLICT',
          message: `Sua reserva para ${resolvedRoom.nome} consta como cancelada.`,
        },
      };
    }

    if (currentStatus === 'PUNIDA') {
      return {
        httpStatus: 410,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'EXPIRED_DEADLINE',
          message:
            'O prazo oficial de check-in expirou e a reserva já foi encerrada por ausência (No-Show).',
        },
      };
    }

    if (currentStatus !== 'PENDENTE') {
      return {
        httpStatus: 409,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'CONFLICT',
          message: `Reserva indisponível para check-in (Status atual: ${currentStatus || 'INDISPONÍVEL'}).`,
        },
      };
    }

    // 4. Validação estrita da janela temporal pelo horário oficial do servidor
    const resDateStr = String(resData.data || '');
    const resInicioStr = String(resData.inicio || '');
    const startMs = parseSaoPauloDateTimeMs(resDateStr, resInicioStr);
    const storedExpiracao =
      typeof resData.checkInExpiracao === 'number' && resData.checkInExpiracao > 0
        ? resData.checkInExpiracao
        : Number.isFinite(startMs)
        ? startMs + DEFAULT_CHECKIN_TOLERANCE_MS
        : 0;

    if (resDateStr !== todayISO && !authUser.isAdmin) {
      return {
        httpStatus: 400,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'TOO_EARLY',
          message: `Esta reserva é para a data ${resDateStr} e não pode receber check-in hoje.`,
        },
      };
    }

    if (Number.isFinite(startMs) && serverNow < startMs - EARLY_CHECKIN_LEAD_MS && !authUser.isAdmin) {
      return {
        httpStatus: 400,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'TOO_EARLY',
          message: `O check-in presencial para esta reserva abre 15 minutos antes do início (${resInicioStr}).`,
        },
      };
    }

    if (storedExpiracao > 0 && serverNow > storedExpiracao && !authUser.isAdmin) {
      return {
        httpStatus: 410,
        body: {
          success: false,
          reservationId: targetDoc.id,
          code: 'EXPIRED_DEADLINE',
          message:
            'Prazo oficial de tolerância para check-in encerrado no servidor. Não é possível validar fora da janela regulamentar.',
        },
      };
    }

    // 5. Atualização atômica com controle de concorrência (`expectedUpdateTime` / `runTransaction`)
    await serverAtomicPatchDocument({
      collectionId: 'reservas',
      docId: targetDoc.id,
      expectedUpdateTime: targetDoc.updateTime,
      idToken: authUser.idToken,
      patch: {
        status: 'CONFIRMADA',
        checkInRealizado: true,
        checkInTimestamp: serverNow,
        checkInMethod: 'QR_SERVER_VALIDATED',
        updatedAt: serverNow,
      },
    });

    await writeServerAuditLog({
      acao: 'CHECKIN_QR_SERVIDOR',
      actorUid: authUser.uid,
      actorName: authUser.nome,
      entidade: 'RESERVAS',
      detalhes: `Check-in presencial validado no servidor para "${resolvedRoom.nome}" (${resolvedRoom.id}) na reserva ${targetDoc.id}.`,
      idToken: authUser.idToken,
    });

    return {
      httpStatus: 200,
      body: {
        success: true,
        reservationId: targetDoc.id,
        salaNome: resolvedRoom.nome,
        checkInTimestamp: serverNow,
        code: 'CHECKIN_CONFIRMED',
        message: 'Check-in realizado com sucesso!',
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'CONCURRENT_MODIFICATION') {
      return {
        httpStatus: 409,
        body: {
          success: false,
          code: 'ALREADY_CONFIRMED',
          message: 'Esta reserva acabou de ser atualizada simultaneamente. Verifique o status atual.',
        },
      };
    }

    console.error('[CheckInServer] Erro interno ao processar check-in QR:', err);
    return {
      httpStatus: 500,
      body: {
        success: false,
        code: 'SERVER_ERROR',
        message: 'Erro interno ao validar o check-in no servidor. Tente novamente.',
      },
    };
  }
}
