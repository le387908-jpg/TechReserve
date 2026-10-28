/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Calendar, 
  Clock, 
  MapPin, 
  User as UserIcon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Trash2,
  CalendarCheck2,
  Building2,
  ArrowRight,
  QrCode,
  Timer,
  Search,
  Plus,
  Filter,
  Users,
  Sparkles,
  Info,
  ShieldCheck,
  Laptop,
  Tv,
  Wind,
  Layers,
  GraduationCap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../services/firebase/config';
import { useReservationStore } from '../../store/useReservationStore';
import { useRoomStore } from '../../store/useRoomStore';
import { useAuthStore } from '../../store/useAuthStore';
import { usePunishmentStore } from '../../store/usePunishmentStore';
import {
  checkWeeklyQuotaLocal,
  formatNoShowTag,
  getUserNoShowBlockedDate,
} from '../../services/reservationService';
import { Reservation, ReservationStatus } from '../../types';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { getTodayLocalISO, formatDataBR, createSafeLocalDateTime } from '../../utils/dateUtils';

function UsageTimer({ resId, data, inicio, fim, isConfirmed, onCancel }: { resId: string, data: string, inicio: string, fim: string, isConfirmed: boolean, onCancel: () => void }) {
  const [current, setCurrent] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setCurrent(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const start = createSafeLocalDateTime(data, inicio).getTime();
  const end = createSafeLocalDateTime(data, fim).getTime();

  if (!isConfirmed || current < start || current > end) return null;

  const remainingMs = end - current;

  const format = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="mt-4 bg-[#1A1A1A] border border-neutral-800 text-white p-5 rounded-2xl flex flex-col gap-4 shadow-xl shadow-slate-200">
      <div className="flex flex-col items-center text-center">
        <p className="text-xs text-rose-400 font-bold uppercase tracking-wide mb-1">sua reserva termina em...</p>
        <div className="flex items-center gap-2 mt-1">
          <Timer className="h-5 w-5 text-fatec-red animate-pulse" />
          <span className="text-3xl font-black font-mono text-white tracking-widest">{format(remainingMs)}</span>
        </div>
      </div>
      <button
        onClick={onCancel}
        className="w-full bg-fatec-red hover:bg-fatec-red/80 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-red-950/40"
      >
        Terminar Reserva e Liberar Sala
      </button>
    </div>
  );
}

function CheckInCounter({ expiration, onReady }: { expiration: number, onReady: (ready: boolean) => void }) {
  const [current, setCurrent] = useState(Date.now());
  const [lastReady, setLastReady] = useState<boolean | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setCurrent(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const diff = expiration - current;

  // Show during the 5-minute check-in window prior to expiration
  const isNear = diff > 0 && diff <= 5 * 60 * 1000;
  const isReady = diff > 0 && isNear;
  
  useEffect(() => {
    if (isReady !== lastReady) {
      onReady(isReady);
      setLastReady(isReady);
    }
  }, [isReady, lastReady, onReady]);

  if (!isNear) return null;

  const seconds = Math.floor(diff / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;

  return (
    <div className="bg-amber-500 text-white px-4 py-2 rounded-xl flex items-center gap-2 mb-4 animate-bounce">
      <Clock className="h-4 w-4" />
      <p className="text-[10px] font-black uppercase tracking-tighter">
        Check-in expira em: <span className="font-mono">{m}:{s < 10 ? `0${s}` : s}</span>
      </p>
    </div>
  );
}

function NoShowDayNotice({ dateISO }: { dateISO: string }) {
  return (
    <div className="mt-4 bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-start gap-3">
      <div className="h-9 w-9 rounded-xl bg-white border border-rose-200 flex items-center justify-center text-fatec-red shrink-0">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="space-y-1 text-xs">
        <p className="font-bold text-rose-950">{formatNoShowTag(dateISO)}</p>
        <p className="text-rose-800 leading-relaxed">
          Reserva cancelada automaticamente por ausência de check-in presencial em 5 minutos. O bloqueio vale exclusivamente para esta data e sua cota semanal permanece liberada para outros dias.
        </p>
      </div>
    </div>
  );
}

function calculateDuration(inicio: string, fim: string): string {
  try {
    const [h1, m1] = inicio.split(':').map(Number);
    const [h2, m2] = fim.split(':').map(Number);
    const diffMins = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (diffMins <= 0) return 'Período padrão';
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    if (hours === 0) return `${mins} min`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}min`;
  } catch {
    return '1h 40min';
  }
}

export function ReservasPage() {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const reservations = useReservationStore(state => state.reservations);
  const fetchReservations = useReservationStore(state => state.fetchReservations);
  const updateReservation = useReservationStore(state => state.updateReservation);
  const deleteReservation = useReservationStore(state => state.deleteReservation);
  const hideForUser = useReservationStore(state => state.hideForUser);
  const setScanningResId = useReservationStore(state => state.setScanningResId);
  
  const rooms = useRoomStore(state => state.rooms);
  const fetchRooms = useRoomStore(state => state.fetchRooms);
  const activePunishment = usePunishmentStore(state => state.activePunishment);
  const fetchUserPunishments = usePunishmentStore(state => state.fetchUserPunishments);
  const isAdmin = user?.role === 'ADMIN';

  // Expansion & Filter State
  const [scope, setScope] = useState<'MINHAS' | 'TODAS'>('MINHAS');
  const [statusTab, setStatusTab] = useState<'TODAS' | 'ATIVAS' | 'HOJE' | 'HISTORICO'>('TODAS');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [readyReservations, setReadyReservations] = useState<Record<string, boolean>>({});
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  // Users cache for showing requester name in admin mode
  const [usersMap, setUsersMap] = useState<Record<string, { nome: string; email: string }>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSetReady = React.useCallback((id: string, ready: boolean) => {
    setReadyReservations(prev => {
      if (prev[id] === ready) return prev;
      return { ...prev, [id]: ready };
    });
  }, []);

  useEffect(() => {
    const unsubRes = fetchReservations();
    const unsubRooms = fetchRooms();
    const unsubUserPunishments =
      user && !isAdmin ? fetchUserPunishments(user.id) : () => {};

    let unsubUsers: (() => void) | undefined;
    if (isAdmin) {
      unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        const map: Record<string, { nome: string; email: string }> = {};
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          map[doc.id] = {
            nome: data.nome || data.email?.split('@')[0] || 'Usuário Fatec',
            email: data.email || ''
          };
        });
        setUsersMap(map);
      }, (err) => {
        console.warn('Could not listen to users for reservations mapping:', err);
      });
    }
    
    return () => {
      unsubRes();
      unsubRooms();
      unsubUserPunishments();
      if (unsubUsers) unsubUsers();
    };
  }, [fetchReservations, fetchRooms, fetchUserPunishments, user?.id, isAdmin]);

  const handleCancel = async (id: string, status: ReservationStatus) => {
    setConfirmingCancelId(null);
    setCancellingIds(prev => new Set(prev).add(id));
    
    try {
      // REGRA 2: Se o usuário comum já compareceu (CONFIRMADA com check-in), liberar a sala conclui a reserva (CONCLUIDA),
      // mantendo o consumo da cota semanal. Apenas o cancelamento prévio (PENDENTE) define CANCELADA e restabelece a cota!
      const isFinishingAttendedSession = !isAdmin && status === 'CONFIRMADA';
      const nextStatus: ReservationStatus = isFinishingAttendedSession ? 'CONCLUIDA' : 'CANCELADA';

      await updateReservation(id, { status: nextStatus });

      if (isFinishingAttendedSession) {
        toast.success('Sessão encerrada e sala liberada. Sua cota de 1 reserva desta semana consta como concluída.');
      } else if (!isAdmin) {
        toast.success('Reserva cancelada previamente. Sua cota semanal de 1 reserva foi restabelecida.');
      } else {
        toast.success('Reserva cancelada com sucesso.');
      }
    } catch (err: any) {
      console.error('Cancel reservation error:', err);
      let errorMsg = 'Erro ao atualizar reserva. Verifique sua conexão.';
      try {
        if (err.message && err.message.startsWith('{')) {
          const errorData = JSON.parse(err.message);
          errorMsg = `Erro: ${errorData.error}`;
        }
      } catch (e) {
        console.error('Failed to parse error message:', e);
      }
      toast.error(errorMsg);
    } finally {
      setCancellingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const initiateCancel = (id: string, status: ReservationStatus) => {
    setConfirmingCancelId(id);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteReservation(id);
      setConfirmingDeleteId(null);
      toast.success('Registro excluído com sucesso.');
    } catch (err) {
      toast.error('Erro ao excluir registro.');
    }
  };

  const handleHide = async (id: string) => {
    try {
      await hideForUser(id);
      toast.success('Registro removido do seu histórico.');
    } catch (err) {
      toast.error('Erro ao remover registro.');
    }
  };

  // Base scope filtering
  const todayStr = getTodayLocalISO();

  const baseReservations = useMemo(() => {
    if (isAdmin && scope === 'TODAS') {
      return reservations;
    }
    return reservations.filter(r => r.usuarioId === user?.id && !r.ocultoParaUsuario);
  }, [reservations, isAdmin, scope, user?.id]);

  // Tab & Search filtering
  const filteredReservations = useMemo(() => {
    return baseReservations.filter(res => {
      const room = rooms.find(r => r.firestoreId === res.salaId);
      const roomName = room?.nome || 'Sala';
      const requester = usersMap[res.usuarioId]?.nome || res.usuarioId || '';

      // Status Tab filter
      if (statusTab === 'ATIVAS') {
        if (res.status !== 'CONFIRMADA' && res.status !== 'PENDENTE') return false;
      } else if (statusTab === 'HOJE') {
        if (res.data !== todayStr) return false;
      } else if (statusTab === 'HISTORICO') {
        if (res.status === 'CONFIRMADA' || res.status === 'PENDENTE') return false;
      }

      // Search term
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchesRoom = roomName.toLowerCase().includes(term);
        const matchesDate = res.data.includes(term);
        const matchesUser = requester.toLowerCase().includes(term);
        const matchesObs = (res.observacoes || '').toLowerCase().includes(term);
        if (!matchesRoom && !matchesDate && !matchesUser && !matchesObs) {
          return false;
        }
      }

      return true;
    });
  }, [baseReservations, statusTab, searchTerm, rooms, usersMap, todayStr]);

  // Metrics summary & Weekly Quota
  const metrics = useMemo(() => {
    const total = baseReservations.length;
    const ativas = baseReservations.filter(r => r.status === 'CONFIRMADA').length;
    const pendentes = baseReservations.filter(r => r.status === 'PENDENTE').length;
    const historico = baseReservations.filter(r => r.status === 'CONCLUIDA' || r.status === 'CANCELADA' || r.status === 'PUNIDA').length;
    return { total, ativas, pendentes, historico };
  }, [baseReservations]);

  const weeklyQuota = useMemo(() => {
    if (!user || isAdmin) return null;
    return checkWeeklyQuotaLocal(reservations, user.id, todayStr);
  }, [reservations, user, isAdmin, todayStr]);

  const userBlockedDate = useMemo(
    () =>
      !isAdmin
        ? getUserNoShowBlockedDate(user, activePunishment ? [activePunishment] : [])
        : null,
    [user, isAdmin, activePunishment]
  );

  return (
    <div className="space-y-6">
      {/* HEADER WITH EXPANSIVE CONTROLS */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span className="font-semibold text-fatec-red">TechReserve Fatec</span>
            {isAdmin && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-semibold text-slate-800">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  Painel ADM Ativo
                </span>
              </>
            )}
          </div>
          <h2 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
            {isAdmin && scope === 'TODAS' ? 'Gestão Geral de Reservas' : 'Minhas Reservas'}
          </h2>
          <p className="text-slate-500 text-xs md:text-sm">
            {isAdmin && scope === 'TODAS' 
              ? 'Supervisão ampla de todos os agendamentos institucionais da Fatec Franco da Rocha.'
              : 'Gerencie suas sessões de estudo, laboratórios agendados e check-ins com facilidade.'}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Quick action to book another room */}
          <button
            type="button"
            onClick={() => navigate('/salas')}
            className="px-4 py-2.5 rounded-2xl bg-fatec-red hover:bg-fatec-red/90 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Nova Reserva</span>
          </button>
        </div>
      </div>

      {/* BANNER DE COTA SEMANAL (1 RESERVA/SEMANA) E PUNIÇÃO DO DIA FALTANTE */}
      {!isAdmin && user && (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">Cota Semanal (Seg–Dom):</span>
              <span className="font-mono tabular-nums font-semibold">
                {weeklyQuota?.usedCount || 0}/1 reserva utilizada
              </span>
              {weeklyQuota && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-500">
                    Semana {weeklyQuota.weekBounds.startLabel} a {weeklyQuota.weekBounds.endLabel}
                  </span>
                </>
              )}
            </div>
            {weeklyQuota && !weeklyQuota.allowed ? (
              <p className="text-xs font-semibold text-amber-800">
                {weeklyQuota.error}{' '}
                {weeklyQuota.consumingReservation?.status === 'PENDENTE'
                  ? 'Se cancelar previamente antes do check-in, sua cota semanal será restabelecida.'
                  : 'Reserva desta semana já confirmada/concluída.'}
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                Você possui 1 reserva disponível nesta semana (cancelamentos prévios e faltas por No-Show liberam a cota semanal).
              </p>
            )}
          </div>

          {userBlockedDate && userBlockedDate >= todayStr && (
            <div className="px-3.5 py-2 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-center gap-2 shrink-0">
              <AlertTriangle className="h-4 w-4 text-fatec-red shrink-0" />
              <span className="font-semibold">{formatNoShowTag(userBlockedDate)}</span>
            </div>
          )}
        </div>
      )}

      {/* EXPANSIVE STATS METRIC CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-slate-200">
          <p className="text-xs font-semibold text-slate-500">Total de Registros</p>
          <p className="text-xl font-black font-mono tabular-nums text-slate-900 mt-1">{metrics.total}</p>
          <span className="text-[11px] text-slate-400">no escopo selecionado</span>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-emerald-100">
          <p className="text-xs font-semibold text-emerald-700">Confirmadas / Em Uso</p>
          <p className="text-xl font-black font-mono tabular-nums text-emerald-950 mt-1">{metrics.ativas}</p>
          <span className="text-[11px] text-emerald-600">sessões ativas</span>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-amber-100">
          <p className="text-xs font-semibold text-amber-700">Aguardando Check-in</p>
          <p className="text-xl font-black font-mono tabular-nums text-amber-950 mt-1">{metrics.pendentes}</p>
          <span className="text-[11px] text-amber-600">necessita confirmação</span>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-200">
          <p className="text-xs font-semibold text-slate-500">Histórico / Finalizadas</p>
          <p className="text-xl font-black font-mono tabular-nums text-slate-800 mt-1">{metrics.historico}</p>
          <span className="text-[11px] text-slate-400">sessões encerradas</span>
        </div>
      </div>

      {/* FILTER CONTROLS & EXPANSIVE SEARCH BAR */}
      <div className="bg-white rounded-3xl border border-slate-200 p-4 md:p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* TABS (Todas / Ativas / Hoje / Histórico) */}
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1.5 rounded-2xl border border-slate-200/80">
            <button
              type="button"
              onClick={() => setStatusTab('TODAS')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                statusTab === 'TODAS' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
              )}
            >
              <span>Todas</span>
              <span className="px-1.5 py-0.2 rounded-md bg-slate-200 text-slate-700 text-[10px] font-bold">
                {metrics.total}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setStatusTab('ATIVAS')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                statusTab === 'ATIVAS' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
              )}
            >
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>Ativas / Em Uso</span>
              <span className="px-1.5 py-0.2 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                {metrics.ativas + metrics.pendentes}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setStatusTab('HOJE')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                statusTab === 'HOJE' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
              )}
            >
              <Calendar className="h-3 w-3 text-slate-500" />
              <span>Hoje</span>
            </button>
            <button
              type="button"
              onClick={() => setStatusTab('HISTORICO')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                statusTab === 'HISTORICO' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
              )}
            >
              <span>Histórico</span>
              <span className="px-1.5 py-0.2 rounded-md bg-slate-200 text-slate-700 text-[10px] font-bold">
                {metrics.historico}
              </span>
            </button>
          </div>

          {/* ADMIN SCOPE SWITCHER */}
          {isAdmin && (
            <div className="flex items-center gap-1 bg-slate-900 text-white p-1 rounded-2xl self-start lg:self-auto shadow-sm">
              <button
                type="button"
                onClick={() => setScope('MINHAS')}
                className={cn(
                  "px-3 py-1.5 rounded-xl text-xs font-black transition-all",
                  scope === 'MINHAS' ? "bg-fatec-red text-white shadow-sm" : "text-slate-400 hover:text-white"
                )}
              >
                Minhas Reservas
              </button>
              <button
                type="button"
                onClick={() => setScope('TODAS')}
                className={cn(
                  "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                  scope === 'TODAS' ? "bg-fatec-red text-white shadow-sm" : "text-slate-400 hover:text-white"
                )}
              >
                <Users className="h-3.5 w-3.5" />
                <span>Todas da Fatec (ADM)</span>
              </button>
            </div>
          )}
        </div>

        {/* SEARCH & FILTERS BAR */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder={isAdmin && scope === 'TODAS' ? "Buscar por sala, solicitante, data ou observações..." : "Buscar por sala, data ou observações..."}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 hover:bg-slate-100/80 focus:bg-white border border-slate-200 rounded-2xl text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-fatec-red outline-none transition-all"
          />
        </div>
      </div>

      {/* RESERVATIONS LIST WITH ACCORDION EXPANSION */}
      <div className="grid grid-cols-1 gap-4">
        {filteredReservations.length === 0 ? (
          <div className="bg-white rounded-3xl border border-dashed border-slate-200 p-16 text-center">
            <div className="h-16 w-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <CalendarCheck2 className="h-8 w-8 text-slate-300" />
            </div>
            <p className="text-slate-700 font-black text-sm">Nenhuma reserva encontrada</p>
            <p className="text-slate-400 text-xs mt-1">
              {searchTerm ? 'Nenhum resultado corresponde à busca.' : 'Você não possui reservas nesta categoria no momento.'}
            </p>
            <button
              type="button"
              onClick={() => navigate('/salas')}
              className="mt-4 px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold transition-all"
            >
              Explorar Ambientes Disponíveis
            </button>
          </div>
        ) : (
          filteredReservations.map((res) => {
            const room = rooms.find(r => r.firestoreId === res.salaId);
            const isPending = res.status === 'PENDENTE';
            const isConfirmed = res.status === 'CONFIRMADA';
            const isToday = res.data === todayStr;
            const canCheckIn = isPending && !isAdmin && isToday && (readyReservations[res.id] || new Date().toTimeString().slice(0, 5) >= res.inicio);
            const canCancel = isPending || isConfirmed;
            const canManage = !isPending && !isConfirmed;
            const isExpanded = expandedIds.has(res.id);
            const duration = calculateDuration(res.inicio, res.fim);
            const requesterObj = usersMap[res.usuarioId];

            return (
              <motion.div
                key={res.id}
                layout
                className={cn(
                  "bg-white rounded-3xl border transition-all overflow-hidden border-slate-200/90 shadow-2xs hover:shadow-md",
                  res.status === 'PUNIDA' && "border-rose-300 bg-red-50/20",
                  isConfirmed && "border-emerald-200 ring-2 ring-emerald-50/60"
                )}
              >
                {/* CARD MAIN BAR */}
                <div className="flex flex-col md:flex-row">
                  {/* ROOM ICON & BASIC INFO */}
                  <div className="p-5 md:w-64 border-b md:border-b-0 md:border-r border-slate-100 flex items-center gap-4 bg-slate-50/50">
                    <div className="h-12 w-12 rounded-2xl bg-slate-900 flex items-center justify-center text-white shrink-0 shadow-md shadow-slate-900/10">
                      <Building2 className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">
                          {room?.codigo || 'Ambiente'}
                        </span>
                      </div>
                      <h3 className="text-sm font-black text-slate-900 truncate">
                        {room?.nome || 'Sala Excluída'}
                      </h3>
                      <p className="text-[10px] text-slate-500 font-medium">
                        {room?.andar || 'Fatec Franco da Rocha'}
                      </p>
                    </div>
                  </div>

                  {/* METRICS ROW (Date, Time, Status) */}
                  <div className="p-5 flex-1 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {/* DATE */}
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shrink-0">
                          <Calendar className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Data:</p>
                          <p className="text-xs font-bold text-slate-800">
                            {formatDataBR(res.data)}
                          </p>
                          {isToday && (
                            <span className="text-[9px] font-black text-emerald-600 uppercase">Hoje</span>
                          )}
                        </div>
                      </div>

                      {/* PERIOD & DURATION */}
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600 shrink-0">
                          <Clock className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Horário & Duração:</p>
                          <p className="text-xs font-bold text-slate-800 flex items-center gap-1">
                            {res.inicio} <ArrowRight className="h-3 w-3 text-slate-400" /> {res.fim}
                          </p>
                          <span className="text-[10px] font-medium text-purple-700 font-mono">
                            {duration}
                          </span>
                        </div>
                      </div>

                      {/* STATUS */}
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "h-9 w-9 rounded-xl flex items-center justify-center shrink-0",
                          res.status === 'CONFIRMADA' ? "bg-emerald-50 text-emerald-600" :
                          res.status === 'PENDENTE' ? "bg-amber-50 text-amber-600" :
                          "bg-red-50 text-fatec-red"
                        )}>
                          {res.status === 'CONFIRMADA' ? <CheckCircle2 className="h-5 w-5" /> :
                           res.status === 'PENDENTE' ? <Clock className="h-5 w-5" /> :
                           <XCircle className="h-5 w-5" />}
                        </div>
                        <div className="flex-1">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Status:</p>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-xs font-black uppercase tracking-wider",
                              res.status === 'CONFIRMADA' ? "text-emerald-600" :
                              res.status === 'PENDENTE' ? "text-amber-600" :
                              "text-fatec-red"
                            )}>
                              {res.status}
                            </span>
                            {isConfirmed && !isAdmin && (
                              <button
                                onClick={() => initiateCancel(res.id, res.status)}
                                className="text-slate-300 hover:text-fatec-red transition-colors p-0.5"
                                title="Cancelar Check-in / Reserva"
                              >
                                <XCircle className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* EXPAND DETAILS BUTTON */}
                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => toggleExpand(res.id)}
                        className="text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors flex items-center gap-1.5"
                      >
                        <span>{isExpanded ? 'Recolher detalhes' : 'Ver detalhes do ambiente e agendamento'}</span>
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                        )}
                      </button>

                      {isAdmin && (
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <UserIcon className="h-3 w-3 text-slate-400" />
                          <span className="font-semibold text-slate-700">
                            {requesterObj?.nome || 'Usuário Fatec'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* CHECK-IN COUNTER FOR USERS */}
                    {isPending && isToday && !isAdmin && res.checkInExpiracao && (
                      <CheckInCounter 
                        expiration={res.checkInExpiracao} 
                        onReady={(ready) => handleSetReady(res.id, ready)} 
                      />
                    )}

                    {/* ADMIN CONFIRMATION CARD */}
                    {isPending && isAdmin && (
                      <div className="mt-2 bg-amber-500 text-white p-4 rounded-2xl flex flex-col gap-2.5 animate-in slide-in-from-top-1 duration-200">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 animate-spin-slow text-white" />
                          <p className="text-[10px] font-black uppercase tracking-widest text-[#FFFEE5]">
                            Reserva aguardando confirmação...
                          </p>
                        </div>
                        <p className="text-xs font-semibold leading-relaxed text-[#FFFDF0]">
                          Como administrador, favor confirmar a reserva para formalizar o bloqueio do ambiente, ou cancele caso não precise mais.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                          <button
                            onClick={async () => {
                              try {
                                await updateReservation(res.id, {
                                  status: 'CONFIRMADA',
                                  checkInRealizado: true
                                });
                                toast.success('Reserva confirmada com sucesso!', {
                                  icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                                });
                              } catch (err) {
                                toast.error('Erro ao confirmar reserva.');
                              }
                            }}
                            className="flex-1 bg-white text-amber-600 hover:bg-neutral-50 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-1.5 shadow-md shadow-amber-600/10 font-bold"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Confirmar Reserva
                          </button>
                          <button
                            onClick={() => handleCancel(res.id, res.status)}
                            className="px-4 bg-amber-600 text-white border border-amber-400 hover:bg-amber-700 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 font-bold"
                          >
                            Cancelar Reserva
                          </button>
                        </div>
                      </div>
                    )}

                    {/* USAGE TIMER (COUNTDOWN) */}
                    {isConfirmed && isToday && (
                      <UsageTimer 
                        resId={res.id} 
                        data={res.data}
                        inicio={res.inicio} 
                        fim={res.fim} 
                        isConfirmed={isConfirmed} 
                        onCancel={() => handleCancel(res.id, res.status)} 
                      />
                    )}

                    {/* NO-SHOW SINGLE-DAY TAG */}
                    {res.status === 'PUNIDA' && (
                      <NoShowDayNotice dateISO={res.blockedDate || res.data} />
                    )}
                  </div>

                  {/* SIDE ACTIONS STRIP */}
                  <div className="bg-slate-50/80 px-5 py-4 flex flex-col md:w-48 items-center justify-center gap-2.5 border-t md:border-t-0 md:border-l border-slate-100">
                    {canCheckIn && (
                      <button
                        onClick={() => setScanningResId(res.id)}
                        className="w-full bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-emerald-100 transition-all active:scale-95 flex items-center justify-center gap-2"
                      >
                        <QrCode className="h-4 w-4" />
                        QR Check-in
                      </button>
                    )}
                    
                    {canCancel ? (
                      <div className="w-full space-y-2">
                        {confirmingCancelId === res.id ? (
                          <div className="bg-white border-2 border-fatec-red/20 rounded-xl p-3 flex flex-col gap-2 animate-in zoom-in-95 duration-200">
                            <p className="text-[10px] font-black text-fatec-red uppercase text-center leading-tight">
                              {isConfirmed ? 'Deseja encerrar e liberar a sala?' : 'Tem certeza que deseja cancelar?'}
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleCancel(res.id, res.status)}
                                disabled={cancellingIds.has(res.id)}
                                className="flex-1 bg-fatec-red text-white py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50"
                              >
                                Sim
                              </button>
                              <button
                                onClick={() => setConfirmingCancelId(null)}
                                className="flex-1 bg-slate-100 text-slate-600 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                              >
                                Não
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => initiateCancel(res.id, res.status)}
                            disabled={cancellingIds.has(res.id)}
                            className={cn(
                              "w-full py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50",
                              isConfirmed
                                ? "bg-emerald-50 text-emerald-600 hover:bg-fatec-red hover:text-white border border-emerald-100"
                                : canCheckIn 
                                  ? "bg-white border-2 border-slate-100 text-slate-400 hover:border-fatec-red hover:text-fatec-red" 
                                  : "bg-slate-100 text-slate-600 hover:bg-fatec-red hover:text-white"
                            )}
                          >
                            {cancellingIds.has(res.id) 
                              ? 'Processando...' 
                              : isConfirmed ? 'Liberar Sala' : 'Cancelar Reserva'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] font-black pointer-events-none uppercase text-slate-300 italic">
                        {res.status !== 'PENDENTE' ? 'Encerrado' : 'Aguardando'}
                      </div>
                    )}

                    {!isAdmin ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleHide(res.id)}
                          disabled={!canManage}
                          className={cn("p-2 transition-colors", canManage ? "text-slate-300 hover:text-slate-600" : "text-slate-100 cursor-not-allowed")}
                          title="Remover do histórico"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 mt-1">
                        {confirmingDeleteId === res.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleDelete(res.id)}
                              className="px-2.5 py-1 rounded-lg bg-fatec-red text-white text-[10px] font-bold cursor-pointer"
                            >
                              Excluir
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingDeleteId(null)}
                              className="px-2 py-1 rounded-lg bg-slate-200 text-slate-700 text-[10px] font-bold cursor-pointer"
                            >
                              Não
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingDeleteId(res.id)}
                            className="text-slate-300 hover:text-fatec-red transition-colors p-1.5 cursor-pointer"
                            title="Excluir do sistema (ADM)"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* EXPANDABLE ACCORDION DRAWER */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="border-t border-slate-100 bg-slate-50/70 p-5 md:p-6"
                    >
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* 1. AMBIENTE & INFRAESTRUTURA */}
                        <div className="space-y-3 bg-white p-4 rounded-2xl border border-slate-200/80">
                          <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-fatec-red" />
                            Detalhes do Ambiente
                          </h4>
                          
                          <div className="space-y-2 text-xs text-slate-600">
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">Capacidade:</span>
                              <span className="font-bold text-slate-800">{room?.capacidade || 40} alunos</span>
                            </div>
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">Localização / Andar:</span>
                              <span className="font-bold text-slate-800">{room?.andar || '1º Andar'}</span>
                            </div>
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">Código da Sala:</span>
                              <span className="font-bold text-slate-800">{room?.codigo || 'SALA-FATEC'}</span>
                            </div>
                            <div>
                              <span className="text-slate-400 font-bold block mb-1.5">Equipamentos & Recursos:</span>
                              <div className="flex flex-wrap gap-1.5">
                                {room?.equipamentos && room.equipamentos.length > 0 ? (
                                  room.equipamentos.map((rec, i) => (
                                    <span key={i} className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold">
                                      {rec}
                                    </span>
                                  ))
                                ) : (
                                  <>
                                    <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold flex items-center gap-1">
                                      <Tv className="h-3 w-3 text-slate-400" />
                                      Datashow
                                    </span>
                                    <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold flex items-center gap-1">
                                      <Wind className="h-3 w-3 text-slate-400" />
                                      Ar Condicionado
                                    </span>
                                    <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold flex items-center gap-1">
                                      <Laptop className="h-3 w-3 text-slate-400" />
                                      Computadores
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* 2. DADOS DO AGENDAMENTO & SOLICITANTE */}
                        <div className="space-y-3 bg-white p-4 rounded-2xl border border-slate-200/80">
                          <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
                            <Info className="h-4 w-4 text-blue-600" />
                            Dados do Agendamento
                          </h4>

                          <div className="space-y-2 text-xs text-slate-600">
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">Solicitante:</span>
                              <span className="font-bold text-slate-800">
                                {requesterObj?.nome || user?.nome || 'Usuário Fatec'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">Finalidade:</span>
                              <span className="font-bold text-slate-800">
                                {res.observacoes || 'Estudos em Grupo / Atividade Acadêmica'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">QR Check-in:</span>
                              <span className={cn("font-bold", res.checkInRealizado ? "text-emerald-600" : "text-amber-600")}>
                                {res.checkInRealizado ? 'Check-in Concluído' : 'Pendente de Leitura QR'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                              <span className="text-slate-400 font-bold">ID do Registro:</span>
                              <span className="font-mono text-[10px] text-slate-500 truncate max-w-[160px]">
                                {res.id}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
