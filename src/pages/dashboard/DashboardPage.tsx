/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { 
  Users, 
  Building2, 
  CalendarDays, 
  ArrowUpRight, 
  ArrowDownRight,
  Clock,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { Link } from 'react-router-dom';
import { useRoomStore } from '../../store/useRoomStore';
import { useReservationStore } from '../../store/useReservationStore';
import { useAuthStore } from '../../store/useAuthStore';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const data = [
  { name: 'Seg', reservas: 12 },
  { name: 'Ter', reservas: 18 },
  { name: 'Qua', reservas: 15 },
  { name: 'Qui', reservas: 22 },
  { name: 'Sex', reservas: 30 },
  { name: 'Sáb', reservas: 5 },
  { name: 'Dom', reservas: 2 },
];

export function DashboardPage() {
  const { rooms: rawRooms, fetchRooms } = useRoomStore();
  const { reservations: rawReservations, fetchReservations } = useReservationStore();
  const { user } = useAuthStore();

  const rooms = Array.isArray(rawRooms) ? rawRooms : [];
  const reservations = Array.isArray(rawReservations) ? rawReservations : [];

  useEffect(() => {
    const unsubRooms = fetchRooms();
    const unsubReservas = fetchReservations();

    return () => {
      try {
        unsubRooms();
      } catch {
        // Ignora falha de encerramento de listener
      }
      try {
        unsubReservas();
      } catch {
        // Ignora falha de encerramento de listener
      }
    };
  }, [fetchRooms, fetchReservations, user?.id]);

  const stats = [
    { 
      label: 'Total de Salas', 
      value: rooms.length, 
      icon: Building2, 
      color: 'bg-blue-500',
      trend: { val: '+2', up: true }
    },
    { 
      label: 'Reservas Ativas', 
      value: reservations.filter((r) => r?.status === 'CONFIRMADA').length, 
      icon: CalendarDays, 
      color: 'bg-fatec-red',
      trend: { val: '+15%', up: true }
    },
    { 
      label: 'Check-ins Pendentes', 
      value: reservations.filter((r) => r?.status === 'PENDENTE').length, 
      icon: Clock, 
      color: 'bg-amber-500',
      trend: { val: 'Aguardando', up: true }
    },
    { 
      label: 'Capacidade Total', 
      value: rooms.reduce((acc, r) => acc + (Number(r?.capacidade) || 0), 0), 
      icon: Users, 
      color: 'bg-emerald-500',
      trend: { val: 'Estável', up: true }
    },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Olá, {user?.nome}! 👋</h2>
          <p className="text-slate-500">Aqui está um resumo do que está acontecendo hoje.</p>
        </div>
        <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
          <Clock className="h-5 w-5 text-fatec-red" />
          <span className="text-sm font-medium text-slate-700">
            {format(new Date(), "eeee, d 'de' MMMM", { locale: ptBR })}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-white p-5 md:p-6 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
            <div className={`absolute top-0 right-0 w-20 h-20 translate-x-10 -translate-y-10 rounded-full opacity-10 group-hover:scale-110 transition-transform ${stat.color}`}></div>
            <div className="flex items-center justify-between mb-4">
              <div className={`p-2.5 rounded-xl ${stat.color} text-white shadow-lg`}>
                <stat.icon className="h-5 w-5 md:h-6 md:w-6" />
              </div>
              <div className={`flex items-center gap-1 text-[10px] md:text-xs font-bold px-2 py-1 rounded-full ${stat.trend.up ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                {stat.trend.up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {stat.trend.val}
              </div>
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium">{stat.label}</p>
            <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{stat.value}</h3>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 md:gap-8 pb-10">
        {/* Reservation Chart */}
        <div className="bg-white p-5 md:p-6 rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <h3 className="font-bold text-lg text-slate-900">Uso Semanal</h3>
            <select className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-fatec-red w-full sm:w-auto">
              <option>Últimos 7 dias</option>
              <option>Último mês</option>
            </select>
          </div>
          <div className="h-[300px] md:h-[400px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id="colorReservas" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8B0000" stopOpacity={0.1}/>
                    <stop offset="95%" stopColor="#8B0000" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{fill: '#64748B', fontSize: 10}} 
                  dy={10} 
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{fill: '#64748B', fontSize: 10}} 
                />
                <Tooltip 
                  contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)'}}
                  cursor={{stroke: '#8B0000', strokeWidth: 2}}
                />
                <Area 
                  type="monotone" 
                  dataKey="reservas" 
                  stroke="#8B0000" 
                  strokeWidth={3} 
                  fillOpacity={1} 
                  fill="url(#colorReservas)" 
                  animationDuration={1500}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
