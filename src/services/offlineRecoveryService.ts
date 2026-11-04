/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Reservation } from '../types';

const DB_NAME = 'techreserve_offline_recovery_v1';
const DB_VERSION = 1;
const STORE_RESERVATIONS = 'preserved_reservations';
const STORE_PENDING_CHECKINS = 'pending_checkins';
const FALLBACK_SESSION_KEY = 'techreserve_recovery_fallback_v1';

/**
 * Registro mínimo e não sensível da reserva ativa/pendente preservada localmente.
 * Jamais armazena tokens, senhas, telefones, e-mails ou segredos administrativos.
 */
export interface PreservedReservationRecord {
  key: string; // `${uid}::${reservationId}`
  uid: string;
  reservationId: string;
  salaId: string;
  salaInstitutionalId: string;
  salaNome: string;
  data: string;
  inicio: string;
  fim: string;
  status: 'PENDENTE' | 'CONFIRMADA';
  checkInRealizado: boolean;
  checkInExpiracao: number | null;
  preservedAt: number;
  wasOfflineInterrupted: boolean;
}

/**
 * Registro de leitura de QR Code capturada sem conectividade,
 * marcada estritamente como pendente de validação oficial no servidor.
 */
export interface PendingOfflineCheckInRecord {
  key: string; // `${uid}::${reservationId || qrHash}`
  uid: string;
  reservationId?: string;
  qrData: string;
  clientScannedAt: number;
  syncStatus: 'PENDING' | 'SYNCING' | 'FAILED';
  retryCount: number;
  lastError?: string;
}

interface FallbackStorageShape {
  reservations: Record<string, PreservedReservationRecord>;
  pendingCheckIns: Record<string, PendingOfflineCheckInRecord>;
}

function readFallbackStorage(): FallbackStorageShape {
  if (typeof window === 'undefined') {
    return { reservations: {}, pendingCheckIns: {} };
  }
  try {
    const raw = window.sessionStorage.getItem(FALLBACK_SESSION_KEY);
    if (!raw) return { reservations: {}, pendingCheckIns: {} };
    const parsed = JSON.parse(raw) as Partial<FallbackStorageShape>;
    return {
      reservations: parsed.reservations || {},
      pendingCheckIns: parsed.pendingCheckIns || {},
    };
  } catch {
    return { reservations: {}, pendingCheckIns: {} };
  }
}

function writeFallbackStorage(data: FallbackStorageShape): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(FALLBACK_SESSION_KEY, JSON.stringify(data));
  } catch {
    // Ignora restrições de armazenamento privado
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openRecoveryDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_RESERVATIONS)) {
          const resStore = db.createObjectStore(STORE_RESERVATIONS, { keyPath: 'key' });
          resStore.createIndex('by_uid', 'uid', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING_CHECKINS)) {
          const ciStore = db.createObjectStore(STORE_PENDING_CHECKINS, { keyPath: 'key' });
          ciStore.createIndex('by_uid', 'uid', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn('[OfflineRecovery] IndexedDB indisponível, usando fallback seguro de sessão.');
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function syncUserActiveReservationsToLocal(
  uid: string,
  reservations: Reservation[],
  currentlyOffline: boolean
): Promise<void> {
  if (!uid) return;
  const activeList = (Array.isArray(reservations) ? reservations : []).filter(
    (r) =>
      r &&
      r.usuarioId === uid &&
      (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
  );

  const db = await openRecoveryDb();
  const now = Date.now();

  if (!db) {
    const fb = readFallbackStorage();
    const existingKeys = Object.keys(fb.reservations).filter((k) =>
      k.startsWith(`${uid}::`)
    );
    const nextIds = new Set(activeList.map((r) => `${uid}::${r.id}`));
    for (const k of existingKeys) {
      if (!nextIds.has(k) && !currentlyOffline) {
        delete fb.reservations[k];
      }
    }
    for (const r of activeList) {
      const key = `${uid}::${r.id}`;
      const prev = fb.reservations[key];
      fb.reservations[key] = {
        key,
        uid,
        reservationId: r.id,
        salaId: String(r.salaId || ''),
        salaInstitutionalId: String(r.salaInstitutionalId || ''),
        salaNome: String(r.salaNome || ''),
        data: String(r.data || ''),
        inicio: String(r.inicio || ''),
        fim: String(r.fim || ''),
        status: r.status === 'CONFIRMADA' ? 'CONFIRMADA' : 'PENDENTE',
        checkInRealizado: Boolean(r.checkInRealizado),
        checkInExpiracao: typeof r.checkInExpiracao === 'number' ? r.checkInExpiracao : null,
        preservedAt: prev?.preservedAt || now,
        wasOfflineInterrupted: Boolean(prev?.wasOfflineInterrupted || currentlyOffline),
      };
    }
    writeFallbackStorage(fb);
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESERVATIONS, 'readwrite');
      const store = tx.objectStore(STORE_RESERVATIONS);
      const index = store.index('by_uid');
      const getReq = index.getAll(IDBKeyRange.only(uid));

      getReq.onsuccess = () => {
        const existingRecords = (getReq.result || []) as PreservedReservationRecord[];
        const existingMap = new Map(existingRecords.map((rec) => [rec.key, rec]));
        const activeKeys = new Set(activeList.map((r) => `${uid}::${r.id}`));

        if (!currentlyOffline) {
          for (const rec of existingRecords) {
            if (!activeKeys.has(rec.key)) {
              store.delete(rec.key);
            }
          }
        }

        for (const r of activeList) {
          const key = `${uid}::${r.id}`;
          const prev = existingMap.get(key);
          const nextRec: PreservedReservationRecord = {
            key,
            uid,
            reservationId: r.id,
            salaId: String(r.salaId || ''),
            salaInstitutionalId: String(r.salaInstitutionalId || ''),
            salaNome: String(r.salaNome || ''),
            data: String(r.data || ''),
            inicio: String(r.inicio || ''),
            fim: String(r.fim || ''),
            status: r.status === 'CONFIRMADA' ? 'CONFIRMADA' : 'PENDENTE',
            checkInRealizado: Boolean(r.checkInRealizado),
            checkInExpiracao: typeof r.checkInExpiracao === 'number' ? r.checkInExpiracao : null,
            preservedAt: prev?.preservedAt || now,
            wasOfflineInterrupted: Boolean(prev?.wasOfflineInterrupted || currentlyOffline),
          };
          store.put(nextRec);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getPreservedReservationsForUser(
  uid: string
): Promise<PreservedReservationRecord[]> {
  if (!uid) return [];
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    return Object.values(fb.reservations).filter((r) => r.uid === uid);
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_RESERVATIONS, 'readonly');
      const index = tx.objectStore(STORE_RESERVATIONS).index('by_uid');
      const req = index.getAll(IDBKeyRange.only(uid));
      req.onsuccess = () => resolve((req.result || []) as PreservedReservationRecord[]);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function markUserReservationsOfflineInterrupted(uid: string): Promise<number> {
  if (!uid) return 0;
  const records = await getPreservedReservationsForUser(uid);
  if (records.length === 0) return 0;

  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    for (const rec of records) {
      if (fb.reservations[rec.key]) {
        fb.reservations[rec.key].wasOfflineInterrupted = true;
      }
    }
    writeFallbackStorage(fb);
    return records.length;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESERVATIONS, 'readwrite');
      const store = tx.objectStore(STORE_RESERVATIONS);
      for (const rec of records) {
        store.put({ ...rec, wasOfflineInterrupted: true });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

  return records.length;
}

export async function removePreservedReservation(key: string): Promise<void> {
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    delete fb.reservations[key];
    writeFallbackStorage(fb);
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESERVATIONS, 'readwrite');
      tx.objectStore(STORE_RESERVATIONS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearOfflineInterruptedFlagForUser(uid: string): Promise<void> {
  if (!uid) return;
  const records = await getPreservedReservationsForUser(uid);
  if (records.length === 0) return;

  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    for (const rec of records) {
      if (fb.reservations[rec.key]) {
        fb.reservations[rec.key].wasOfflineInterrupted = false;
      }
    }
    writeFallbackStorage(fb);
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESERVATIONS, 'readwrite');
      const store = tx.objectStore(STORE_RESERVATIONS);
      for (const rec of records) {
        store.put({ ...rec, wasOfflineInterrupted: false });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function savePendingOfflineCheckIn(params: {
  uid: string;
  reservationId?: string;
  qrData: string;
  clientScannedAt: number;
}): Promise<PendingOfflineCheckInRecord> {
  const targetSuffix =
    params.reservationId ||
    params.qrData.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) ||
    'qr';
  const key = `${params.uid}::${targetSuffix}`;
  const record: PendingOfflineCheckInRecord = {
    key,
    uid: params.uid,
    reservationId: params.reservationId,
    qrData: params.qrData.trim().slice(0, 256),
    clientScannedAt: params.clientScannedAt,
    syncStatus: 'PENDING',
    retryCount: 0,
  };

  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    fb.pendingCheckIns[key] = record;
    writeFallbackStorage(fb);
    return record;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_PENDING_CHECKINS, 'readwrite');
      tx.objectStore(STORE_PENDING_CHECKINS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

  return record;
}

export async function getPendingOfflineCheckInsForUser(
  uid: string
): Promise<PendingOfflineCheckInRecord[]> {
  if (!uid) return [];
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    return Object.values(fb.pendingCheckIns).filter((item) => item.uid === uid);
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_PENDING_CHECKINS, 'readonly');
      const index = tx.objectStore(STORE_PENDING_CHECKINS).index('by_uid');
      const req = index.getAll(IDBKeyRange.only(uid));
      req.onsuccess = () => resolve((req.result || []) as PendingOfflineCheckInRecord[]);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function removePendingOfflineCheckIn(key: string): Promise<void> {
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    delete fb.pendingCheckIns[key];
    writeFallbackStorage(fb);
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_PENDING_CHECKINS, 'readwrite');
      tx.objectStore(STORE_PENDING_CHECKINS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function updatePendingOfflineCheckInFailure(
  key: string,
  errorMsg: string
): Promise<void> {
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    if (fb.pendingCheckIns[key]) {
      fb.pendingCheckIns[key].syncStatus = 'FAILED';
      fb.pendingCheckIns[key].retryCount += 1;
      fb.pendingCheckIns[key].lastError = errorMsg;
      writeFallbackStorage(fb);
    }
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_PENDING_CHECKINS, 'readwrite');
      const store = tx.objectStore(STORE_PENDING_CHECKINS);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result as PendingOfflineCheckInRecord | undefined;
        if (existing) {
          store.put({
            ...existing,
            syncStatus: 'FAILED',
            retryCount: (existing.retryCount || 0) + 1,
            lastError: errorMsg,
          });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearUserRecoveryData(uid: string): Promise<void> {
  if (!uid) return;
  const db = await openRecoveryDb();
  if (!db) {
    const fb = readFallbackStorage();
    for (const k of Object.keys(fb.reservations)) {
      if (fb.reservations[k]?.uid === uid) delete fb.reservations[k];
    }
    for (const k of Object.keys(fb.pendingCheckIns)) {
      if (fb.pendingCheckIns[k]?.uid === uid) delete fb.pendingCheckIns[k];
    }
    writeFallbackStorage(fb);
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_RESERVATIONS, STORE_PENDING_CHECKINS], 'readwrite');
      const resStore = tx.objectStore(STORE_RESERVATIONS);
      const ciStore = tx.objectStore(STORE_PENDING_CHECKINS);

      const resReq = resStore.index('by_uid').getAllKeys(IDBKeyRange.only(uid));
      resReq.onsuccess = () => {
        for (const k of resReq.result || []) resStore.delete(k);
      };

      const ciReq = ciStore.index('by_uid').getAllKeys(IDBKeyRange.only(uid));
      ciReq.onsuccess = () => {
        for (const k of ciReq.result || []) ciStore.delete(k);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
