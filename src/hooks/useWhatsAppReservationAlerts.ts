/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '../services/firebase/config';
import { hydrateUserDocument } from '../services/authService';
import { useAuthStore } from '../store/useAuthStore';
import { useReservationStore } from '../store/useReservationStore';
import { User } from '../types';
import { createSafeLocalDateTime, getTodayLocalISO } from '../utils/dateUtils';
import {
  canReceiveWhatsAppAlerts,
  notifyReservationConfirmed,
  notifyUpcomingReservationReminder,
  notifyVacateWarning10Min,
} from '../services/whatsappService';

const REMINDER_BEFORE_START_MS = 10 * 60 * 1000; // 10 minutos antes do início
const VACATE_WARNING_BEFORE_END_MS = 10 * 60 * 1000; // 10 minutos antes do término oficial do bloco
const RETRY_COOLDOWN_MS = 60 * 1000; // 60s de espera antes de tentar reenviar em caso de falha temporária
const SKIPPED_COOLDOWN_MS = 5 * 60 * 1000; // 5 min caso usuário esteja sem telefone ou com alertas silenciados
const USER_CACHE_TTL_MS = 2 * 60 * 1000;
const DEDUP_STORAGE_KEY = 'techreserve_whatsapp_delivered_events_v2';

function getLocalDeliveredSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(DEDUP_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function markLocalDelivered(eventKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    const current = getLocalDeliveredSet();
    current.add(eventKey);
    const trimmed = Array.from(current).slice(-250);
    window.sessionStorage.setItem(DEDUP_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignora caso sessionStorage esteja indisponível
  }
}

/**
 * Monitora em tempo real o ciclo de vida das reservas para disparar:
 * 1. Confirmações pendentes caso o Gateway WhatsApp estivesse reconectando no instante da criação;
 * 2. Lembrete prévio antes do horário de início (10 min antes);
 * 3. Alerta de Desocupação faltando 10 minutos para o término oficial do bloco.
 *
 * Para perfis `USUARIO`, monitora exclusivamente suas próprias reservas.
 * Para perfis `ADMIN`, auxilia o envio também para reservas de alunos/servidores do dia que fecharam o navegador.
 */
export function useWhatsAppReservationAlerts(): void {
  const user = useAuthStore((state) => state.user);
  const reservations = useReservationStore((state) => state.reservations);
  const inFlightRef = useRef<Set<string>>(new Set());
  const retryAfterRef = useRef<Map<string, number>>(new Map());
  const userCacheRef = useRef<Map<string, { profile: User; expiresAt: number }>>(new Map());

  useEffect(() => {
    if (!user) return;

    const resolveTargetUser = async (usuarioId: string): Promise<User | null> => {
      if (usuarioId === user.id && (user.phone || user.phoneFormatted)) {
        return user;
      }
      if (usuarioId !== user.id && user.role !== 'ADMIN') return null;

      const nowMs = Date.now();
      const cached = userCacheRef.current.get(usuarioId);
      if (cached && cached.expiresAt > nowMs) {
        return cached.profile;
      }

      try {
        const snap = await getDoc(doc(db, 'users', usuarioId));
        if (!snap.exists()) return usuarioId === user.id ? user : null;
        const hydrated = hydrateUserDocument(snap.data(), snap.id);
        userCacheRef.current.set(usuarioId, {
          profile: hydrated,
          expiresAt: nowMs + USER_CACHE_TTL_MS,
        });
        return hydrated;
      } catch (err) {
        console.error('[WhatsApp Alertas] Erro ao consultar perfil do usuário no Firestore:', err);
        return usuarioId === user.id ? user : null;
      }
    };

    const isCoolingDown = (eventKey: string, nowMs: number): boolean => {
      const retryAfter = retryAfterRef.current.get(eventKey);
      if (!retryAfter) return false;
      if (nowMs >= retryAfter) {
        retryAfterRef.current.delete(eventKey);
        return false;
      }
      return true;
    };

    const evaluateLifecycleAlerts = async () => {
      const now = new Date();
      const nowMs = now.getTime();
      const todayISO = getTodayLocalISO(now);
      const deliveredSet = getLocalDeliveredSet();
      const isAdmin = user.role === 'ADMIN';

      const activeReservations = reservations.filter((r) => {
        if (r.status !== 'PENDENTE' && r.status !== 'CONFIRMADA') return false;
        if (!isAdmin && r.usuarioId !== user.id) return false;
        return r.data >= todayISO;
      });

      for (const res of activeReservations) {
        const startMs = createSafeLocalDateTime(res.data, res.inicio).getTime();
        const endMs = createSafeLocalDateTime(res.data, res.fim).getTime();
        if (endMs <= nowMs) continue;

        // 0. Retentativa automática de Confirmação caso não tenha sido entregue na criação (ex.: até 30 min após agendar)
        const confirmEventKey = `confirm:${res.id}`;
        const createdRecently = !res.createdAt || nowMs - res.createdAt <= 30 * 60 * 1000;
        if (
          res.whatsappConfirmacaoEnviada === false &&
          createdRecently &&
          !deliveredSet.has(confirmEventKey) &&
          !inFlightRef.current.has(confirmEventKey) &&
          !isCoolingDown(confirmEventKey, nowMs)
        ) {
          inFlightRef.current.add(confirmEventKey);
          try {
            const targetUser = await resolveTargetUser(res.usuarioId);
            const eligibility = canReceiveWhatsAppAlerts(targetUser);
            if (!targetUser || !eligibility.allowed) {
              retryAfterRef.current.set(confirmEventKey, nowMs + SKIPPED_COOLDOWN_MS);
            } else {
              const result = await notifyReservationConfirmed(targetUser, res);
              if (result.delivered) {
                markLocalDelivered(confirmEventKey);
                await updateDoc(doc(db, 'reservas', res.id), {
                  whatsappConfirmacaoEnviada: true,
                  updatedAt: Date.now(),
                });
              } else {
                retryAfterRef.current.set(confirmEventKey, nowMs + RETRY_COOLDOWN_MS);
              }
            }
          } catch (err) {
            retryAfterRef.current.set(confirmEventKey, nowMs + RETRY_COOLDOWN_MS);
            console.warn('Falha ao reenviar confirmação de WhatsApp:', err);
          } finally {
            inFlightRef.current.delete(confirmEventKey);
          }
        }

        // Lembretes de ciclo de vida aplicam-se exclusivamente às reservas da data de hoje
        if (res.data !== todayISO) continue;

        // 1. Lembrete prévio (dentro da janela de 10 minutos antes do início)
        const timeUntilStart = startMs - nowMs;
        const startEventKey = `start_reminder:${res.id}`;

        if (
          timeUntilStart > 0 &&
          timeUntilStart <= REMINDER_BEFORE_START_MS &&
          !res.whatsappLembreteInicioEnviado &&
          !deliveredSet.has(startEventKey) &&
          !inFlightRef.current.has(startEventKey) &&
          !isCoolingDown(startEventKey, nowMs)
        ) {
          inFlightRef.current.add(startEventKey);

          try {
            const targetUser = await resolveTargetUser(res.usuarioId);
            const eligibility = canReceiveWhatsAppAlerts(targetUser);
            if (!targetUser || !eligibility.allowed) {
              retryAfterRef.current.set(startEventKey, nowMs + SKIPPED_COOLDOWN_MS);
            } else {
              const minsRemaining = Math.min(
                10,
                Math.max(1, Math.ceil(timeUntilStart / 60000))
              );
              console.log('[WhatsApp Alertas][Lembrete 10 min] Disparando lembrete de início:', {
                reservaId: res.id,
                usuarioId: targetUser.id,
                sala: res.salaNome,
                inicio: res.inicio,
                minsRemaining,
              });
              const result = await notifyUpcomingReservationReminder(
                targetUser,
                res,
                minsRemaining
              );

              if (result.delivered) {
                markLocalDelivered(startEventKey);
                await updateDoc(doc(db, 'reservas', res.id), {
                  whatsappLembreteInicioEnviado: true,
                  updatedAt: Date.now(),
                });
              } else {
                console.error(
                  '[WhatsApp Alertas][Lembrete 10 min] Falha no envio do lembrete:',
                  result
                );
                retryAfterRef.current.set(startEventKey, nowMs + RETRY_COOLDOWN_MS);
              }
            }
          } catch (err) {
            retryAfterRef.current.set(startEventKey, nowMs + RETRY_COOLDOWN_MS);
            console.error('[WhatsApp Alertas] Exceção ao processar lembrete prévio:', err);
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
          !deliveredSet.has(vacateEventKey) &&
          !inFlightRef.current.has(vacateEventKey) &&
          !isCoolingDown(vacateEventKey, nowMs)
        ) {
          inFlightRef.current.add(vacateEventKey);

          try {
            const targetUser = await resolveTargetUser(res.usuarioId);
            const eligibility = canReceiveWhatsAppAlerts(targetUser);
            if (!targetUser || !eligibility.allowed) {
              retryAfterRef.current.set(vacateEventKey, nowMs + SKIPPED_COOLDOWN_MS);
            } else {
              console.log('[WhatsApp Alertas][Desocupação 10 min] Disparando alerta:', {
                reservaId: res.id,
                usuarioId: targetUser.id,
                sala: res.salaNome,
                fim: res.fim,
              });
              const result = await notifyVacateWarning10Min(targetUser, res);

              if (result.delivered) {
                markLocalDelivered(vacateEventKey);
                await updateDoc(doc(db, 'reservas', res.id), {
                  whatsappAlertaDesocupacaoEnviado: true,
                  updatedAt: Date.now(),
                });
                if (targetUser.id === user.id) {
                  toast.info(
                    `Alerta de desocupação enviado via WhatsApp: faltam cerca de 10 minutos para liberar ${res.salaNome}.`
                  );
                }
              } else {
                console.error(
                  '[WhatsApp Alertas][Desocupação 10 min] Falha no envio:',
                  result
                );
                retryAfterRef.current.set(vacateEventKey, nowMs + RETRY_COOLDOWN_MS);
              }
            }
          } catch (err) {
            retryAfterRef.current.set(vacateEventKey, nowMs + RETRY_COOLDOWN_MS);
            console.error('[WhatsApp Alertas] Exceção ao processar alerta de desocupação:', err);
          } finally {
            inFlightRef.current.delete(vacateEventKey);
          }
        }
      }
    };

    void evaluateLifecycleAlerts();
    const interval = setInterval(() => {
      void evaluateLifecycleAlerts();
    }, 10000);
    return () => clearInterval(interval);
  }, [user, reservations]);
}
