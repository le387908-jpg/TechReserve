/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  Clock,
  Building2,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from '../../services/firebase/config';
import { useAuth } from '../../context/AuthContext';
import { User } from '../../types';
import { AdminAnalyticsTab } from './components/AdminAnalyticsTab';
import { AdminSchedulesTab } from './components/AdminSchedulesTab';
import { AdminSpacesTab } from './components/AdminSpacesTab';
import { AdminModerationTab } from './components/AdminModerationTab';
import { AdminUsersTab } from './components/AdminUsersTab';
import { WhatsAppGatewayCard } from '../../components/admin/WhatsAppGatewayCard';
import { cn } from '../../lib/utils';

export type AdminTabKey = 'metricas' | 'horarios' | 'espacos' | 'moderacao' | 'usuarios';

interface TabItem {
  id: AdminTabKey;
  label: string;
  icon: React.ElementType;
}

const ADMIN_TABS: TabItem[] = [
  { id: 'metricas', label: 'Governança & Métricas', icon: BarChart3 },
  { id: 'horarios', label: 'Horários & Janelas', icon: Clock },
  { id: 'espacos', label: 'Inventário de Espaços', icon: Building2 },
  { id: 'moderacao', label: 'Moderação & Punições', icon: ShieldAlert },
  { id: 'usuarios', label: 'Base de Usuários & Auth', icon: Users },
];

/**
 * Painel Central de Governança do Administrador (Perfil ADM) — TechReserve
 */
export function AdminPanelPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as AdminTabKey) || 'metricas';
  const validTab = ADMIN_TABS.some((t) => t.id === initialTab) ? initialTab : 'metricas';

  const [activeTab, setActiveTab] = useState<AdminTabKey>(validTab);
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    const param = searchParams.get('tab') as AdminTabKey;
    if (param && ADMIN_TABS.some((t) => t.id === param) && param !== activeTab) {
      setActiveTab(param);
    }
  }, [searchParams, activeTab]);

  // Listener compartilhado da coleção `users` estritamente para o perfil ADM
  useEffect(() => {
    if (!isAdmin) return;
    const q = query(collection(db, 'users'), orderBy('nome', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as User)));
      },
      (err) => {
        console.warn('Admin users listener warning:', err);
      }
    );
    return () => unsub();
  }, [isAdmin]);

  if (!isAdmin) {
    return <Navigate to="/salas" replace />;
  }

  const handleSelectTab = (tabId: AdminTabKey) => {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId }, { replace: true });
  };

  return (
    <div className="space-y-6 pb-12">
      {/* CABEÇALHO DO PAINEL DE GOVERNANÇA ADM */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="font-semibold text-fatec-red">Coordenação Institucional</span>
            <span aria-hidden="true">·</span>
            <span>TechReserve Governança Acadêmica</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-bold text-slate-900 tracking-tight">
            Painel de Controle Administrativo
          </h2>
          <p className="text-sm text-slate-500 max-w-3xl">
            Gerencie centralizadamente janelas de horários, inventário de ambientes pedagógicos, moderação disciplinar, indicadores de ocupação e credenciais administrativas.
          </p>
        </div>
      </div>

      {/* STATUS E CONEXÃO QR DO GATEWAY WHATSAPP INSTITUCIONAL */}
      <WhatsAppGatewayCard compact />

      {/* BARRA DE NAVEGAÇÃO INTERNA DAS 5 FRENTES DO PERFIL ADM */}
      <div className="bg-white border border-slate-200 rounded-2xl p-1.5 flex items-center gap-1 overflow-x-auto">
        {ADMIN_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleSelectTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                isActive
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* CONTEÚDO DA ABA SELECIONADA */}
      <div>
        {activeTab === 'metricas' && <AdminAnalyticsTab />}
        {activeTab === 'horarios' && <AdminSchedulesTab />}
        {activeTab === 'espacos' && <AdminSpacesTab />}
        {activeTab === 'moderacao' && <AdminModerationTab externalUsers={users} />}
        {activeTab === 'usuarios' && (
          <AdminUsersTab
            externalUsers={users}
            onNavigateToModeration={() => handleSelectTab('moderacao')}
          />
        )}
      </div>
    </div>
  );
}
