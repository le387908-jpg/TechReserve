/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  KeyRound,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Save,
  History,
  Edit3,
  ShieldCheck,
  ShieldAlert,
  Ban,
  X,
  CheckCircle2,
  Clock,
  XCircle,
  ArrowRight,
  UserX,
  UserCheck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  where,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '../../../services/firebase/config';
import { useAdminSettingsStore } from '../../../store/useAdminSettingsStore';
import { useRoomStore } from '../../../store/useRoomStore';
import { useLogStore } from '../../../store/useLogStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { CalendarCourse, Reservation, User, UserVinculo } from '../../../types';
import { USER_VINCULO_LABELS } from '../../../constants';
import { formatNoShowTag } from '../../../services/reservationService';
import { formatDataBR, getTodayLocalISO, normalizeDateToISO } from '../../../utils/dateUtils';
import { formatPhoneMask } from '../../../utils/phoneUtils';
import { withRetry } from '../../../services/firebase/utils';
import { cn } from '../../../lib/utils';

interface AdminUsersTabProps {
  externalUsers?: User[];
  onNavigateToModeration?: () => void;
}

/**
 * Aba 5 — Gerenciamento e Monitoramento da Base de Usuários & Controle `code-auth`
 * - Busca e filtros combinados por Nome, E-mail, RA, Curso e Semestre
 * - Visualização do histórico individual completo de reservas em modal
 * - Edição rápida de RA, Vínculo (Aluno / Servidor) e bloqueio cadastral
 * - Controle do código de autorização (`code-auth`) para novos perfis administrativos
 */
export function AdminUsersTab({ externalUsers, onNavigateToModeration }: AdminUsersTabProps) {
  const currentUser = useAuthStore((state) => state.user);
  const { rooms } = useRoomStore();
  const {
    authConfig,
    fetchAdminAuthConfig,
    saveAdminAuthConfig,
    generateSecureCode,
  } = useAdminSettingsStore();

  const [internalUsers, setInternalUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(!externalUsers);
  const [now, setNow] = useState(() => Date.now());

  // Estado do painel `code-auth`
  const [codeAuthInput, setCodeAuthInput] = useState(authConfig.codeAuth);
  const [allowAdminSignup, setAllowAdminSignup] = useState(authConfig.allowAdminSignup);
  const [showCodeAuth, setShowCodeAuth] = useState(false);
  const [isSavingCodeAuth, setIsSavingCodeAuth] = useState(false);

  // Filtros da Base de Usuários
  const [search, setSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState<'TODOS' | CalendarCourse>('TODOS');
  const [semesterFilter, setSemesterFilter] = useState<'TODOS' | number>('TODOS');
  const [roleFilter, setRoleFilter] = useState<'TODOS' | 'ALUNO' | 'SERVIDOR' | 'ADMIN'>('TODOS');
  const [statusFilter, setStatusFilter] = useState<'TODOS' | 'ATIVO' | 'PUNIDO' | 'BLOQUEADO'>('TODOS');

  // Modal de Histórico Individual de Reservas
  const [historyUser, setHistoryUser] = useState<User | null>(null);
  const [userReservations, setUserReservations] = useState<Reservation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Modal de Edição Cadastral (RA, Vínculo, Curso, Semestre, Bloqueio)
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editRa, setEditRa] = useState('');
  const [editVinculo, setEditVinculo] = useState<UserVinculo>('ALUNO');
  const [editCurso, setEditCurso] = useState<CalendarCourse>('GTI');
  const [editSemestre, setEditSemestre] = useState<number>(1);
  const [editBloqueado, setEditBloqueado] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);

  useEffect(() => {
    const unsubCode = fetchAdminAuthConfig();
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => {
      unsubCode();
      clearInterval(t);
    };
  }, [fetchAdminAuthConfig]);

  useEffect(() => {
    setCodeAuthInput(authConfig.codeAuth);
    setAllowAdminSignup(authConfig.allowAdminSignup);
  }, [authConfig]);

  useEffect(() => {
    if (externalUsers) {
      setLoading(false);
      return;
    }
    const q = query(collection(db, 'users'), orderBy('nome', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setInternalUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as User)));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, [externalUsers]);

  // Carrega histórico individual em tempo real ao abrir o modal de um usuário
  useEffect(() => {
    if (!historyUser) {
      setUserReservations([]);
      return;
    }
    setLoadingHistory(true);
    const q = query(collection(db, 'reservas'), where('usuarioId', '==', historyUser.id));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as Reservation))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setUserReservations(list);
        setLoadingHistory(false);
      },
      () => setLoadingHistory(false)
    );
    return () => unsub();
  }, [historyUser]);

  const users = externalUsers || internalUsers;

  const todayISO = useMemo(() => getTodayLocalISO(), [now]);

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const normBlocked = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
      const isPunished = Boolean(normBlocked && normBlocked >= todayISO);
      const isBlocked = Boolean(u.bloqueado || u.inativo);
      const vinculo: UserVinculo =
        u.role === 'ADMIN' ? 'COORDENACAO' : u.tipoVinculo || 'ALUNO';

      if (roleFilter === 'ADMIN' && u.role !== 'ADMIN') return false;
      if (roleFilter === 'ALUNO' && (u.role === 'ADMIN' || vinculo !== 'ALUNO')) return false;
      if (roleFilter === 'SERVIDOR' && (u.role === 'ADMIN' || vinculo !== 'SERVIDOR')) return false;

      if (courseFilter !== 'TODOS' && u.curso !== courseFilter) return false;
      if (semesterFilter !== 'TODOS' && u.semestre !== semesterFilter) return false;

      if (statusFilter === 'BLOQUEADO' && !isBlocked) return false;
      if (statusFilter === 'PUNIDO' && !isPunished) return false;
      if (statusFilter === 'ATIVO' && (isBlocked || isPunished)) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const hay = `${u.nome || ''} ${u.email || ''} ${u.phone || ''} ${u.phoneFormatted || ''} ${u.ra || ''} ${u.curso || ''} ${
          u.semestre ? `${u.semestre} semestre` : ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }, [users, roleFilter, courseFilter, semesterFilter, statusFilter, search, todayISO]);

  const handleSaveCodeAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingCodeAuth(true);
    try {
      await saveAdminAuthConfig({
        codeAuth: codeAuthInput,
        allowAdminSignup,
      });
      toast.success('Código de autorização (code-auth) atualizado com sucesso.');
    } catch (err: any) {
      toast.error(err.message || 'Erro ao salvar code-auth.');
    } finally {
      setIsSavingCodeAuth(false);
    }
  };

  const handleCopyCodeAuth = async () => {
    try {
      await navigator.clipboard.writeText(codeAuthInput);
      toast.success('Código code-auth copiado para a área de transferência.');
    } catch {
      toast.error('Não foi possível copiar automaticamente.');
    }
  };

  const openEditUserModal = (u: User) => {
    setEditingUser(u);
    setEditRa(u.ra || '');
    setEditVinculo(u.role === 'ADMIN' ? 'COORDENACAO' : u.tipoVinculo || 'ALUNO');
    setEditCurso(u.curso || 'GTI');
    setEditSemestre(u.semestre || 1);
    setEditBloqueado(Boolean(u.bloqueado || u.inativo));
  };

  const handleToggleUserInactive = async (target: User) => {
    if (!currentUser || target.id === currentUser.id) return;
    const currentlyInactive = Boolean(target.inativo || target.bloqueado);
    const nextState = !currentlyInactive;

    try {
      await withRetry(() =>
        updateDoc(doc(db, 'users', target.id), {
          inativo: nextState,
          bloqueado: nextState,
          updatedAt: Date.now(),
        })
      );

      await useLogStore.getState().addLog({
        acao: nextState ? 'INATIVAR_USUARIO_ADM' : 'REATIVAR_USUARIO_ADM',
        usuarioId: target.id,
        usuarioNome: currentUser.nome,
        entidade: 'USERS',
        detalhes: `Conta de ${target.nome} (${target.email}) foi ${
          nextState ? 'inativada (reservas e ações bloqueadas)' : 'reativada'
        } pelo administrador.`,
      });

      toast.success(
        nextState
          ? `Usuário ${target.nome} inativado e bloqueado para reservas.`
          : `Usuário ${target.nome} reativado com sucesso.`
      );
    } catch {
      toast.error('Não foi possível alterar o status de ativação do usuário.');
    }
  };

  const handleSaveUserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser || !currentUser) return;

    setIsSavingUser(true);
    try {
      const payload: Record<string, unknown> = {
        ra: editRa.trim().slice(0, 32),
        bloqueado: editBloqueado,
        inativo: editBloqueado,
        updatedAt: Date.now(),
      };

      if (editingUser.role !== 'ADMIN') {
        payload.tipoVinculo = editVinculo;
        payload.curso = editCurso;
        payload.course = editCurso;
        payload.semestre = editVinculo === 'SERVIDOR' ? null : editSemestre;
        payload.semester = editVinculo === 'SERVIDOR' ? null : editSemestre;
      }

      await withRetry(() => updateDoc(doc(db, 'users', editingUser.id), payload));

      await useLogStore.getState().addLog({
        acao: 'ATUALIZAR_CADASTRO_USUARIO',
        usuarioId: editingUser.id,
        usuarioNome: currentUser.nome,
        entidade: 'USERS',
        detalhes: `Cadastro de ${editingUser.nome} atualizado (RA: ${editRa || 'N/A'} · Inativo/Bloqueado: ${
          editBloqueado ? 'Sim' : 'Não'
        }).`,
      });

      toast.success(`Dados cadastrais de ${editingUser.nome} atualizados.`);
      setEditingUser(null);
    } catch {
      toast.error('Erro ao salvar alterações do usuário.');
    } finally {
      setIsSavingUser(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* CONTROLE DO CÓDIGO DE AUTORIZAÇÃO ADMINISTRATIVA (`code-auth`) */}
      <form
        onSubmit={handleSaveCodeAuth}
        className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <KeyRound className="h-4 w-4 text-fatec-red" />
              <span className="font-semibold text-slate-900">
                Credencial Institucional de Governança (code-auth)
              </span>
              {authConfig.updatedAt > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    Atualizado por {authConfig.updatedByName} em{' '}
                    {new Date(authConfig.updatedAt).toLocaleDateString('pt-BR')}
                  </span>
                </>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900">
              Controle do Código de Autorização para Novos Perfis Administrativos
            </h3>
            <p className="text-xs text-slate-500 max-w-3xl">
              Este código é exigido e validado diretamente pelas regras de segurança do banco de dados no cadastro de novos coordenadores ou administradores.
            </p>
          </div>

          <label className="inline-flex items-center gap-2.5 text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-200 px-3.5 py-2 rounded-xl shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={allowAdminSignup}
              onChange={(e) => setAllowAdminSignup(e.target.checked)}
              className="h-4 w-4 accent-fatec-red rounded"
            />
            Permitir novos cadastros ADM com code-auth
          </label>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <input
              type={showCodeAuth ? 'text' : 'password'}
              value={codeAuthInput}
              onChange={(e) => setCodeAuthInput(e.target.value)}
              minLength={4}
              maxLength={64}
              required
              aria-label="Código de autorização code-auth"
              className="w-full pl-4 pr-20 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-bold text-slate-900 outline-none focus:bg-white focus:ring-2 focus:ring-fatec-red"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowCodeAuth((v) => !v)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                title={showCodeAuth ? 'Ocultar código' : 'Mostrar código'}
              >
                {showCodeAuth ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={handleCopyCodeAuth}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                title="Copiar código"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              const generated = generateSecureCode();
              setCodeAuthInput(generated);
              setShowCodeAuth(true);
            }}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Gerar Novo Código
          </button>

          <button
            type="submit"
            disabled={isSavingCodeAuth}
            className="px-5 py-2.5 bg-fatec-red hover:bg-red-800 text-white rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {isSavingCodeAuth ? 'Salvando...' : 'Salvar code-auth'}
          </button>
        </div>
      </form>

      {/* MONITORAMENTO E FILTROS DA BASE DE USUÁRIOS */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Base Institucional de Usuários ({filteredUsers.length} de {users.length})
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Pesquise por nome, e-mail, RA, curso ou semestre e consulte o histórico individual de agendamentos.
            </p>
          </div>
          {onNavigateToModeration && (
            <button
              type="button"
              onClick={onNavigateToModeration}
              className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
            >
              Ir para Moderação & Suspensões
            </button>
          )}
        </div>

        {/* BARRA DE BUSCA E FILTROS MULTI-CRITÉRIO */}
        <div className="p-4 bg-slate-50/70 border-b border-slate-200 space-y-3">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Pesquisar usuário por nome completo, e-mail, WhatsApp, RA, curso ou semestre..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as any)}
              className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todos os Vínculos</option>
              <option value="ALUNO">Alunos / Estudantes</option>
              <option value="SERVIDOR">Servidores / Docentes</option>
              <option value="ADMIN">Administradores / Coordenação</option>
            </select>

            <select
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value as any)}
              className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todos os Cursos</option>
              <option value="GTI">GTI — Gestão de TI</option>
              <option value="GEEE">GEEE — Gestão de Energia</option>
            </select>

            <select
              value={semesterFilter}
              onChange={(e) =>
                setSemesterFilter(e.target.value === 'TODOS' ? 'TODOS' : Number(e.target.value))
              }
              className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todos os Semestres</option>
              {[1, 2, 3, 4, 5, 6].map((s) => (
                <option key={s} value={s}>
                  {s}º Semestre
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todas as Situações</option>
              <option value="ATIVO">Ativos / Regulares</option>
              <option value="PUNIDO">Bloqueio de No-Show (Data Única)</option>
              <option value="BLOQUEADO">Inativos / Bloqueados</option>
            </select>
          </div>
        </div>

        {/* TABELA DE USUÁRIOS */}
        {loading ? (
          <div className="p-8 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500">
            Nenhum usuário corresponde aos critérios de pesquisa selecionados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="px-5 py-3.5">Usuário & E-mail</th>
                  <th className="px-5 py-3.5">RA / Matrícula</th>
                  <th className="px-5 py-3.5">Vínculo</th>
                  <th className="px-5 py-3.5">Curso & Semestre</th>
                  <th className="px-5 py-3.5">Situação</th>
                  <th className="px-5 py-3.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredUsers.map((u) => {
                  const normBlocked = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
                  const isPunished = Boolean(normBlocked && normBlocked >= todayISO);
                  const isBlocked = Boolean(u.bloqueado || u.inativo);
                  const vinculo: UserVinculo =
                    u.role === 'ADMIN' ? 'COORDENACAO' : u.tipoVinculo || 'ALUNO';

                  return (
                    <tr key={u.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-900">{u.nome || 'Sem nome'}</p>
                        <p className="text-xs text-slate-500">{u.email}</p>
                        {(u.phoneFormatted || u.phone) && (
                          <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                            {u.phoneFormatted || formatPhoneMask(u.phone)}
                            <span className="font-sans" aria-hidden="true"> · </span>
                            <span className="font-sans">
                              {u.whatsappNotificationsEnabled !== false
                                ? 'WhatsApp ativo'
                                : 'Alertas pausados'}
                            </span>
                          </p>
                        )}
                      </td>

                      <td className="px-5 py-3.5 font-mono tabular-nums text-xs font-semibold text-slate-700 whitespace-nowrap">
                        {u.ra ? u.ra : <span className="text-slate-400 font-sans font-normal">Não informado</span>}
                      </td>

                      <td className="px-5 py-3.5 text-xs font-semibold text-slate-700 whitespace-nowrap">
                        {USER_VINCULO_LABELS[vinculo]}
                      </td>

                      <td className="px-5 py-3.5 text-xs text-slate-700 whitespace-nowrap">
                        {u.role === 'ADMIN' ? (
                          <span className="text-slate-400">Acesso Global</span>
                        ) : u.curso ? (
                          <span className="font-semibold">
                            {u.curso}
                            {u.semestre ? ` · ${u.semestre}º Semestre` : ''}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {isBlocked ? (
                          <div>
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
                              <Ban className="h-3.5 w-3.5" />
                              Inativo
                            </span>
                            <p className="text-[11px] text-slate-500">
                              {u.inativo ? 'Perfil inativado' : 'Acesso bloqueado'}
                            </p>
                          </div>
                        ) : isPunished ? (
                          <div>
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                              <ShieldAlert className="h-3.5 w-3.5" />
                              Punição de No-Show
                            </span>
                            <p className="text-[11px] font-mono tabular-nums text-slate-600">
                              Bloqueado apenas em {formatDataBR(normBlocked)}
                            </p>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Ativo
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setHistoryUser(u)}
                            className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                            title="Visualizar histórico individual de reservas"
                          >
                            <History className="h-3.5 w-3.5" />
                            Histórico
                          </button>

                          {u.id !== currentUser?.id && (
                            <button
                              type="button"
                              onClick={() => handleToggleUserInactive(u)}
                              className={cn(
                                'px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer',
                                isBlocked
                                  ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                                  : 'bg-red-50 text-fatec-red hover:bg-red-100 border border-red-200'
                              )}
                              title={
                                isBlocked
                                  ? 'Reativar perfil e desbloquear reservas'
                                  : 'Inativar usuário e bloquear todas as ações e reservas'
                              }
                            >
                              {isBlocked ? (
                                <>
                                  <UserCheck className="h-3.5 w-3.5" />
                                  Reativar
                                </>
                              ) : (
                                <>
                                  <UserX className="h-3.5 w-3.5" />
                                  Inativar
                                </>
                              )}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openEditUserModal(u)}
                            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            title="Editar RA, vínculo ou status cadastral"
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL: HISTÓRICO INDIVIDUAL DE RESERVAS DO USUÁRIO */}
      <AnimatePresence>
        {historyUser && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-user-history-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setHistoryUser(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h4 id="modal-user-history-title" className="text-base font-bold text-slate-900">
                    Histórico Individual de Reservas — {historyUser.nome}
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {historyUser.email}
                    {historyUser.ra ? ` · RA ${historyUser.ra}` : ''}
                    {historyUser.curso ? ` · ${historyUser.curso}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setHistoryUser(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* RESUMO NUMÉRICO DO USUÁRIO */}
              <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 grid grid-cols-3 gap-4 text-xs font-mono tabular-nums">
                <div>
                  <span className="text-slate-500 block font-sans">Total Agendado</span>
                  <span className="text-base font-bold text-slate-900">
                    {userReservations.length}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block font-sans">Confirmadas</span>
                  <span className="text-base font-bold text-emerald-700">
                    {
                      userReservations.filter(
                        (r) => r.status === 'CONFIRMADA' || r.status === 'CONCLUIDA'
                      ).length
                    }
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block font-sans">No-Show / Faltas</span>
                  <span className="text-base font-bold text-fatec-red">
                    {userReservations.filter((r) => r.status === 'PUNIDA').length}
                  </span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
                {loadingHistory ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="h-14 bg-slate-100 rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : userReservations.length === 0 ? (
                  <div className="py-14 text-center text-xs text-slate-500">
                    Este usuário ainda não possui reservas registradas no sistema.
                  </div>
                ) : (
                  userReservations.map((res) => {
                    const room = rooms.find((r) => r.firestoreId === res.salaId);
                    return (
                      <div
                        key={res.id}
                        className="p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-0.5">
                          <p className="text-sm font-bold text-slate-900">
                            {res.salaNome || room?.nome || 'Ambiente'}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                            <span>{formatDataBR(res.data)}</span>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1">
                              {res.inicio} <ArrowRight className="h-3 w-3" /> {res.fim}
                            </span>
                          </div>
                          {res.observacoes && (
                            <p className="text-xs text-slate-500 mt-1">{res.observacoes}</p>
                          )}
                        </div>

                        <div className="shrink-0 text-right">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 text-xs font-semibold',
                              res.status === 'CONFIRMADA' || res.status === 'CONCLUIDA'
                                ? 'text-emerald-700'
                                : res.status === 'PENDENTE'
                                ? 'text-amber-700'
                                : 'text-fatec-red'
                            )}
                          >
                            {res.status === 'CONFIRMADA' || res.status === 'CONCLUIDA' ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : res.status === 'PENDENTE' ? (
                              <Clock className="h-3.5 w-3.5" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" />
                            )}
                            {res.status === 'PUNIDA' ? 'NO-SHOW' : res.status}
                          </span>
                          {res.status === 'PUNIDA' && (
                            <p className="text-[11px] font-mono tabular-nums text-fatec-red mt-0.5">
                              {formatNoShowTag(res.blockedDate || res.data)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: EDIÇÃO CADASTRAL RÁPIDA (RA, VÍNCULO, CURSO, SEMESTRE, BLOQUEIO) */}
      <AnimatePresence>
        {editingUser && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-edit-user-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingUser(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h4 id="modal-edit-user-title" className="text-base font-bold text-slate-900">
                  Editar Cadastro Institucional
                </h4>
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSaveUserEdit} className="p-6 space-y-4">
                <div>
                  <p className="text-sm font-bold text-slate-900">{editingUser.nome}</p>
                  <p className="text-xs text-slate-500">{editingUser.email}</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    RA / Matrícula Institucional
                  </label>
                  <input
                    type="text"
                    value={editRa}
                    onChange={(e) => setEditRa(e.target.value)}
                    placeholder="Ex: 1090482411001"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                {editingUser.role !== 'ADMIN' && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700 block">
                        Vínculo Institucional
                      </label>
                      <select
                        value={editVinculo}
                        onChange={(e) => setEditVinculo(e.target.value as UserVinculo)}
                        className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                      >
                        <option value="ALUNO">Aluno / Estudante</option>
                        <option value="SERVIDOR">Servidor / Docente</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-slate-700 block">Curso</label>
                        <select
                          value={editCurso}
                          onChange={(e) => setEditCurso(e.target.value as CalendarCourse)}
                          className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                        >
                          <option value="GTI">GTI</option>
                          <option value="GEEE">GEEE</option>
                        </select>
                      </div>

                      {editVinculo === 'ALUNO' && (
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-slate-700 block">
                            Semestre
                          </label>
                          <select
                            value={editSemestre}
                            onChange={(e) => setEditSemestre(Number(e.target.value))}
                            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                          >
                            {[1, 2, 3, 4, 5, 6].map((s) => (
                              <option key={s} value={s}>
                                {s}º Semestre
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {editingUser.id !== currentUser?.id && (
                  <label className="flex items-center gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editBloqueado}
                      onChange={(e) => setEditBloqueado(e.target.checked)}
                      className="h-4 w-4 accent-fatec-red rounded"
                    />
                    Inativar / Bloquear acesso e reservas deste usuário
                  </label>
                )}

                <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingUser}
                    className="px-5 py-2.5 text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white rounded-xl cursor-pointer disabled:opacity-50"
                  >
                    {isSavingUser ? 'Salvando...' : 'Salvar Cadastro'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
