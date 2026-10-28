/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp } from 'firebase/app';
import { 
  initializeAuth, 
  browserLocalPersistence, 
  browserSessionPersistence,
  indexedDBLocalPersistence,
  inMemoryPersistence
} from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAnalytics, isSupported } from 'firebase/analytics';
// @ts-ignore
import firebaseConfig from '../../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Initialize Auth with multiple persistence options (including inMemoryPersistence fallback) to avoid network-request-failed in restricted environments
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence],
});

import { initializeFirestore } from 'firebase/firestore';

// Firestore initialization with settings to prevent network-request-failed errors
// Note: experimentalForceLongPolling and experimentalAutoDetectLongPolling are mutually exclusive
// We enable only experimentalForceLongPolling for more reliability in some restricted networks
const firestoreSettings = {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false,
};

export const db = (firebaseConfig as any).firestoreDatabaseId 
  ? initializeFirestore(app, firestoreSettings, (firebaseConfig as any).firestoreDatabaseId)
  : initializeFirestore(app, firestoreSettings);

export const storage = getStorage(app);

// Analytics is initialized conditionally with error handling
export const analytics = typeof window !== 'undefined' ? 
  isSupported().then(yes => {
    if (yes) {
      try {
        return getAnalytics(app);
      } catch (e) {
        console.warn("Firebase Analytics could not be initialized:", e);
        return null;
      }
    }
    return null;
  }).catch(() => null) : 
  Promise.resolve(null);

// Connection test as per instructions
async function testConnection() {
  if (typeof window === 'undefined') return;
  try {
    // Try to reach Firestore to check connectivity
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase connection successful.");
  } catch (error) {
    if (error instanceof Error && (error.message.includes('offline') || error.message.includes('network'))) {
      console.error("Firebase is offline or network is failing. Authentication and Firestore operations may fail.", error.message);
    }
  }
}

testConnection();
