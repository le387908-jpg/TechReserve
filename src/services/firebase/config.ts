/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  initializeAuth,
  browserSessionPersistence,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  initializeFirestore,
  memoryLocalCache,
  doc,
  getDocFromServer,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
// @ts-ignore
import firebaseConfig from '../../../firebase-applet-config.json';

const TAB_INSTANCE_ID_KEY = 'techreserve_tab_instance_id_v2';
const TAB_USER_SNAPSHOT_KEY = 'techreserve_tab_auth_user_v1';

/**
 * Remove artefatos legados de persistência compartilhada (`localStorage` e `firebaseLocalStorageDb` no IndexedDB)
 * deixados por versões anteriores que utilizavam `getAuth()`, evitando qualquer sincronização residual entre abas.
 */
function purgeLegacySharedAuthStorage(): void {
  if (typeof window === 'undefined') return;

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (
        key &&
        (key.startsWith('firebase:authUser:') ||
          key.startsWith('firebase:persistence:') ||
          key.startsWith('firebase:redirectUser:') ||
          key.startsWith('firebase:host:') ||
          key === TAB_USER_SNAPSHOT_KEY)
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignora caso localStorage esteja bloqueado pelo navegador
  }

  try {
    if (typeof window.indexedDB !== 'undefined' && typeof window.indexedDB.deleteDatabase === 'function') {
      window.indexedDB.deleteDatabase('firebaseLocalStorageDb');
    }
  } catch {
    // Ignora caso IndexedDB esteja indisponível
  }
}

purgeLegacySharedAuthStorage();

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

const globalAuthScope = globalThis as typeof globalThis & {
  __TECHRESERVE_TAB_AUTH__?: Auth;
};

/**
 * Inicialização explícita e exclusiva com `browserSessionPersistence`.
 * NUNCA utiliza `getAuth(app)`, `indexedDBLocalPersistence`, `browserLocalPersistence`
 * nem `browserPopupRedirectResolver`, isolando 100% o login em `sessionStorage` por aba.
 */
export const auth: Auth =
  globalAuthScope.__TECHRESERVE_TAB_AUTH__ ??
  (globalAuthScope.__TECHRESERVE_TAB_AUTH__ = initializeAuth(app, {
    persistence: browserSessionPersistence,
  }));

function generateTabInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearClonedFirebaseSessionKeys(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (
        key &&
        (key.startsWith('firebase:authUser:') ||
          key.startsWith('firebase:persistence:') ||
          key === TAB_USER_SNAPSHOT_KEY)
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignora caso sessionStorage esteja restrito
  }
}

function holdTabLifetimeLock(tabId: string): void {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return;
  void navigator.locks
    .request(`techreserve_live_tab_${tabId}`, () => new Promise<void>(() => {}))
    .catch(() => {});
}

/**
 * Garante isolamento até mesmo quando o usuário clica em "Duplicar aba" no navegador:
 * - Em recarregamentos (`F5`), preserva integralmente a sessão da aba atual.
 * - Em abas duplicadas a partir de uma aba já aberta (que clonam o `sessionStorage` inicial),
 *   detecta que a aba original continua viva via Web Locks, gera um novo ID de aba e limpa
 *   apenas a cópia clonada da nova aba para que ela inicie deslogada sem afetar a aba original.
 */
function initTabIsolationGuard(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  let existingTabId: string | null = null;
  try {
    existingTabId = window.sessionStorage.getItem(TAB_INSTANCE_ID_KEY);
  } catch {
    return Promise.resolve();
  }

  // Aba totalmente nova: cria identificador próprio e mantém lock vitalício da aba
  if (!existingTabId) {
    const freshTabId = generateTabInstanceId();
    try {
      window.sessionStorage.setItem(TAB_INSTANCE_ID_KEY, freshTabId);
    } catch {
      // Ignora falha de escrita em sessionStorage
    }
    holdTabLifetimeLock(freshTabId);
    return Promise.resolve();
  }

  const navEntry =
    typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
      ? (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
      : undefined;
  const isPageReload = navEntry?.type === 'reload';

  // F5 / Reload na mesma aba: preserva a sessão autenticada da aba e renova o lock
  if (isPageReload || typeof navigator === 'undefined' || !navigator.locks?.request) {
    holdTabLifetimeLock(existingTabId);
    return Promise.resolve();
  }

  // Verifica se outra aba aberta ainda detém o lock deste `existingTabId` (caso de "Duplicar aba")
  return new Promise<void>((resolve) => {
    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 250);

    const finish = () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      }
    };

    void navigator.locks
      .request(
        `techreserve_live_tab_${existingTabId}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock) {
            // Nenhuma outra aba viva detém este ID: pertence legitimamente a esta aba
            finish();
            return new Promise<void>(() => {});
          }

          // Outra aba está ativa com este ID -> esta aba foi duplicada!
          const duplicatedNewTabId = generateTabInstanceId();
          try {
            window.sessionStorage.setItem(TAB_INSTANCE_ID_KEY, duplicatedNewTabId);
          } catch {
            // Ignora falha de escrita
          }

          clearClonedFirebaseSessionKeys();
          try {
            await firebaseSignOut(auth);
          } catch {
            // Ignora erro caso já estivesse deslogado
          }

          holdTabLifetimeLock(duplicatedNewTabId);
          finish();
        }
      )
      .catch(() => {
        finish();
      });
  });
}

export const authPersistenceReady: Promise<void> = initTabIsolationGuard();

export function ensureTabIsolationReady(): Promise<void> {
  return authPersistenceReady;
}

/**
 * Firestore inicializado APÓS `initializeAuth` com cache em memória (`memoryLocalCache`) por aba
 * e long-polling para evitar qualquer compartilhamento de IndexedDB entre abas com perfis distintos.
 */
const firestoreSettings = {
  localCache: memoryLocalCache(),
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false,
};

export const db = (firebaseConfig as any).firestoreDatabaseId
  ? initializeFirestore(app, firestoreSettings, (firebaseConfig as any).firestoreDatabaseId)
  : initializeFirestore(app, firestoreSettings);

export const storage = getStorage(app);

export const analytics = Promise.resolve(null);

async function testConnection() {
  if (typeof window === 'undefined') return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('the client is offline') ||
        error.message.includes('offline') ||
        error.message.includes('network'))
    ) {
      console.error('Please check your Firebase configuration.', error.message);
    }
  }
}

void testConnection();
