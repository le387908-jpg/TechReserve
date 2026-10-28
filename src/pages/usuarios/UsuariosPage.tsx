/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, ShieldAlert, LayoutDashboard } from 'lucide-react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from '../../services/firebase/config';
import { User } from '../../types';
import { AdminUsersTab } from '../admin/components/AdminUsersTab';
import { AdminModerationTab } from '../admin/components/AdminModerationTab';
import { cn } from '../../lib/utils';

type UsersViewTab = 'base' | 'moderacao';

/**
 * Página de Gestão de Usuários (/usuarios)
 * Reutiliza integralmente os módulos atualizados da Base de Usuários (`code-auth`, RA, curso, semestre,
 * inativação com 1 clique e histórico individual) e do Painel de Moderação & Suspensões.
 */
export function UsuariosPage() {
  const [activeView, setActiveView] = useState<UsersViewTab>('base');
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'users'), orderBy('nome', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as User)));
      },
      (err) => {
        console.warn('Users page listener warning:', err);
      }
    );
    return () => unsub();
  }, []);

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="font-semibold text-fatec-red">Governança de Identidades</span>
            <span aria-hidden="true">·</span>
            <span>Alunos, Servidores e Coordenação</span>
          </div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
            Base de Usuários, Moderação & Credenciais
          </h2>
          <p className="text-sm text-slate-500">
            Pesquise por nome, e-mail, RA, curso e semestre, inative contas, aplique suspensões temporárias e gerencie o código <code className="font-mono text-xs">code-auth</code>.
          </p>
        </div>

        <Link
          to="/admin"
          className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          <LayoutDashboard className="h-4 w-4" />
          Abrir Painel ADM Completo
        </Link>
      </div>

      {/* SELETOR DE VISÃO */}
      <div className="bg-white border border-slate-200 rounded-2xl p-1.5 inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => setActiveView('base')}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer',
            activeView === 'base'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          )}
        >
          <Users className="h-4 w-4" />
          Base de Usuários & code-auth
        </button>
        <button
          type="button"
          onClick={() => setActiveView('moderacao')}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer',
            activeView === 'moderacao'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          )}
        >
          <ShieldAlert className="h-4 w-4" />
          Moderação & Suspensões
        </button>
      </div>

      {activeView === 'base' ? (
        <AdminUsersTab
          externalUsers={users}
          onNavigateToModeration={() => setActiveView('moderacao')}
        />
      ) : (
        <AdminModerationTab externalUsers={users} />
      )}
    </div>
  );
}
