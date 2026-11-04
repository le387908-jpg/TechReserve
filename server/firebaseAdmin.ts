/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { App, cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

interface AppletFirebaseConfig {
  projectId: string;
  firestoreDatabaseId: string;
}

const BOOTSTRAP_ADMIN_EMAILS = new Set([
  'negreirosmikaella@gmail.com',
  'le387908@gmail.com',
  'fatec.taquaritinga.2024@gmail.com',
]);

let cachedConfig: AppletFirebaseConfig | null = null;
let cachedAdminApp: App | null = null;
let hasPrivilegedServiceAccount = false;

export function getServerFirebaseConfig(): AppletFirebaseConfig {
  if (cachedConfig) return cachedConfig;

  let fileProjectId = '';
  let fileDatabaseId = '';

  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, string>;
      fileProjectId = String(parsed.projectId || '').trim();
      fileDatabaseId = String(parsed.firestoreDatabaseId || '').trim();
    }
  } catch {
    // Fallback para variáveis de ambiente caso o arquivo não esteja acessível
  }

  const projectId =
    String(
      process.env.FIREBASE_PROJECT_ID ||
        process.env.VITE_FIREBASE_PROJECT_ID ||
        fileProjectId ||
        'gen-lang-client-0500851802'
    ).trim();

  const firestoreDatabaseId =
    String(
      process.env.FIREBASE_DATABASE_ID ||
        process.env.VITE_FIREBASE_DATABASE_ID ||
        fileDatabaseId ||
        '(default)'
    ).trim();

  cachedConfig = { projectId, firestoreDatabaseId };
  return cachedConfig;
}

function parseServiceAccountFromEnv(): ServiceAccount | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  if (rawJson) {
    try {
      const decoded = rawJson.startsWith('{')
        ? rawJson
        : Buffer.from(rawJson, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as Record<string, string>;
      if (parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id || getServerFirebaseConfig().projectId,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key.replace(/\\n/g, '\n'),
        };
      }
    } catch (err) {
      console.error('[FirebaseAdmin] Falha ao interpretar FIREBASE_SERVICE_ACCOUNT_KEY:', err);
    }
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (clientEmail && privateKey) {
    return {
      projectId: getServerFirebaseConfig().projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

export function getFirebaseAdminApp(): App {
  if (cachedAdminApp) return cachedAdminApp;

  const existing = getApps()[0];
  if (existing) {
    cachedAdminApp = existing;
    return existing;
  }

  const { projectId } = getServerFirebaseConfig();
  const serviceAccount = parseServiceAccountFromEnv();

  if (serviceAccount) {
    hasPrivilegedServiceAccount = true;
    cachedAdminApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.projectId || projectId,
    });
  } else {
    hasPrivilegedServiceAccount = false;
    cachedAdminApp = initializeApp({ projectId });
  }

  return cachedAdminApp;
}

export function isPrivilegedFirestoreAvailable(): boolean {
  getFirebaseAdminApp();
  return hasPrivilegedServiceAccount;
}

export function getPrivilegedFirestore(): Firestore | null {
  const app = getFirebaseAdminApp();
  if (!hasPrivilegedServiceAccount) return null;
  const { firestoreDatabaseId } = getServerFirebaseConfig();
  return firestoreDatabaseId && firestoreDatabaseId !== '(default)'
    ? getFirestore(app, firestoreDatabaseId)
    : getFirestore(app);
}

/**
 * Verifica criptograficamente o Firebase ID Token via chaves públicas oficiais do Google (JWKS).
 * Funciona tanto com Service Account quanto em modo zero-config (apenas projectId).
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  const app = getFirebaseAdminApp();
  return getAuth(app).verifyIdToken(idToken, false);
}

export function extractBearerToken(req: {
  headers?: Record<string, string | string[] | undefined>;
}): string | null {
  const rawAuth = req?.headers?.authorization || req?.headers?.Authorization;
  const headerValue = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!headerValue || typeof headerValue !== 'string') return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/* ============================================================================
 * FIRESTORE REST v1 SERIALIZATION HELPERS (Compatibilidade Serverless / Zero-Config)
 * ========================================================================== */

type FirestoreRestValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreRestValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreRestValue> } };

interface FirestoreRestDocument {
  name: string;
  fields?: Record<string, FirestoreRestValue>;
  createTime?: string;
  updateTime?: string;
}

function toFirestoreRestValue(val: unknown): FirestoreRestValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map((item) => toFirestoreRestValue(item)),
      },
    };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreRestValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreRestValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreRestValue(val: FirestoreRestValue | undefined): unknown {
  if (!val) return undefined;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((v) => fromFirestoreRestValue(v));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      out[k] = fromFirestoreRestValue(v);
    }
    return out;
  }
  return undefined;
}

function decodeRestDocument(doc: FirestoreRestDocument): {
  id: string;
  data: Record<string, unknown>;
  updateTime?: string;
} {
  const parts = String(doc.name || '').split('/');
  const id = parts[parts.length - 1] || '';
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    data[k] = fromFirestoreRestValue(v);
  }
  return { id, data, updateTime: doc.updateTime };
}

function getFirestoreRestBaseUrl(): string {
  const { projectId, firestoreDatabaseId } = getServerFirebaseConfig();
  const dbSegment = encodeURIComponent(firestoreDatabaseId || '(default)');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${dbSegment}/documents`;
}

export async function serverGetDocument(
  collectionPath: string,
  docId: string,
  idToken?: string
): Promise<{ exists: boolean; id: string; data: Record<string, unknown>; updateTime?: string }> {
  const adminDb = getPrivilegedFirestore();
  if (adminDb) {
    const snap = await adminDb.collection(collectionPath).doc(docId).get();
    return {
      exists: snap.exists,
      id: snap.id,
      data: (snap.data() || {}) as Record<string, unknown>,
      updateTime: snap.updateTime?.toDate().toISOString(),
    };
  }

  const url = `${getFirestoreRestBaseUrl()}/${encodeURIComponent(collectionPath)}/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  const res = await fetch(url, { method: 'GET', headers });
  if (res.status === 404) {
    return { exists: false, id: docId, data: {} };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore REST GET error (${res.status}): ${text.slice(0, 240)}`);
  }

  const json = (await res.json()) as FirestoreRestDocument;
  const decoded = decodeRestDocument(json);
  return {
    exists: true,
    id: decoded.id,
    data: decoded.data,
    updateTime: decoded.updateTime,
  };
}

export async function serverQueryDocumentsByField(params: {
  collectionId: string;
  filters: Array<{ field: string; value: string | number | boolean }>;
  limitCount?: number;
  idToken?: string;
}): Promise<Array<{ id: string; data: Record<string, unknown>; updateTime?: string }>> {
  const { collectionId, filters, limitCount = 25, idToken } = params;
  const adminDb = getPrivilegedFirestore();

  if (adminDb) {
    let q: FirebaseFirestore.Query = adminDb.collection(collectionId);
    for (const f of filters) {
      q = q.where(f.field, '==', f.value);
    }
    q = q.limit(limitCount);
    const snap = await q.get();
    return snap.docs.map((d) => ({
      id: d.id,
      data: (d.data() || {}) as Record<string, unknown>,
      updateTime: d.updateTime?.toDate().toISOString(),
    }));
  }

  const whereClause =
    filters.length === 1
      ? {
          fieldFilter: {
            field: { fieldPath: filters[0].field },
            op: 'EQUAL',
            value: toFirestoreRestValue(filters[0].value),
          },
        }
      : {
          compositeFilter: {
            op: 'AND',
            filters: filters.map((f) => ({
              fieldFilter: {
                field: { fieldPath: f.field },
                op: 'EQUAL',
                value: toFirestoreRestValue(f.value),
              },
            })),
          },
        };

  const url = `${getFirestoreRestBaseUrl()}:runQuery`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: whereClause,
        limit: limitCount,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore REST runQuery error (${res.status}): ${text.slice(0, 240)}`);
  }

  const rows = (await res.json()) as Array<{ document?: FirestoreRestDocument }>;
  const results: Array<{ id: string; data: Record<string, unknown>; updateTime?: string }> = [];
  for (const row of rows) {
    if (row?.document) {
      results.push(decodeRestDocument(row.document));
    }
  }
  return results;
}

export async function serverSetDocument(params: {
  collectionId: string;
  docId: string;
  data: Record<string, unknown>;
  createOnly?: boolean;
  idToken?: string;
}): Promise<void> {
  const { collectionId, docId, data, createOnly = false, idToken } = params;
  const adminDb = getPrivilegedFirestore();

  if (adminDb) {
    const ref = adminDb.collection(collectionId).doc(docId);
    if (createOnly) {
      await ref.create(data);
    } else {
      await ref.set(data, { merge: false });
    }
    return;
  }

  const fields: Record<string, FirestoreRestValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = toFirestoreRestValue(v);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  if (createOnly) {
    const url = `${getFirestoreRestBaseUrl()}/${encodeURIComponent(collectionId)}?documentId=${encodeURIComponent(docId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Firestore REST CREATE error (${res.status}): ${text.slice(0, 280)}`);
    }
    return;
  }

  const url = `${getFirestoreRestBaseUrl()}/${encodeURIComponent(collectionId)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore REST SET error (${res.status}): ${text.slice(0, 280)}`);
  }
}

/**
 * Executa atualização parcial atômica com pré-condição otimista (`updateTime`),
 * impedindo condições de corrida (ex.: check-ins simultâneos duplicados).
 */
export async function serverAtomicPatchDocument(params: {
  collectionId: string;
  docId: string;
  patch: Record<string, unknown>;
  expectedUpdateTime?: string;
  idToken?: string;
}): Promise<void> {
  const { collectionId, docId, patch, expectedUpdateTime, idToken } = params;
  const adminDb = getPrivilegedFirestore();

  if (adminDb) {
    await adminDb.runTransaction(async (tx) => {
      const ref = adminDb.collection(collectionId).doc(docId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error('DOCUMENT_NOT_FOUND');
      }
      if (
        expectedUpdateTime &&
        snap.updateTime &&
        snap.updateTime.toDate().toISOString() !== expectedUpdateTime
      ) {
        throw new Error('CONCURRENT_MODIFICATION');
      }
      tx.update(ref, patch);
    });
    return;
  }

  const fields: Record<string, FirestoreRestValue> = {};
  const maskParams: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields[k] = toFirestoreRestValue(v);
      maskParams.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`);
    }
  }
  if (expectedUpdateTime) {
    maskParams.push(`currentDocument.updateTime=${encodeURIComponent(expectedUpdateTime)}`);
  }

  const queryStr = maskParams.length > 0 ? `?${maskParams.join('&')}` : '';
  const url = `${getFirestoreRestBaseUrl()}/${encodeURIComponent(collectionId)}/${encodeURIComponent(docId)}${queryStr}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });

  if (res.status === 409 || res.status === 412) {
    throw new Error('CONCURRENT_MODIFICATION');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore REST PATCH error (${res.status}): ${text.slice(0, 280)}`);
  }
}

/* ============================================================================
 * AUTENTICAÇÃO E RBAC DE REQUISIÇÕES HTTP (/api/*)
 * ========================================================================== */

export interface AuthenticatedRequestUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
  role: 'ADMIN' | 'USUARIO';
  isAdmin: boolean;
  nome: string;
  phone: string;
  active: boolean;
  deleted: boolean;
  profileExists: boolean;
}

export class ApiAuthError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function authenticateApiRequest(
  req: { headers?: Record<string, string | string[] | undefined> },
  options: {
    requireAdmin?: boolean;
    allowMissingProfile?: boolean;
  } = {}
): Promise<AuthenticatedRequestUser> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new ApiAuthError(401, 'Autenticação obrigatória. Token de sessão ausente.');
  }

  let decoded: DecodedIdToken;
  try {
    decoded = await verifyFirebaseIdToken(token);
  } catch {
    throw new ApiAuthError(401, 'Sessão expirada ou token inválido. Faça login novamente.');
  }

  const uid = decoded.uid;
  const email = String(decoded.email || '').trim().toLowerCase();
  const emailVerified = Boolean(decoded.email_verified);
  const isBootstrap = emailVerified && BOOTSTRAP_ADMIN_EMAILS.has(email);

  const userDoc = await serverGetDocument('users', uid, token);
  if (!userDoc.exists) {
    if (!options.allowMissingProfile && !isBootstrap) {
      throw new ApiAuthError(403, 'Perfil institucional não localizado para esta sessão.');
    }
    const role: 'ADMIN' | 'USUARIO' = isBootstrap ? 'ADMIN' : 'USUARIO';
    if (options.requireAdmin && role !== 'ADMIN') {
      throw new ApiAuthError(403, 'Acesso restrito exclusivamente ao perfil Administrador.');
    }
    return {
      uid,
      email,
      emailVerified,
      idToken: token,
      role,
      isAdmin: role === 'ADMIN',
      nome: String(decoded.name || email.split('@')[0] || 'Usuário'),
      phone: '',
      active: true,
      deleted: false,
      profileExists: false,
    };
  }

  const raw = userDoc.data;
  const isDeleted = raw.deleted === true || raw.status === 'deleted';
  if (isDeleted) {
    throw new ApiAuthError(403, 'Este perfil foi excluído do sistema.');
  }

  const isInactive =
    raw.inativo === true ||
    raw.active === false ||
    raw.status === 'inactive' ||
    raw.bloqueado === true;

  if (isInactive) {
    throw new ApiAuthError(
      403,
      'Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações'
    );
  }

  const role: 'ADMIN' | 'USUARIO' = raw.role === 'ADMIN' ? 'ADMIN' : 'USUARIO';
  const isAdmin = role === 'ADMIN';

  if (options.requireAdmin && !isAdmin) {
    throw new ApiAuthError(
      403,
      'Operação restrita exclusivamente ao perfil Administrador (Coordenação).'
    );
  }

  const rawPhone = String(raw.phone || raw.phoneFormatted || '').replace(/\D/g, '');

  return {
    uid,
    email: String(raw.email || email),
    emailVerified,
    idToken: token,
    role,
    isAdmin,
    nome: String(raw.nome || raw.name || 'Usuário'),
    phone: rawPhone,
    active: true,
    deleted: false,
    profileExists: true,
  };
}

/**
 * Grava trilha imutável de auditoria na coleção `logs` a partir do backend.
 */
export async function writeServerAuditLog(params: {
  acao: string;
  actorUid: string;
  actorName: string;
  entidade:
    | 'USERS'
    | 'SALAS'
    | 'RESERVAS'
    | 'PUNIDAS'
    | 'HORARIOS'
    | 'SISTEMA'
    | 'CHAMADOS'
    | 'WHATSAPP';
  detalhes: string;
  idToken?: string;
}): Promise<void> {
  try {
    const logId = `srv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await serverSetDocument({
      collectionId: 'logs',
      docId: logId,
      createOnly: true,
      idToken: params.idToken,
      data: {
        acao: String(params.acao || 'ACAO_SERVIDOR').slice(0, 120),
        usuarioId: String(params.actorUid || 'SISTEMA').slice(0, 128),
        usuarioNome: String(params.actorName || 'Servidor TechReserve').slice(0, 140),
        entidade: params.entidade,
        detalhes: String(params.detalhes || '').slice(0, 950),
        createdAt: Date.now(),
      },
    });
  } catch (err) {
    console.warn('[AuditLog] Falha secundária ao gravar log no servidor:', err);
  }
}

/**
 * Gera o hash SHA-256 determinístico usado para armazenar e comparar `code-auth` sem texto puro.
 */
export function hashAdminAuthCode(rawCode: string): string {
  const normalized = String(rawCode || '').trim();
  return crypto
    .createHash('sha256')
    .update(`TECHRESERVE_ADMIN_CODE_V2:${normalized}`, 'utf-8')
    .digest('hex');
}

export function isBootstrapAdminEmail(email: string, emailVerified: boolean): boolean {
  if (!emailVerified) return false;
  return BOOTSTRAP_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}
