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
    providerInfo: currentUser?.providerData?.map(p => ({
      providerId: p.providerId || 'unknown',
      email: p.email || 'unknown',
    })) || []
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
