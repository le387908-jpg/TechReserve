/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback } from 'react';
import { collection, doc, onSnapshot, orderBy, query, updateDoc } from 'firebase/firestore';
import { db } from '../services/firebase/config';
import { Reservation, Room, User, UserProfile, inferSpaceCategory } from '../types';
import { formatPhoneMask, validatePhoneNumber } from '../utils/phoneUtils';
import { useAuthStore } from '../store/useAuthStore';
import { OperationType, handleFirestoreError } from '../services/firebase/utils';

/**
 * Converte um documento `User` do TechReserve para a interface enxuta `UserProfile`.
 */
export function toUserProfile(user: User): UserProfile {
  return {
    id: user.id,
    name: user.name || user.nome,
    email: user.email,
    phone: user.phone || '',
    phoneFormatted: user.phoneFormatted || formatPhoneMask(user.phone),
    course: user.course || user.curso,
    semester: user.semester ?? user.semestre ?? null,
    role: user.role,
    whatsappNotificationsEnabled: user.whatsappNotificationsEnabled !== false,
  };
}

/**
 * Hook de sincronização em tempo real (`onSnapshot`) com o Google Firebase Firestore
 * para o documento do usuário autenticado (`users/{userId}`), inventário de espaços (`salas`)
 * e agendamentos (`reservas`).
 */
export function useFirebaseRealtime() {
  const authUser = useAuthStore((state) => state.user);
  const [profile, setProfile] = useState<UserProfile | null>(() =>
    authUser ? toUserProfile(authUser) : null
  );
  const [spaces, setSpaces] = useState<Room[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(authUser));

  useEffect(() => {
    if (!authUser?.id) {
      setProfile(null);
      setSpaces([]);
      setReservations([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // 1. Listener em tempo real do perfil do usuário (`users/{userId}`)
    const unsubUser = onSnapshot(
      doc(db, 'users', authUser.id),
      (snap) => {
        if (snap.exists()) {
          const data = { id: snap.id, ...snap.data() } as User;
          setProfile(toUserProfile(data));
        }
      },
      (err) => {
        console.warn('Realtime user profile listener warning:', err);
      }
    );

    // 2. Listener em tempo real do inventário de espaços (`salas`)
    const spacesQuery = query(collection(db, 'salas'), orderBy('nome', 'asc'));
    const unsubSpaces = onSnapshot(
      spacesQuery,
      (snap) => {
        const list = snap.docs.map((d) => {
          const raw = d.data();
          const base = {
            ...raw,
            firestoreId: d.id,
            id: raw.id || d.id,
            codigo: raw.codigo || '',
          } as Room;
          base.categoria = inferSpaceCategory(base);
          return base;
        });
        setSpaces(list);
      },
      (err) => {
        console.warn('Realtime spaces listener warning:', err);
      }
    );

    // 3. Listener em tempo real das reservas (`reservas`)
    const reservationsQuery = query(collection(db, 'reservas'), orderBy('createdAt', 'desc'));
    const unsubReservations = onSnapshot(
      reservationsQuery,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Reservation));
        setReservations(list);
        setLoading(false);
      },
      (err) => {
        console.warn('Realtime reservations listener warning:', err);
        setLoading(false);
      }
    );

    return () => {
      unsubUser();
      unsubSpaces();
      unsubReservations();
    };
  }, [authUser?.id]);

  /**
   * Atualiza diretamente o telefone/WhatsApp (sanitizado + formatado) e a chave de preferência no Firestore.
   */
  const updateWhatsAppPreferences = useCallback(
    async (rawPhone: string, whatsappNotificationsEnabled: boolean) => {
      if (!authUser?.id) {
        throw new Error('Usuário não autenticado.');
      }

      const validation = validatePhoneNumber(rawPhone);
      if (!validation.isValid) {
        throw new Error(validation.error || 'Número de WhatsApp inválido.');
      }

      const now = Date.now();
      try {
        await updateDoc(doc(db, 'users', authUser.id), {
          phone: validation.sanitized,
          phoneFormatted: validation.formatted,
          whatsappNotificationsEnabled,
          updatedAt: now,
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${authUser.id}`);
      }
    },
    [authUser?.id]
  );

  return {
    profile,
    spaces,
    reservations,
    loading,
    updateWhatsAppPreferences,
  };
}
