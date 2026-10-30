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
import {
  OperationType,
  handleFirestoreError,
  stripUndefinedFields,
} from '../services/firebase/utils';
import { useAuthStore } from './useAuthStore';

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
    const currentUser = useAuthStore.getState().user;
    if (!currentUser || currentUser.role !== 'ADMIN') {
      set({ logs: [], loading: false });
      return () => {};
    }

    set({ loading: true });
    const q = query(collection(db, 'logs'), orderBy('createdAt', 'desc'), limit(100));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...(docSnap.data() || {}) } as Log));
      set({ logs, loading: false });
    }, (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'logs');
      } catch {
        // Erro registrado estruturadamente
      }
      set({ loading: false });
    });

    return unsubscribe;
  },

  addLog: async (logData) => {
    try {
      await addDoc(
        collection(db, 'logs'),
        stripUndefinedFields({
          ...logData,
          acao: String(logData?.acao || 'ACAO_SISTEMA').slice(0, 120),
          usuarioId: String(logData?.usuarioId || 'SISTEMA').slice(0, 128),
          usuarioNome: String(logData?.usuarioNome || 'Usuário').slice(0, 140),
          entidade: String(logData?.entidade || 'SISTEMA').slice(0, 80),
          detalhes: String(logData?.detalhes || '').slice(0, 950),
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('Failed to log action:', err);
    }
  }
}));
