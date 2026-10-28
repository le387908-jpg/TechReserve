/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  query, 
  orderBy, 
  limit 
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { Log } from '../types';
import { OperationType, handleFirestoreError } from '../services/firebase/utils';

interface LogState {
  logs: Log[];
  loading: boolean;
  
  fetchLogs: () => () => void;
  addLog: (log: Omit<Log, 'id' | 'createdAt'>) => Promise<void>;
}

export const useLogStore = create<LogState>((set) => ({
  logs: [],
  loading: false,

  fetchLogs: () => {
    set({ loading: true });
    const q = query(collection(db, 'logs'), orderBy('createdAt', 'desc'), limit(100));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Log));
      set({ logs, loading: false });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'logs');
    });

    return unsubscribe;
  },

  addLog: async (logData) => {
    try {
      await addDoc(collection(db, 'logs'), {
        ...logData,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error('Failed to log action:', err);
    }
  }
}));
