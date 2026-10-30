/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  AlertTriangle, 
  Clock, 
  QrCode, 
  X, 
  CheckCircle2,
  AlertCircle,
  Bell
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useReservationStore } from '../store/useReservationStore';
import { useAuthStore } from '../store/useAuthStore';
import { useRoomStore } from '../store/useRoomStore';
import { formatNoShowTag } from '../services/reservationService';
import { formatDataBR, getTodayLocalISO } from '../utils/dateUtils';
import { getFriendlyErrorMessage } from '../services/firebase/utils';
import { QRScanner } from './QRScanner';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

export function GlobalAlert() {
  const { user } = useAuthStore();
  const { 
    reservations, 
    updateReservation, 
    checkIn, 
    scanningResId, 
    setScanningResId,
    processMissedCheckIns
  } = useReservationStore();
  const { rooms } = useRoomStore();
  
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const safeReservations = useMemo(
    () => (Array.isArray(reservations) ? reservations.filter(Boolean) : []),
    [reservations]
  );
  const safeRooms = useMemo(
    () => (Array.isArray(rooms) ? rooms.filter(Boolean) : []),
    [rooms]
  );

  useEffect(() => {
    void Promise.resolve(processMissedCheckIns()).catch(() => {});
    const interval = setInterval(() => {
      void Promise.resolve(processMissedCheckIns()).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [processMissedCheckIns]);

  // Verifica punição de No-Show estritamente para o usuário logado e apenas na data de hoje (Regra do Dia Faltante)
  const todayISO = useMemo(() => getTodayLocalISO(), [now]);
  const activePunishmentRes = useMemo(() => {
    if (!user?.id || user?.role === 'ADMIN') return null;
    return (
      safeReservations.find(
        (r) =>
          r?.usuarioId === user.id &&
          r?.status === 'PUNIDA' &&
          (r?.blockedDate || r?.data) === todayISO
      ) || null
    );
  }, [safeReservations, user, todayISO]);

  // Find pending check-in (within 5-minute check-in window)
  const pendingCheckInRes = useMemo(() => {
    if (!user?.id || user?.role !== 'USUARIO' || activePunishmentRes) return null;
    return safeReservations.find(
      (r) =>
        r?.usuarioId === user.id &&
        r?.status === 'PENDENTE' &&
        Boolean(r?.checkInExpiracao) &&
        (r.checkInExpiracao as number) > now &&
        (r.checkInExpiracao as number) - now <= 5 * 60 * 1000
    );
  }, [safeReservations, user, now, activePunishmentRes]);

  // Find active ongoing confirmed/checked-in reservation today
  const activeConfirmedRes = useMemo(() => {
    if (!user?.id) return null;
    const todayStr = getTodayLocalISO();
    return safeReservations.find(
      (r) =>
        r?.usuarioId === user.id &&
        r?.status === 'CONFIRMADA' &&
        Boolean(r?.checkInRealizado) &&
        r?.data === todayStr
    );
  }, [safeReservations, user]);

  const activeConfirmedTimeLeft = useMemo(() => {
    if (
      !activeConfirmedRes?.data ||
      !activeConfirmedRes?.fim ||
      !activeConfirmedRes?.inicio
    ) {
      return 0;
    }
    const [year, month, day] = activeConfirmedRes.data.split('-').map(Number);
    const [startHour, startMin] = activeConfirmedRes.inicio.split(':').map(Number);
    const [endHour, endMin] = activeConfirmedRes.fim.split(':').map(Number);
    if (
      isNaN(year) ||
      isNaN(month) ||
      isNaN(day) ||
      isNaN(startHour) ||
      isNaN(startMin) ||
      isNaN(endHour) ||
      isNaN(endMin)
    ) {
      return 0;
    }
    const startTime = new Date(year, month - 1, day, startHour, startMin).getTime();
    const endTime = new Date(year, month - 1, day, endHour, endMin).getTime();

    if (now < startTime || now > endTime) return 0;

    return Math.max(0, endTime - now);
  }, [activeConfirmedRes, now]);

  // Find admin pending reservations waiting for confirmation (can display right after booking)
  const adminPendingConfirmationRes = useMemo(() => {
    if (!user?.id || user?.role !== 'ADMIN') return null;
    return safeReservations.find(
      (r) =>
        r?.usuarioId === user.id &&
        r?.status === 'PENDENTE' &&
        !r?.checkInRealizado
    );
  }, [safeReservations, user]);

  // Find admin's pending or confirmed reservations to alert them
  const adminReminderRes = useMemo(() => {
    if (!user?.id || user?.role !== 'ADMIN') return null;

    const adminReservations = safeReservations.filter(
      (r) => r?.usuarioId === user.id && r?.status === 'CONFIRMADA'
    );

    for (const res of adminReservations) {
      if (!res.data || !res.inicio || !res.fim) continue;

      const [year, month, day] = res.data.split('-').map(Number);
      const [startHour, startMin] = res.inicio.split(':').map(Number);
      const [endHour, endMin] = res.fim.split(':').map(Number);

      if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(startHour) || isNaN(startMin) || isNaN(endHour) || isNaN(endMin)) {
        continue;
      }

      const startTime = new Date(year, month - 1, day, startHour, startMin).getTime();
      const endTime = new Date(year, month - 1, day, endHour, endMin).getTime();

      const fifteenMins = 15 * 60 * 1000;
      const tenMins = 10 * 60 * 1000;

      const isStartNear = now >= (startTime - fifteenMins) && now < (startTime + tenMins);
      const isEndNear = now >= (endTime - fifteenMins) && now < endTime;

      if (isStartNear) {
        return {
          res,
          type: 'START_NEAR' as const,
          startTime,
          endTime,
          roomName: res.salaNome,
          timeStr: res.inicio
        };
      } else if (isEndNear) {
        return {
          res,
          type: 'END_NEAR' as const,
          startTime,
          endTime,
          roomName: res.salaNome,
          timeStr: res.fim
        };
      }
    }
    return null;
  }, [safeReservations, user, now]);

  const handleScan = async (scannedRoomId: string) => {
    if (!scanningResId) return;

    const res = safeReservations.find((r) => r?.id === scanningResId);
    if (!res) return;

    const room = safeRooms.find((r) => r?.firestoreId === res.salaId);
    if (!room) return;

    const safeScanned = String(scannedRoomId || '').trim();
    let normalizedScanned = safeScanned;
    if (safeScanned.startsWith('TECHRESERVE:')) {
      const parts = safeScanned.split(':');
      normalizedScanned = parts[2] ? safeScanned.substring(13) : parts[1] || '';
    }

    if (res.checkInRealizado || res.status === 'CONFIRMADA') {
      toast.error('erro no check-in, código QR incompatível com sua reserva atual', {
        icon: <AlertCircle className="h-5 w-5 text-fatec-red" />,
      });
      setScanningResId(null);
      return;
    }

    if (
      normalizedScanned === room.id ||
      normalizedScanned === room.codigo ||
      normalizedScanned === room.firestoreId
    ) {
      try {
        await checkIn(res.id);
        toast.success('Check-in realizado com sucesso!', {
          icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
        });
        setScanningResId(null);
      } catch (err) {
        toast.error(getFriendlyErrorMessage(err, 'Erro ao realizar check-in.'));
      }
    } else {
      toast.error('erro ao realizar check-in, Código QR inválido para esta sala', {
        icon: <AlertCircle className="h-5 w-5 text-fatec-red" />,
      });
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await updateReservation(id, { status: 'CANCELADA' });
      toast.success('Reserva cancelada com sucesso.');
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao cancelar reserva.'));
    }
  };

  const handleFinishConfirmed = async (id: string) => {
    try {
      const nextStatus = user?.role === 'ADMIN' ? 'CANCELADA' : 'CONCLUIDA';
      await updateReservation(id, { status: nextStatus });
      toast.success('Sessão encerrada e sala liberada.');
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao encerrar reserva.'));
    }
  };

  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  const currentAlertId = useMemo(() => {
    if (activePunishmentRes) return activePunishmentRes.id;
    if (adminPendingConfirmationRes) return adminPendingConfirmationRes.id;
    if (pendingCheckInRes) return pendingCheckInRes.id;
    if (activeConfirmedRes && activeConfirmedTimeLeft > 0) return `${activeConfirmedRes.id}-active`;
    if (adminReminderRes) return `${adminReminderRes.res.id}-${adminReminderRes.type}`;
    return null;
  }, [activePunishmentRes, adminPendingConfirmationRes, pendingCheckInRes, activeConfirmedRes, activeConfirmedTimeLeft, adminReminderRes]);

  if (currentAlertId && dismissedAlerts.has(currentAlertId)) {
    const isAdminPending = adminPendingConfirmationRes && currentAlertId === adminPendingConfirmationRes.id;
    if (!isAdminPending) {
      return null;
    }
  }

  const handleDismiss = () => {
    if (currentAlertId) {
      // Prevent dismissing administrator pending confirmation
      if (adminPendingConfirmationRes && currentAlertId === adminPendingConfirmationRes.id) {
        return;
      }
      setDismissedAlerts(prev => {
        const next = new Set(prev);
        next.add(currentAlertId);
        return next;
      });
    }
  };

  return (
    <>
      <AnimatePresence>
        {scanningResId && (
          <QRScanner onScan={handleScan} onClose={() => setScanningResId(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(pendingCheckInRes || activePunishmentRes || adminPendingConfirmationRes || adminReminderRes || (activeConfirmedRes && activeConfirmedTimeLeft > 0)) && (
          <motion.div
            initial={{ y: 100, opacity: 0, scale: 0.9 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 100, opacity: 0, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-50 w-[320px] max-w-[calc(100vw-48px)] p-1 bg-white shadow-2xl rounded-3xl border border-slate-100"
          >
            {activePunishmentRes ? (
              <div className="overflow-hidden rounded-2xl bg-red-50 border border-red-100 relative">
                <button 
                  onClick={handleDismiss}
                  className="absolute top-2 right-2 p-1.5 text-white/70 hover:text-white transition-colors z-10 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="bg-fatec-red px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-white" />
                    <span className="text-white text-xs font-bold">Bloqueio do Dia por No-Show</span>
                  </div>
                </div>
                <div className="p-4 space-y-2">
                  <p className="text-xs font-bold text-slate-900 leading-snug">
                    {formatNoShowTag(activePunishmentRes.blockedDate || activePunishmentRes.data)}
                  </p>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Novas reservas estão bloqueadas apenas hoje devido à ausência de check-in. Datas futuras e sua cota semanal permanecem liberadas.
                  </p>
                </div>
              </div>
            ) : adminPendingConfirmationRes ? (
              <div className="overflow-hidden rounded-2xl bg-amber-50 border border-amber-100 relative text-slate-800">
                <div className="bg-amber-500 px-4 py-2.5 flex items-center justify-between font-bold">
                  <div className="flex items-center gap-2 animate-pulse">
                    <Clock className="h-4 w-4 text-white animate-spin-slow" />
                    <span className="text-white text-[10px] font-black uppercase tracking-widest leading-none">Reserva Aguardando Confirmação</span>
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <p className="text-[10px] font-black text-amber-600 uppercase tracking-tighter mb-1">Status da Reserva:</p>
                    <p className="text-sm font-black text-slate-900 leading-snug">
                      Reserva aguardando confirmação...
                    </p>
                    <p className="text-[11px] font-semibold text-slate-500 mt-2">
                      Sala: <span className="font-extrabold text-slate-800">{adminPendingConfirmationRes?.salaNome || 'Ambiente'}</span>
                    </p>
                    <p className="text-[10px] font-medium text-slate-400">
                      Horário: {formatDataBR(adminPendingConfirmationRes?.data)} ({adminPendingConfirmationRes?.inicio || '--:--'} - {adminPendingConfirmationRes?.fim || '--:--'})
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          await updateReservation(adminPendingConfirmationRes.id, {
                            status: 'CONFIRMADA',
                            checkInRealizado: true
                          });
                          toast.success('Reserva confirmada com sucesso!', {
                            icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                          });
                        } catch (err) {
                          toast.error(getFriendlyErrorMessage(err, 'Erro ao confirmar reserva.'));
                        }
                      }}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-amber-100 font-bold"
                    >
                      <CheckCircle2 className="h-4 w-4 text-white" />
                      Confirmar Reserva
                    </button>
                    <button
                      onClick={() => handleCancel(adminPendingConfirmationRes.id)}
                      className="bg-white border border-slate-200 text-slate-500 hover:text-fatec-red hover:border-fatec-red/20 py-2.5 px-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 text-center flex items-center justify-center gap-1 font-bold"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            ) : pendingCheckInRes ? (
              <div className="overflow-hidden rounded-2xl bg-amber-50 border border-amber-100 relative">
                <button 
                  onClick={handleDismiss}
                  className="absolute top-2 right-2 p-1.5 text-white/50 hover:text-white transition-colors z-10"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="bg-amber-500 px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-white" />
                    <span className="text-white text-[10px] font-black uppercase tracking-widest">Check-in Necessário</span>
                  </div>
                  <div className="text-white font-mono text-sm font-black mr-6">
                    {Math.floor((pendingCheckInRes.checkInExpiracao! - now) / 60000)}:
                    {String(Math.floor(((pendingCheckInRes.checkInExpiracao! - now) % 60000) / 1000)).padStart(2, '0')}
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <p className="text-[10px] font-black text-amber-600 uppercase tracking-tighter mb-1">Local da Reserva:</p>
                    <p className="text-sm font-bold text-slate-900">
                      {safeRooms.find((r) => r?.firestoreId === pendingCheckInRes?.salaId)?.nome || pendingCheckInRes?.salaNome || 'Sua Sala'}
                    </p>
                    <p className="text-[10px] font-medium text-slate-400">
                      Expira em breve! Realize o check-in agora.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setScanningResId(pendingCheckInRes.id)}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-amber-100"
                    >
                      <QrCode className="h-3.5 w-3.5" />
                      Check-in
                    </button>
                    <button
                      onClick={() => handleCancel(pendingCheckInRes.id)}
                      className="bg-white border border-slate-200 text-slate-400 hover:text-fatec-red hover:border-fatec-red/20 py-2.5 px-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            ) : activeConfirmedRes && activeConfirmedTimeLeft > 0 ? (
              <div className="overflow-hidden rounded-2xl bg-[#1A1A1A] border border-neutral-800 relative text-white">
                <button 
                  onClick={handleDismiss}
                  className="absolute top-2 right-2 p-1.5 text-white/50 hover:text-white transition-colors z-10"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="bg-fatec-red px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-white animate-pulse" />
                    <span className="text-white text-[10px] font-black uppercase tracking-widest leading-none">Sua reserva termina em...</span>
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div className="text-center">
                    <p className="text-3xl font-black font-mono text-white tracking-widest mt-1">
                      {Math.floor(activeConfirmedTimeLeft / 3600000) > 0 ? `${String(Math.floor(activeConfirmedTimeLeft / 3600000)).padStart(2, '0')}:` : ''}
                      {String(Math.floor((activeConfirmedTimeLeft % 3600000) / 60000)).padStart(2, '0')}:
                      {String(Math.floor((activeConfirmedTimeLeft % 60000) / 1000)).padStart(2, '0')}
                    </p>
                    <p className="text-[10px] font-semibold text-neutral-300 mt-2">
                      Sala: <span className="font-extrabold text-white">{activeConfirmedRes.salaNome}</span> ({activeConfirmedRes.salaInstitutionalId})
                    </p>
                  </div>

                  <button
                    onClick={() => handleFinishConfirmed(activeConfirmedRes.id)}
                    className="w-full bg-fatec-red hover:bg-fatec-red/80 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-red-950/40 cursor-pointer"
                  >
                    Terminar Reserva e Liberar Sala
                  </button>
                </div>
              </div>
            ) : adminReminderRes ? (
              <div className="overflow-hidden rounded-2xl bg-slate-900 text-white border border-slate-800 relative">
                <button 
                  onClick={handleDismiss}
                  className="absolute top-2 right-2 p-1.5 text-white/50 hover:text-white transition-colors z-10"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-white animate-bounce" />
                    <span className="text-white text-[10px] font-black uppercase tracking-widest">Lembrete de Reserva</span>
                  </div>
                  <div className="bg-indigo-900/60 text-indigo-200 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
                    ADM
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-tighter mb-1">
                      {adminReminderRes.type === 'START_NEAR' ? 'Seu horário está próximo:' : 'Seu horário está se encerrando:'}
                    </p>
                    <p className="text-sm font-black text-white">
                      {adminReminderRes.roomName}
                    </p>
                    <p className="text-[11px] font-medium text-slate-300 mt-1 leading-snug">
                      {adminReminderRes.type === 'START_NEAR' 
                        ? `A sua reserva começará às ${adminReminderRes.timeStr}. Como administrador, você não precisa realizar o check-in.`
                        : `Sua reserva na sala encerrará em breve, às ${adminReminderRes.timeStr}. Certifique-se de liberar o ambiente.`
                      }
                    </p>
                  </div>

                  <button
                    onClick={() => handleCancel(adminReminderRes.res.id)}
                    className="w-full bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-red-900/50"
                  >
                    Cancelar Reserva
                  </button>
                </div>
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
