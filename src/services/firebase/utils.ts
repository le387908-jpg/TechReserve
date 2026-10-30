/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  collection, 
  doc, 
  onSnapshot, 
  query, 
  collectionGroup, 
  orderBy, 
  limit, 
  where 
} from 'firebase/firestore';
import { db, auth } from './config';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  // Extract user info safely with defaults
  const currentUser = auth.currentUser;
  const authInfo = {
    userId: currentUser?.uid || null,
    email: currentUser?.email || null,
    emailVerified: currentUser?.emailVerified || false,
    isAnonymous: currentUser?.isAnonymous || false,
    tenantId: currentUser?.tenantId || null,
    providerInfo: Array.isArray(currentUser?.providerData)
      ? currentUser.providerData.map(p => ({
          providerId: p?.providerId || 'unknown',
          email: p?.email || 'unknown',
        }))
      : []
  };

  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo,
    operationType,
    path
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(errInfo);
  } catch (e) {
    // Fallback if stringify fails for any reason
    serialized = JSON.stringify({
      error: String(errInfo.error),
      operationType: String(errInfo.operationType),
      path: String(errInfo.path),
      userId: String(authInfo.userId)
    });
  }

  console.error('Firestore Error: ', serialized);
  throw new Error(serialized);
}

/**
 * Converte qualquer erro (incluindo JSON estruturado do FirestoreErrorInfo, códigos Firebase Auth/Firestore
 * ou exceções de rede) em uma mensagem amigável e segura em português para exibição na interface.
 */
export function getFriendlyErrorMessage(
  error: unknown,
  fallbackMessage = 'Ocorreu um erro inesperado. Tente novamente.'
): string {
  if (!error) return fallbackMessage;

  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown })?.message === 'string'
      ? String((error as { message?: unknown }).message)
      : '';

  if (!rawMessage.trim()) return fallbackMessage;

  let extractedError = rawMessage.trim();

  // Caso seja um JSON serializado por handleFirestoreError
  if (extractedError.startsWith('{') && extractedError.endsWith('}')) {
    try {
      const parsed = JSON.parse(extractedError) as Partial<FirestoreErrorInfo>;
      if (parsed && typeof parsed.error === 'string') {
        extractedError = parsed.error;
      }
    } catch {
      // Mantém a mensagem original caso não seja JSON válido
    }
  }

  const lower = extractedError.toLowerCase();

  if (
    lower.includes('missing or insufficient permissions') ||
    lower.includes('permission-denied') ||
    lower.includes('permission_denied')
  ) {
    return 'Você não possui permissão para realizar esta operação ou sua sessão precisa ser revalidada.';
  }

  if (
    lower.includes('quota exceeded') ||
    lower.includes('resource-exhausted')
  ) {
    return 'Limite diário de operações do banco de dados atingido. Tente novamente mais tarde.';
  }

  if (
    lower.includes('network') ||
    lower.includes('offline') ||
    lower.includes('failed to fetch') ||
    lower.includes('unavailable')
  ) {
    return 'Falha de conexão com o servidor. Verifique sua internet e tente novamente.';
  }

  if (lower.includes('not-found') || lower.includes('no document to update')) {
    return 'O registro solicitado não foi encontrado ou já foi removido.';
  }

  if (lower.includes('already-exists')) {
    return 'Este registro já existe no sistema.';
  }

  // Evita exibir payloads técnicos brutos ou stack traces na UI
  if (extractedError.startsWith('{') || extractedError.length > 260) {
    return fallbackMessage;
  }

  return extractedError;
}

/**
 * Executes a function with retries on specific network errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>, 
  options: { maxRetries?: number; delayMs?: number; silent?: boolean } = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 1500, silent = false } = options;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      const isNetworkError = 
        error?.code === 'auth/network-request-failed' || 
        error?.code === 'unavailable' || // Firestore offline error code
        error?.message?.toLowerCase().includes('network') ||
        error?.message?.toLowerCase().includes('offline') ||
        error?.message?.toLowerCase().includes('failed to fetch') ||
        error?.message?.toLowerCase().includes('quota exceeded'); // Also retry on quota though it might not help, good for flaky quota

      if (!isNetworkError || attempt === maxRetries - 1) {
        throw error;
      }

      if (!silent) {
        console.warn(`Tentativa ${attempt + 1} falhou devido a erro de rede. Tentando novamente em ${delayMs}ms...`, error);
      }
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Remove recursivamente chaves com valor `undefined` de objetos planos e arrays antes de enviar
 * ao Firebase Firestore (`addDoc`, `setDoc`, `updateDoc`, `batch.set`), prevenindo exceções
 * `FirebaseError: Unsupported field value: undefined` em tempo de execução.
 */
export function stripUndefinedFields<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => stripUndefinedFields(item)) as unknown as T;
  }

  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Preserva instâncias especiais (Date, FieldValue, Timestamp, DocumentReference, etc.)
    if (proto !== null && proto !== Object.prototype) {
      return value;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        cleaned[k] = stripUndefinedFields(v);
      }
    }
    return cleaned as T;
  }

  return value;
}

