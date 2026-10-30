import { create } from 'zustand';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  doc, 
  updateDoc, 
  limit, 
  getDoc 
} from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { useAuthStore } from './useAuthStore';
import { Reservation } from '../types';
import {
  OperationType,
  getFriendlyErrorMessage,
  withRetry,
} from '../services/firebase/utils';
import { getTodayLocalISO } from '../utils/dateUtils';

interface CheckInState {
  isProcessing: boolean;
  message: {
    type: 'success' | 'error' | null;
    text: string | null;
  };
  
  processCheckIn: (qrData: string) => Promise<boolean>;
  clearMessage: () => void;
}

export const useCheckInStore = create<CheckInState>((set, get) => ({
  isProcessing: false,
  message: {
    type: null,
    text: null,
  },

  clearMessage: () => set({ message: { type: null, text: null } }),

  processCheckIn: async (qrData: string) => {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ 
        message: { type: 'error', text: 'Você precisa estar logado para realizar check-in.' } 
      });
      return false;
    }

    set({ isProcessing: true, message: { type: null, text: null } });

    try {
      // 1. Validate and Extract Room ID
      const safeQr = String(qrData || '').trim();
      let salaId = safeQr;
      if (safeQr.startsWith('TECHRESERVE:')) {
        salaId = (safeQr.split(':')[1] || '').trim();
      }
      
      if (!salaId) {
        const validationErr = new Error('Identificador da sala não encontrado no código.');
        (validationErr as any).isValidationError = true;
        throw validationErr;
      }

      if (!salaId.startsWith('SALA-') && 
          !salaId.startsWith('LAB-') && 
          !salaId.startsWith('BIB-') && 
          !salaId.startsWith('AUD-') && 
          !salaId.startsWith('VID-') &&
          !salaId.startsWith('CAD-') &&
          !salaId.startsWith('DES-') &&
          !salaId.startsWith('MAQ-') &&
          !salaId.startsWith('BRA-') &&
          !salaId.startsWith('QUI-')) {
        const validationErr = new Error('Código QR inválido. Certifique-se de escanear o código da sala (ex: SALA-001, LAB-001).');
        (validationErr as any).isValidationError = true;
        throw validationErr;
      }

      // 2. Resolve Room ID (Find the firestoreId for the institutional ID)
      let firestoreRoomId: string | null = null;
      
      const roomsRef = collection(db, 'salas');
      const roomQuery = query(roomsRef, where('id', '==', salaId), limit(1));
      const roomSnapshot = await withRetry(() => getDocs(roomQuery));
      
      if (!roomSnapshot.empty) {
        firestoreRoomId = roomSnapshot.docs[0].id;
      } else {
        // Fallback: Check if the scanned ID is actually a firestore UID
        const directRoomDoc = await withRetry(() => getDoc(doc(db, 'salas', salaId)));
        if (directRoomDoc.exists()) {
          firestoreRoomId = directRoomDoc.id;
        }
      }

      if (!firestoreRoomId) {
        const validationErr = new Error(`Sala ${salaId} não encontrada no sistema. Verifique o código QR.`);
        (validationErr as any).isValidationError = true;
        throw validationErr;
      }

      // 3. Search for ANY reservation for this user and this room today
      const today = getTodayLocalISO();
      const reservationsRef = collection(db, 'reservas');
      const q = query(
        reservationsRef,
        where('usuarioId', '==', user.id),
        where('salaId', '==', firestoreRoomId),
        where('data', '==', today)
      );

      const querySnapshot = await withRetry(() => getDocs(q));
      
      if (querySnapshot.empty) {
        // Check if the user has ANY other reservation today to give a rich, helpful validation error
        const anyResQuery = query(
          reservationsRef,
          where('usuarioId', '==', user.id),
          where('data', '==', today)
        );
        const anyResSnapshot = await withRetry(() => getDocs(anyResQuery));
        if (!anyResSnapshot.empty) {
          const activeRes = anyResSnapshot.docs.map(doc => doc.data()).filter(r => r.status === 'PENDENTE' || r.status === 'CONFIRMADA');
          if (activeRes.length > 0) {
            const validationErr = new Error('erro ao realizar check-in, Código QR inválido para esta sala');
            (validationErr as any).isValidationError = true;
            throw validationErr;
          }
        }
        const validationErr = new Error('erro ao realizar check-in, Código QR inválido para esta sala');
        (validationErr as any).isValidationError = true;
        throw validationErr;
      }

      // 4. Find matching reservation (looking for the PENDING one first)
      const reservations = querySnapshot.docs.map(docSnap => ({ id: docSnap.id, ...(docSnap.data() || {}) } as Reservation));
      
      // Sorted by start time to get the closest one if multiple exist
      const sortedReservations = reservations.sort((a, b) => (a?.inicio || '').localeCompare(b?.inicio || ''));
      
      const validReservation = sortedReservations.find(r => r?.status === 'PENDENTE' && !r?.checkInRealizado);
      
      if (!validReservation) {
        const anyConfirmed = reservations.some(r => r?.checkInRealizado || r?.status === 'CONFIRMADA');
        if (anyConfirmed) {
          const validationErr = new Error('erro no check-in, código QR incompatível com sua reserva atual');
          (validationErr as any).isValidationError = true;
          throw validationErr;
        }
        
        const anyCancelled = reservations.some(r => r?.status === 'CANCELADA');
        if (anyCancelled) {
          const validationErr = new Error(`Sua reserva para a sala ${salaId} foi cancelada.`);
          (validationErr as any).isValidationError = true;
          throw validationErr;
        }

        const validationErr = new Error(`Reserva encontrada para ${salaId}, mas não está disponível para check-in (Status: ${reservations[0]?.status || 'INDISPONÍVEL'}).`);
        (validationErr as any).isValidationError = true;
        throw validationErr;
      }

      // 5. Update the reservation
      const reservationRef = doc(db, 'reservas', validReservation.id);
      await withRetry(() => updateDoc(reservationRef, {
        checkInRealizado: true,
        status: 'CONFIRMADA',
        updatedAt: Date.now()
      }));

      set({ 
        isProcessing: false, 
        message: { type: 'success', text: 'Check-in realizado com sucesso!' } 
      });
      return true;

    } catch (err: any) {
      const isValidationError = 
        err.isValidationError ||
        err.message?.includes('não possui reserva') ||
        err.message?.includes('não corresponde à sua reserva') ||
        err.message?.includes('Código QR inválido') ||
        err.message?.includes('não encontrada no sistema') ||
        err.message?.includes('já foi realizado') ||
        err.message?.includes('foi cancelada');

      if (isValidationError) {
        console.warn("Check-in Mismatch/Validation:", err.message);
      } else {
        console.error("Erro no check-in:", err);
      }

      set({ 
        isProcessing: false, 
        message: { type: 'error', text: getFriendlyErrorMessage(err, 'Erro ao processar check-in.') } 
      });
      return false;
    }
  }
}));
