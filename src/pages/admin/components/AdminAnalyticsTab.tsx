/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Download,
  Building2,
  CheckCircle2,
  Clock,
  Wrench,
  AlertTriangle,
  Activity,
  FileText,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { toast } from 'sonner';
import { useRoomStore } from '../../../store/useRoomStore';
import { useReservationStore } from '../../../store/useReservationStore';
import { useLogStore } from '../../../store/useLogStore';
import {
  LogEntity,
  RealtimeSpaceStatus,
  SpaceCategory,
  inferSpaceCategory,
  resolveRoomRealtimeStatus,
} from '../../../types';
import { REALTIME_SPACE_STATUS_LABELS, SPACE_CATEGORY_LABELS } from '../../../constants';
import { formatDataBR, getTodayLocalISO } from '../../../utils/dateUtils';
import { cn } from '../../../lib/utils';

/**
 * Aba 4 — Relatórios Analíticos e Métricas de Governança
 * Apresenta:
 * - Taxa de ocupação dos ambientes (%)
 * - Índice de no-show / faltas (%)
 * - Matriz / Panorama de uso em tempo real
 * - Gráficos analíticos de comparecimento e ocupação
 * - Histórico auditável de ações (`logs`) com busca, filtro e exportação CSV
 */
export function AdminAnalyticsTab() {
  const { rooms, toggleMaintenanceOneClick } = useRoomStore();
  const reservations = useReservationStore((state) => state.reservations);
  const { logs, loading: loadingLogs, fetchLogs } = useLogStore();

  const [now, setNow] = useState(() => new Date());
  const [matrixCategory, setMatrixCategory] = useState<'TODAS' | SpaceCategory>('TODAS');
  const [logEntityFilter, setLogEntityFilter] = useState<'TODOS' | LogEntity>('TODOS');
  const [logSearch, setLogSearch] = useState('');

  useEffect(() => {
    const unsub = fetchLogs();
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [fetchLogs]);

  const todayISO = getTodayLocalISO(now);

  // Panorama matricial em tempo real de todos os ambientes
  const realtimeMatrix = useMemo(() => {
    return rooms.map((room) => {
      const categoria = inferSpaceCategory(room);
      const rt = resolveRoomRealtimeStatus(room, reservations, now);
      return {
        room,
        categoria,
        ...rt,
      };
    });
  }, [rooms, reservations, now]);

  // Métricas analíticas principais de governança
  const analytics = useMemo(() => {
    const totalRooms = rooms.length;
    const maintenanceCount = realtimeMatrix.filter((m) => m.status === 'MANUTENCAO').length;
    const operationalRooms = Math.max(0, totalRooms - maintenanceCount);

    const occupiedOrReservedNow = realtimeMatrix.filter(
      (m) => m.status === 'EM_USO' || m.status === 'RESERVADO'
    ).length;

    // Ambientes que tiveram ou têm reserva ativa hoje
    const roomsWithBookingToday = new Set(
      reservations
        .filter(
          (r) => r.data === todayISO && (r.status === 'CONFIRMADA' || r.status === 'PENDENTE' || r.status === 'CONCLUIDA')
        )
        .map((r) => r.salaId)
    ).size;

    // Taxa de ocupação operacional (% de espaços operacionais ocupados/reservados hoje ou em tempo real)
    const activeEngagement = Math.max(occupiedOrReservedNow, roomsWithBookingToday);
    const occupancyRate =
      operationalRooms > 0 ? Math.min(100, Math.round((activeEngagement / operationalRooms) * 100)) : 0;

    // Índice de No-Show / Faltas
    const totalBookings = reservations.length;
    const noShowCount = reservations.filter((r) => r.status === 'PUNIDA').length;
    const cancelledCount = reservations.filter((r) => r.status === 'CANCELADA').length;
    const confirmedOrDoneCount = reservations.filter(
      (r) => r.status === 'CONFIRMADA' || r.status === 'CONCLUIDA'
    ).length;
    const pendingCount = reservations.filter((r) => r.status === 'PENDENTE').length;

    const noShowRate =
      totalBookings > 0 ? Number(((noShowCount / totalBookings) * 100).toFixed(1)) : 0;
    const attendanceRate =
      confirmedOrDoneCount + noShowCount > 0
        ? Math.round((confirmedOrDoneCount / (confirmedOrDoneCount + noShowCount)) * 100)
        : 100;

    return {
      totalRooms,
      operationalRooms,
      maintenanceCount,
      occupiedOrReservedNow,
      occupancyRate,
      totalBookings,
      noShowCount,
      cancelledCount,
      confirmedOrDoneCount,
      pendingCount,
      noShowRate,
      attendanceRate,
    };
  }, [rooms.length, realtimeMatrix, reservations, todayISO]);

  // Série dos últimos 7 dias para o gráfico analítico
  const chartData = useMemo(() => {
    const days: {
      dateISO: string;
      label: string;
      Confirmadas: number;
      Canceladas: number;
      NoShow: number;
    }[] = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const iso = getTodayLocalISO(d);
      const label = formatDataBR(iso).slice(0, 5);
      const dayRes = reservations.filter((r) => r.data === iso);
      days.push({
        dateISO: iso,
        label,
        Confirmadas: dayRes.filter(
          (r) => r.status === 'CONFIRMADA' || r.status === 'CONCLUIDA' || r.status === 'PENDENTE'
        ).length,
        Canceladas: dayRes.filter((r) => r.status === 'CANCELADA').length,
        NoShow: dayRes.filter((r) => r.status === 'PUNIDA').length,
      });
    }
    return days;
  }, [reservations, now]);

  const filteredMatrix = useMemo(() => {
    if (matrixCategory === 'TODAS') return realtimeMatrix;
    return realtimeMatrix.filter((item) => item.categoria === matrixCategory);
  }, [realtimeMatrix, matrixCategory]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logEntityFilter !== 'TODOS' && l.entidade !== logEntityFilter) return false;
      if (logSearch.trim()) {
        const q = logSearch.toLowerCase();
        const hay = `${l.acao} ${l.usuarioNome} ${l.detalhes} ${l.entidade}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [logs, logEntityFilter, logSearch]);

  const handleExportLogsCSV = () => {
    if (filteredLogs.length === 0) {
      toast.error('Não há registros no filtro atual para exportar.');
      return;
    }
    const header = ['Data_Hora', 'Entidade', 'Acao', 'Responsavel', 'Detalhes'];
    const rows = filteredLogs.map((l) => [
      new Date(l.createdAt).toLocaleString('pt-BR'),
      l.entidade,
      l.acao,
      `"${(l.usuarioNome || '').replace(/"/g, '""')}"`,
      `"${(l.detalhes || '').replace(/"/g, '""')}"`,
    ]);
    const csv = [header.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `auditoria_techreserve_${todayISO}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('Relatório de auditoria exportado em CSV.');
  };

  return (
    <div className="space-y-8">
      {/* KPI CARDS DE GOVERNANÇA */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Taxa de Ocupação dos Ambientes</span>
            <Activity className="h-4 w-4 text-fatec-red" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold font-mono tabular-nums text-slate-900">
              {analytics.occupancyRate}%
            </span>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              ({analytics.occupiedOrReservedNow}/{analytics.operationalRooms} ativos agora)
            </span>
          </div>
          <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-fatec-red transition-all duration-300"
              style={{ width: `${analytics.occupancyRate}%` }}
            />
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Índice de No-Show / Faltas</span>
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold font-mono tabular-nums text-slate-900">
              {analytics.noShowRate}%
            </span>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              ({analytics.noShowCount} ausências sem check-in)
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Efetividade de presença:{' '}
            <span className="font-mono tabular-nums font-semibold text-emerald-700">
              {analytics.attendanceRate}%
            </span>
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Disponibilidade Física</span>
            <Building2 className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold font-mono tabular-nums text-slate-900">
              {analytics.operationalRooms}
            </span>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              de {analytics.totalRooms} espaços aptos
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
            {analytics.maintenanceCount} ambiente(s) em manutenção
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Volume Auditado de Reservas</span>
            <FileText className="h-4 w-4 text-slate-700" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold font-mono tabular-nums text-slate-900">
              {analytics.totalBookings}
            </span>
            <span className="text-xs text-slate-500">registros totais</span>
          </div>
          <p className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
            {analytics.confirmedOrDoneCount} confirmadas · {analytics.cancelledCount} canceladas
          </p>
        </div>
      </div>

      {/* MATRIZ / PANORAMA DE USO EM TEMPO REAL */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Matriz de Uso em Tempo Real dos Ambientes
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Panorama instantâneo da ocupação de salas, laboratórios e auditórios. Clique no botão de manutenção de qualquer célula para alternar suspensão rápida.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            {(
              [
                { id: 'TODAS', label: 'Todos' },
                { id: 'SALA', label: 'Salas' },
                { id: 'LABORATORIO', label: 'Laboratórios' },
                { id: 'AUDITORIO', label: 'Auditórios' },
                { id: 'ESPECIAL', label: 'Especiais' },
              ] as const
            ).map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setMatrixCategory(cat.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                  matrixCategory === cat.id
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* LEGENDA SEMÂNTICA ACESSÍVEL (ÍCONE + RÓTULO) */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 pb-2 border-b border-slate-100">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            Disponível
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium text-sky-800">
            <Clock className="h-3.5 w-3.5 text-sky-600" />
            Reservado
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium text-fatec-red">
            <Activity className="h-3.5 w-3.5 text-fatec-red" />
            Em Uso
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-800">
            <Wrench className="h-3.5 w-3.5 text-amber-600" />
            Em Manutenção
          </span>
        </div>

        {filteredMatrix.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500">
            Nenhum ambiente cadastrado nesta categoria.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredMatrix.map(({ room, categoria, status, currentReservation, nextReservation }) => {
              const statusStyles: Record<RealtimeSpaceStatus, string> = {
                DISPONIVEL: 'bg-emerald-50/40 border-emerald-200',
                RESERVADO: 'bg-sky-50/50 border-sky-200',
                EM_USO: 'bg-red-50/50 border-red-200',
                MANUTENCAO: 'bg-amber-50/50 border-amber-200',
              };

              return (
                <div
                  key={room.firestoreId}
                  className={cn(
                    'rounded-xl border p-3.5 flex flex-col justify-between gap-2.5 transition-colors',
                    statusStyles[status]
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-mono tabular-nums font-bold text-slate-700">
                        {room.id} · {SPACE_CATEGORY_LABELS[categoria]}
                      </p>
                      <h4 className="text-sm font-bold text-slate-900 truncate mt-0.5" title={room.nome}>
                        {room.nome}
                      </h4>
                      <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                        {room.andar} · {room.capacidade} lugares
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        await toggleMaintenanceOneClick(room);
                        toast.success(
                          status === 'MANUTENCAO'
                            ? `${room.id} liberado para uso.`
                            : `${room.id} colocado em manutenção.`
                        );
                      }}
                      title={
                        status === 'MANUTENCAO'
                          ? 'Reativar ambiente'
                          : 'Suspender para manutenção com 1 clique'
                      }
                      className="p-1.5 rounded-lg bg-white/80 hover:bg-white border border-slate-200 text-slate-600 hover:text-slate-900 transition-colors shrink-0 cursor-pointer"
                    >
                      <Wrench className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between text-xs">
                    <span
                      className={cn(
                        'font-semibold',
                        status === 'DISPONIVEL' && 'text-emerald-800',
                        status === 'RESERVADO' && 'text-sky-800',
                        status === 'EM_USO' && 'text-fatec-red',
                        status === 'MANUTENCAO' && 'text-amber-900'
                      )}
                    >
                      {REALTIME_SPACE_STATUS_LABELS[status]}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-600">
                      {currentReservation
                        ? `${currentReservation.inicio}–${currentReservation.fim}`
                        : nextReservation
                        ? `Próx. ${nextReservation.inicio}`
                        : status === 'MANUTENCAO'
                        ? 'Suspenso'
                        : 'Livre agora'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* GRÁFICO COMPARATIVO DE USO E NO-SHOW (7 DIAS) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">
            Desempenho de Agendamentos nos Últimos 7 Dias
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Comparativo diário entre reservas regulares, cancelamentos prévios e faltas (no-show).
          </p>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748B', fontSize: 12 }}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748B', fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: '12px',
                  border: '1px solid #E2E8F0',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="Confirmadas" name="Confirmadas / Ativas" fill="#16A34A" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Canceladas" name="Canceladas no Prazo" fill="#64748B" radius={[4, 4, 0, 0]} />
              <Bar dataKey="NoShow" name="No-Show / Faltas" fill="#8B0000" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* HISTÓRICO AUDITÁVEL DE AÇÕES (`logs`) */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Trilha de Auditoria e Governança (Logs do Sistema)
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Histórico auditável em tempo real de reservas, cancelamentos, check-ins, suspensões e alterações administrativas.
            </p>
          </div>

          <button
            type="button"
            onClick={handleExportLogsCSV}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            Exportar CSV
          </button>
        </div>

        <div className="p-4 bg-slate-50/70 border-b border-slate-200 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Pesquisar evento auditável por responsável, ação, sala ou detalhe..."
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
            />
          </div>

          <select
            value={logEntityFilter}
            onChange={(e) => setLogEntityFilter(e.target.value as any)}
            className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
          >
            <option value="TODOS">Todos os Módulos</option>
            <option value="RESERVAS">Reservas e Cancelamentos</option>
            <option value="SALAS">Inventário de Salas</option>
            <option value="HORARIOS">Janelas de Horários</option>
            <option value="USERS">Usuários e Moderação</option>
            <option value="WHATSAPP">Mensageria WhatsApp</option>
            <option value="SISTEMA">Segurança e Code-Auth</option>
          </select>
        </div>

        {loadingLogs && logs.length === 0 ? (
          <div className="p-8 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500">
            Nenhum evento de auditoria corresponde aos filtros atuais.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[420px] custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500">
                <tr>
                  <th className="px-5 py-3">Data / Hora</th>
                  <th className="px-5 py-3">Módulo</th>
                  <th className="px-5 py-3">Operação</th>
                  <th className="px-5 py-3">Responsável</th>
                  <th className="px-5 py-3">Descrição Auditável</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/70">
                    <td className="px-5 py-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('pt-BR')}
                    </td>
                    <td className="px-5 py-3 font-semibold text-slate-700 whitespace-nowrap">
                      {log.entidade}
                    </td>
                    <td className="px-5 py-3 font-mono font-semibold text-fatec-red whitespace-nowrap">
                      {log.acao}
                    </td>
                    <td className="px-5 py-3 font-semibold text-slate-900 whitespace-nowrap">
                      {log.usuarioNome}
                    </td>
                    <td className="px-5 py-3 text-slate-600 max-w-xl">{log.detalhes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
