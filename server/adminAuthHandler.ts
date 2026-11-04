/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { z } from 'zod';
import {
  extractBearerToken,
  hashAdminAuthCode,
  isBootstrapAdminEmail,
  isPrivilegedFirestoreAvailable,
  serverGetDocument,
  serverSetDocument,
  verifyFirebaseIdToken,
  writeServerAuditLog,
} from './firebaseAdmin';
import { checkRateLimit, extractClientIp } from './rateLimiter';

const AdminRegisterSchema = z.object({
  code: z.string().trim().min(4, 'Informe um code-auth válido.').max(64),
  nome: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(10).max(20),
  phoneFormatted: z.string().trim().max(24).optional(),
  whatsappNotificationsEnabled: z.boolean().optional().default(true),
  ra: z.string().trim().max(32).optional().default(''),
  dataNascimento: z.string().trim().max(30).optional().default('2000-01-01'),
});

function timingSafeHexEqual(hexA: string, hexB: string): boolean {
  if (!hexA || !hexB || hexA.length !== hexB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'utf-8'), Buffer.from(hexB, 'utf-8'));
  } catch {
    return false;
  }
}

export async function processAdminRegistration(req: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const ip = extractClientIp(req);
  const token = extractBearerToken(req);

  if (!token) {
    return {
      httpStatus: 401,
      body: { success: false, error: 'Token de autenticação ausente.' },
    };
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(token);
  } catch {
    return {
      httpStatus: 401,
      body: { success: false, error: 'Sessão inválida ou expirada.' },
    };
  }

  // Rate limit rigoroso contra força bruta no code-auth (5 tentativas a cada 15 minutos por IP/UID)
  const rl = checkRateLimit({
    scope: 'admin_code_auth',
    identifier: `${ip}:${decoded.uid}`,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
  });

  if (!rl.allowed) {
    return {
      httpStatus: 429,
      body: {
        success: false,
        error: `Muitas tentativas de autorização administrativa. Aguarde ${Math.ceil(
          rl.retryAfterSeconds / 60
        )} minuto(s).`,
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
        body: { success: false, error: 'Payload JSON inválido.' },
      };
    }
  }

  const parsed = AdminRegisterSchema.safeParse(rawBody || {});
  if (!parsed.success) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        error: parsed.error.issues[0]?.message || 'Dados cadastrais inválidos.',
      },
    };
  }

  const {
    code,
    nome,
    phone,
    phoneFormatted,
    whatsappNotificationsEnabled,
    ra,
    dataNascimento,
  } = parsed.data;

  const cleanEmail = String(decoded.email || '').trim().toLowerCase();
  const isBootstrap = isBootstrapAdminEmail(cleanEmail, Boolean(decoded.email_verified));
  const submittedHash = hashAdminAuthCode(code);

  // Verifica se o perfil já existe (impede autopromoção de conta comum já existente)
  const existingUser = await serverGetDocument('users', decoded.uid, token);
  if (existingUser.exists) {
    return {
      httpStatus: 409,
      body: {
        success: false,
        error: 'Este usuário já possui perfil cadastrado. Promoções exigem aprovação de um Administrador.',
      },
    };
  }

  let authorizedByServer = isBootstrap;

  // 1. Verifica variável de ambiente segura do servidor (ADMIN_SIGNUP_CODE ou ADMIN_SIGNUP_CODE_HASH), se configurada
  if (!authorizedByServer) {
    const envCode = process.env.ADMIN_SIGNUP_CODE?.trim();
    const envHash = process.env.ADMIN_SIGNUP_CODE_HASH?.trim().toLowerCase();
    if (envHash && envHash.length === 64) {
      authorizedByServer = timingSafeHexEqual(submittedHash, envHash);
    } else if (envCode) {
      authorizedByServer = timingSafeHexEqual(submittedHash, hashAdminAuthCode(envCode));
    }
  }

  // 2. Se o servidor possuir credenciais Firebase Admin SDK privilegiadas, consulta settings/admin_auth diretamente
  if (!authorizedByServer && isPrivilegedFirestoreAvailable()) {
    const adminSettings = await serverGetDocument('settings', 'admin_auth');
    if (adminSettings.exists) {
      const allowSignup = adminSettings.data.allowAdminSignup !== false;
      const storedHash = String(adminSettings.data.codeHash || '').trim().toLowerCase();
      const legacyPlain = String(adminSettings.data.codeAuth || '').trim();
      if (!allowSignup) {
        return {
          httpStatus: 403,
          body: {
            success: false,
            error: 'O cadastro de novos administradores está temporariamente desativado pela Coordenação.',
          },
        };
      }
      if (storedHash && storedHash.length === 64) {
        authorizedByServer = timingSafeHexEqual(submittedHash, storedHash);
      } else if (legacyPlain) {
        authorizedByServer = timingSafeHexEqual(
          submittedHash,
          hashAdminAuthCode(legacyPlain)
        );
      }
    }
  }

  // Se o Admin SDK privilegiado está ativo e o código falhou, rejeita imediatamente sem tocar no banco
  if (isPrivilegedFirestoreAvailable() && !authorizedByServer) {
    return {
      httpStatus: 403,
      body: {
        success: false,
        error:
          'Código de autorização administrativa (code-auth) inválido ou cadastro de novos administradores desativado.',
      },
    };
  }

  const now = Date.now();
  const cleanPhone = phone.replace(/\D/g, '').slice(0, 15);
  const userPayload: Record<string, unknown> = {
    id: decoded.uid,
    nome: nome.slice(0, 120),
    name: nome.slice(0, 120),
    email: cleanEmail,
    phone: cleanPhone,
    phoneFormatted: phoneFormatted || cleanPhone,
    whatsappNotificationsEnabled: Boolean(whatsappNotificationsEnabled),
    ra: ra.slice(0, 32),
    tipoVinculo: 'COORDENACAO',
    dataNascimento: dataNascimento || '2000-01-01',
    role: 'ADMIN',
    aprovado: true,
    bloqueado: false,
    inativo: false,
    active: true,
    status: 'active',
    deleted: false,
    blockedDate: '',
    motivoPunicao: '',
    // Em modo REST (sem Service Account Key), envia exclusivamente o digest SHA-256 irreversível
    // para validação pelas Security Rules contra `settings/admin_auth.codeHash` (jamais texto puro).
    ...(!isPrivilegedFirestoreAvailable() && !isBootstrap
      ? { adminCodeHashProof: submittedHash }
      : {}),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await serverSetDocument({
      collectionId: 'users',
      docId: decoded.uid,
      data: userPayload,
      createOnly: true,
      idToken: token,
    });

    await writeServerAuditLog({
      acao: 'CADASTRO_NOVO_ADMIN',
      actorUid: decoded.uid,
      actorName: nome,
      entidade: 'USERS',
      detalhes: `Novo perfil ADMINISTRATIVO validado no servidor (${cleanEmail}).`,
      idToken: token,
    });

    const sanitizedResponseUser = { ...userPayload };
    delete sanitizedResponseUser.adminCodeHashProof;

    return {
      httpStatus: 200,
      body: {
        success: true,
        user: sanitizedResponseUser,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('403') || msg.includes('permission')) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          error:
            'Código de autorização administrativa (code-auth) inválido ou cadastro de novos administradores desativado.',
        },
      };
    }

    console.error('[AdminRegister] Erro ao registrar administrador:', err);
    return {
      httpStatus: 500,
      body: {
        success: false,
        error: 'Erro interno ao validar autorização administrativa.',
      },
    };
  }
}
