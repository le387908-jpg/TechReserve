/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '../services/firebase/config';
import { useAuthStore } from '../store/useAuthStore';
import { useReservationStore } from '../store/useReservationStore';
import { createSafeLocalDateTime, getTodayLocalISO } from '../utils/dateUtils';
import {
  canReceiveWhatsAppAlerts,
  notifyUpcomingReservationReminder,
  notifyVacateWarning10Min,
} from '../services/whatsappService';

const REMINDER_BEFORE_START_MS = 15 * 60 * 1000; // 15 minutos antes do início
const VACATE_WARNING_BEFORE_END_MS = 10 * 60 * 1000; // 10 minutos antes do término oficial do bloco
const DEDUP_STORAGE_KEY = 'techreserve_whatsapp_sent_events_v1';

function getLocalSentSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DEDUP_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function markLocalSent(eventKey: string): void {
  try {
    const current = getLocalSentSet();
    current.add(eventKey);
    // Mantém apenas os últimos 200 identificadores para armazenamento enxuto
    const trimmed = Array.from(current).slice(-200);
    localStorage.setItem(DEDUP_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignora caso localStorage esteja indisponível
  }
}

/**
 * Monitora em tempo real o ciclo de vida das reservas do usuário autenticado para disparar:
 * 1. Lembrete prévio antes do horário de início (15 min antes);
 * 2. Alerta de Desocupação faltando 10 minutos para o término oficial do bloco (ex.: 50 min).
 */
export function useWhatsAppReservationAlerts(): void {
  const user = useAuthStore((state) => state.user);
  const reservations = useReservationStore((state) => state.reservations);
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;

    const evaluateLifecycleAlerts = async () => {
      const eligibility = canReceiveWhatsAppAlerts(user);
      if (!eligibility.allowed) return;

      const now = new Date();
      const nowMs = now.getTime();
      const todayISO = getTodayLocalISO(now);
      const sentSet = getLocalSentSet();

      const myTodayReservations = reservations.filter(
        (r) =>
          r.usuarioId === user.id &&
          r.data === todayISO &&
          (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
      );

      for (const res of myTodayReservations) {
        const startMs = createSafeLocalDateTime(res.data, res.inicio).getTime();
        const endMs = createSafeLocalDateTime(res.data, res.fim).getTime();

        // 1. Lembrete prévio (dentro da janela de 15 minutos antes do início)
        const timeUntilStart = startMs - nowMs;
        const startEventKey = `start_reminder:${res.id}`;

        if (
          timeUntilStart > 0 &&
          timeUntilStart <= REMINDER_BEFORE_START_MS &&
          !res.whatsappLembreteInicioEnviado &&
          !sentSet.has(startEventKey) &&
          !inFlightRef.current.has(startEventKey)
        ) {
          inFlightRef.current.add(startEventKey);
          markLocalSent(startEventKey);

          try {
            const minsRemaining = Math.max(1, Math.ceil(timeUntilStart / 60000));
            await notifyUpcomingReservationReminder(user, res, minsRemaining);
            await updateDoc(doc(db, 'reservas', res.id), {
              whatsappLembreteInicioEnviado: true,
              updatedAt: Date.now(),
            });
          } catch (err) {
            console.warn('Falha ao registrar lembrete prévio de WhatsApp:', err);
          } finally {
            inFlightRef.current.delete(startEventKey);
          }
        }

        // 2. Alerta de Desocupação faltando 10 minutos para o término oficial do bloco
        const timeUntilEnd = endMs - nowMs;
        const vacateEventKey = `vacate_10min:${res.id}`;

        if (
          res.status === 'CONFIRMADA' &&
          nowMs >= startMs &&
          timeUntilEnd > 0 &&
          timeUntilEnd <= VACATE_WARNING_BEFORE_END_MS &&
          !res.whatsappAlertaDesocupacaoEnviado &&
          !sentSet.has(vacateEventKey) &&
          !inFlightRef.current.has(vacateEventKey)
        ) {
          inFlightRef.current.add(vacateEventKey);
          markLocalSent(vacateEventKey);

          try {
            await notifyVacateWarning10Min(user, res);
            await updateDoc(doc(db, 'reservas', res.id), {
              whatsappAlertaDesocupacaoEnviado: true,
              updatedAt: Date.now(),
            });
            toast.info(
              `Alerta de desocupação enviado via WhatsApp: faltam cerca de 10 minutos para liberar ${res.salaNome}.`
            );
          } catch (err) {
            console.warn('Falha ao registrar alerta de desocupação de 10 min:', err);
          } finally {
            inFlightRef.current.delete(vacateEventKey);
          }
        }
      }
    };

    evaluateLifecycleAlerts();
    const interval = setInterval(evaluateLifecycleAlerts, 10000);
    return () => clearInterval(interval);
  }, [user, reservations]);
}
