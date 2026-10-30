/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  ShieldAlert,
  ShieldCheck,
  Ban,
  Calendar,
  X,
  UserCheck,
  AlertTriangle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '../../../services/firebase/config';
import { usePunishmentStore } from '../../../store/usePunishmentStore';
import { useReservationStore } from '../../../store/useReservationStore';
import { PunishmentCategory, User } from '../../../types';
import { PUNISHMENT_CATEGORY_LABELS, USER_VINCULO_LABELS } from '../../../constants';
import { formatNoShowTag } from '../../../services/reservationService';
import { formatDataBR, getTodayLocalISO, normalizeDateToISO } from '../../../utils/dateUtils';
import { getFriendlyErrorMessage } from '../../../services/firebase/utils';
import { cn } from '../../../lib/utils';

interface AdminModerationTabProps {
  externalUsers?: User[];
}

/**
 * Aba 3 — Painel de Moderação e Aplicação de Punições / Restrições (Regra do Dia Faltante)
 * - Elimina suspensões cumulativas por múltiplos dias ou semanas.
 * - Registra bloqueios de No-Show ou restrições pontuais estritamente para uma única data (`blockedDate`).
 * - Exibe no card de cada usuário a tag oficial `Punição de No-Show: Bloqueado apenas em DD/MM/AAAA` e o motivo registrado.
 */
export function AdminModerationTab({ externalUsers }: AdminModerationTabProps) {
  const [internalUsers, setInternalUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(!externalUsers);
  const [todayISO, setTodayISO] = useState(() => getTodayLocalISO());

  const {
    punishments: rawPunishments,
    fetchPunishments,
    applyManualPunishment,
    revokeUserPunishment,
  } = usePunishmentStore();
  const punishments = Array.isArray(rawPunishments) ? rawPunishments : [];
  const rawReservations = useReservationStore((state) => state.reservations);
  const reservations = Array.isArray(rawReservations) ? rawReservations : [];

  const [search, setSearch] = useState('');
  const [vinculoFilter, setVinculoFilter] = useState<'TODOS' | 'ALUNO' | 'SERVIDOR'>('TODOS');
  const [statusFilter, setStatusFilter] = useState<'TODOS' | 'RESTRITOS' | 'REGULARES' | 'NO_SHOW'>('TODOS');

  // Modal de Aplicação de Restrição Pontual (Data Única)
  const [targetUser, setTargetUser] = useState<User | null>(null);
  const [blockedDate, setBlockedDate] = useState<string>(() => getTodayLocalISO());
  const [categoriaMotivo, setCategoriaMotivo] = useState<PunishmentCategory>('NO_SHOW');
  const [motivoTexto, setMotivoTexto] = useState('');
  const [bloquearConta, setBloquearConta] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setTodayISO(getTodayLocalISO()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const unsubPunishments = fetchPunishments();
    return () => {
      try {
        unsubPunishments();
      } catch {
        // Ignora falha de encerramento de listener
      }
    };
  }, [fetchPunishments]);

  useEffect(() => {
    if (externalUsers) {
      setLoadingUsers(false);
      return;
    }
    const q = query(collection(db, 'users'), orderBy('nome', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setInternalUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as User)));
        setLoadingUsers(false);
      },
      () => setLoadingUsers(false)
    );
    return () => {
      try {
        unsub();
      } catch {
        // Ignora falha de encerramento de listener
      }
    };
  }, [externalUsers]);

  const users = Array.isArray(externalUsers)
    ? externalUsers
    : Array.isArray(internalUsers)
    ? internalUsers
    : [];

  // Contabiliza faltas (no-show) por usuário a partir das reservas PUNIDA
  const noShowCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    reservations.forEach((r) => {
      if (r?.status === 'PUNIDA' && r?.usuarioId) {
        map[r.usuarioId] = (map[r.usuarioId] || 0) + 1;
      }
    });
    return map;
  }, [reservations]);

  const moderatableUsers = useMemo(() => {
    return users
      .filter((u) => u && u.role !== 'ADMIN')
      .filter((u) => {
        const vinculo = u?.tipoVinculo || 'ALUNO';
        if (vinculoFilter !== 'TODOS' && vinculo !== vinculoFilter) return false;

        const normBlocked = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
        const isDatePunished = Boolean(normBlocked && normBlocked >= todayISO);
        const isRestricted = isDatePunished || Boolean(u.bloqueado || u.inativo);
        const userNoShows = noShowCountMap[u.id] || 0;

        if (statusFilter === 'RESTRITOS' && !isRestricted) return false;
        if (statusFilter === 'REGULARES' && isRestricted) return false;
        if (statusFilter === 'NO_SHOW' && userNoShows === 0 && !normBlocked) return false;

        if (search.trim()) {
          const q = search.toLowerCase();
          const hay = `${u.nome || ''} ${u.email || ''} ${u.ra || ''} ${u.curso || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [users, vinculoFilter, statusFilter, search, todayISO, noShowCountMap]);

  const restrictedTotal = useMemo(
    () =>
      users.filter((u) => {
        if (u.role === 'ADMIN') return false;
        const normBlocked = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
        return Boolean((normBlocked && normBlocked >= todayISO) || u.bloqueado || u.inativo);
      }).length,
    [users, todayISO]
  );

  const openPunishModal = (u: User) => {
    const currentToday = getTodayLocalISO();
    const normExisting = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
    setTargetUser(u);
    setBlockedDate(normExisting && normExisting >= currentToday ? normExisting : currentToday);
    setCategoriaMotivo((noShowCountMap[u.id] || 0) > 0 ? 'NO_SHOW' : 'DESCUMPRIMENTO_NORMAS');
    setMotivoTexto('');
    setBloquearConta(Boolean(u.bloqueado));
  };

  const handleConfirmPunishment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUser) return;
    if (!blockedDate) {
      toast.error('Selecione a data exata em que o bloqueio de reservas será aplicado.');
      return;
    }
    if (!motivoTexto.trim()) {
      toast.error('Informe a justificativa detalhada para registro disciplinar.');
      return;
    }

    setIsSubmitting(true);
    try {
      const fullReason = `[${PUNISHMENT_CATEGORY_LABELS[categoriaMotivo]}] ${motivoTexto.trim()}`;
      await applyManualPunishment({
        targetUser,
        blockedDate,
        categoriaMotivo,
        motivo: fullReason,
        bloquearConta,
      });
      toast.success(
        `Restrição registrada para ${targetUser.nome}: bloqueado apenas em ${formatDataBR(blockedDate)}.`
      );
      setTargetUser(null);
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao registrar restrição no perfil do usuário.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevoke = async (u: User) => {
    try {
      await revokeUserPunishment(u, 'Liberação manual pela Coordenação');
      toast.success(`Restrição de ${u?.nome || 'usuário'} revogada com sucesso.`);
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Não foi possível revogar a restrição.'));
    }
  };

  return (
    <div className="space-y-8">
      {/* CABEÇALHO DE MODERAÇÃO */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>{users.filter((u) => u.role !== 'ADMIN').length} alunos e servidores monitorados</span>
            <span aria-hidden="true">·</span>
            <span className="text-red-700 font-semibold">
              {restrictedTotal} com bloqueio do dia ou conta suspensa
            </span>
            <span aria-hidden="true">·</span>
            <span>{punishments.length} ocorrências no livro disciplinar</span>
          </div>
          <h3 className="text-lg font-bold text-slate-900">
            Central de Moderação e Punição de No-Show (Bloqueio por Data Única)
          </h3>
          <p className="text-xs text-slate-500">
            Em conformidade com a regra de governança, o bloqueio por No-Show restringe novas reservas exclusivamente na data exata da falta, preservando datas futuras e a cota semanal.
          </p>
        </div>
      </div>

      {/* BARRA DE BUSCA E FILTROS */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            {(
              [
                { id: 'TODOS', label: 'Todos os Perfis' },
                { id: 'RESTRITOS', label: 'Bloqueados Hoje / Conta Inativa' },
                { id: 'NO_SHOW', label: 'Com Histórico de No-Show' },
                { id: 'REGULARES', label: 'Situação Regular' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                  statusFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select
              value={vinculoFilter}
              onChange={(e) => setVinculoFilter(e.target.value as any)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Alunos e Servidores</option>
              <option value="ALUNO">Somente Alunos</option>
              <option value="SERVIDOR">Somente Servidores</option>
            </select>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar aluno ou servidor por nome, e-mail institucional, RA ou curso..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:bg-white focus:ring-2 focus:ring-fatec-red"
          />
        </div>
      </div>

      {/* CARDS DE PERFIL E STATUS DE BLOQUEIO DOS USUÁRIOS */}
      {loadingUsers ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 bg-white border border-slate-200 rounded-2xl p-5 animate-pulse" />
          ))}
        </div>
      ) : moderatableUsers.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <UserCheck className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-800">
            Nenhum usuário encontrado para o filtro selecionado
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Altere os termos da pesquisa ou selecione outra categoria de situação cadastral.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {moderatableUsers.map((u) => {
            const normBlocked = u.blockedDate ? normalizeDateToISO(u.blockedDate) : '';
            const isDatePunished = Boolean(normBlocked && normBlocked >= todayISO);
            const hasPastBlockedRecord = Boolean(normBlocked && normBlocked < todayISO);
            const isAccountBlocked = Boolean(u.bloqueado || u.inativo);
            const isRestricted = isDatePunished || isAccountBlocked;
            const userNoShows = noShowCountMap[u.id] || 0;
            const vinculo = u.tipoVinculo || 'ALUNO';

            return (
              <div
                key={u.id}
                className={cn(
                  'bg-white rounded-2xl border p-5 flex flex-col justify-between gap-4 transition-colors',
                  isRestricted ? 'border-red-200' : 'border-slate-200'
                )}
              >
                <div className="space-y-3">
                  {/* IDENTIFICAÇÃO DO USUÁRIO */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-slate-900 truncate">{u.nome}</h4>
                      <p className="text-xs text-slate-500 truncate">{u.email}</p>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 mt-1.5">
                        <span>{USER_VINCULO_LABELS[vinculo]}</span>
                        {u.ra && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums font-semibold text-slate-700">
                              RA {u.ra}
                            </span>
                          </>
                        )}
                        {u.curso && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {u.curso}
                              {u.semestre ? ` ${u.semestre}º Sem` : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* STATUS SEMÂNTICO COM ÍCONE + RÓTULO */}
                    <div className="shrink-0 text-right">
                      {isAccountBlocked ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
                          <Ban className="h-3.5 w-3.5" />
                          Conta Inativa
                        </span>
                      ) : isDatePunished ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Bloqueio do Dia
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Regular
                        </span>
                      )}
                      {userNoShows > 0 && (
                        <p className="text-[11px] font-mono tabular-nums text-slate-500 mt-0.5">
                          {userNoShows} {userNoShows === 1 ? 'falta (no-show)' : 'faltas (no-show)'}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* DETALHES DA PUNIÇÃO DO DIA OU REGISTRO ANTERIOR */}
                  {isRestricted ? (
                    <div className="p-3.5 rounded-xl bg-red-50/70 border border-red-100 space-y-1.5 text-xs">
                      <div className="flex items-center gap-1.5 text-red-900 font-semibold">
                        <Calendar className="h-3.5 w-3.5 text-fatec-red shrink-0" />
                        <span>
                          {isDatePunished && normBlocked
                            ? formatNoShowTag(normBlocked)
                            : 'Bloqueio Integral de Conta Ativo'}
                        </span>
                      </div>
                      <p className="text-slate-700 leading-relaxed">
                        <span className="font-semibold text-slate-900">Motivo registrado: </span>
                        {u.motivoPunicao || 'Restrição aplicada pela Coordenação.'}
                      </p>
                      {isDatePunished && !isAccountBlocked && (
                        <p className="text-[11px] text-slate-600">
                          Datas futuras e cota semanal permanecem liberadas.
                        </p>
                      )}
                    </div>
                  ) : hasPastBlockedRecord ? (
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-0.5">
                      <p className="font-semibold text-slate-800">{formatNoShowTag(normBlocked)}</p>
                      <p className="text-[11px] text-slate-500">
                        Data encerrada — usuário apto a agendar normalmente.
                      </p>
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-500">
                      Habilitado para realizar reservas dentro das salas e blocos liberados pelo ADM.
                    </div>
                  )}
                </div>

                {/* BOTÕES DE AÇÃO DE MODERAÇÃO */}
                <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                  {isRestricted ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleRevoke(u)}
                        className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Revogar Restrição
                      </button>
                      <button
                        type="button"
                        onClick={() => openPunishModal(u)}
                        className="py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Alterar Data
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openPunishModal(u)}
                      className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-fatec-red text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Aplicar Restrição Pontual (Data Única)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* HISTÓRICO DISCIPLINAR DA COLEÇÃO `punishments` */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-base font-bold text-slate-900">
            Registro Histórico de Punições por Data (`punishments`)
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Histórico auditável de punições automáticas de No-Show e restrições manuais aplicadas exclusivamente ao dia faltante.
          </p>
        </div>

        {punishments.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            Nenhuma punição registrada no histórico até o momento.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="px-5 py-3">Usuário</th>
                  <th className="px-5 py-3">Origem</th>
                  <th className="px-5 py-3">Motivo Registrado</th>
                  <th className="px-5 py-3">Tag de Bloqueio (Data Única)</th>
                  <th className="px-5 py-3">Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {punishments.slice(0, 25).map((p) => {
                  const pDate = p.blockedDate ? normalizeDateToISO(p.blockedDate) : todayISO;
                  const stillActive = p.ativa && pDate >= todayISO;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3">
                        <p className="font-semibold text-slate-900 text-xs">{p.usuarioNome}</p>
                        {p.usuarioEmail && (
                          <p className="text-[11px] text-slate-500">{p.usuarioEmail}</p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-600 whitespace-nowrap">
                        {p.tipo === 'MANUAL'
                          ? `Manual (${p.aplicadoPorNome || 'ADM'})`
                          : 'Automática (No-Show)'}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-700 max-w-md">{p.motivo}</td>
                      <td className="px-5 py-3 text-xs font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {formatNoShowTag(pDate)}
                      </td>
                      <td className="px-5 py-3 text-xs whitespace-nowrap">
                        {stillActive ? (
                          <span className="font-semibold text-red-700">Vigente em {formatDataBR(pDate)}</span>
                        ) : !p.ativa && p.revogadaEm ? (
                          <span className="text-slate-500">Revogada</span>
                        ) : (
                          <span className="text-emerald-700">Data encerrada</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL DE APLICAÇÃO DE PUNIÇÃO / RESTRIÇÃO EXCLUSIVA PARA UMA DATA */}
      <AnimatePresence>
        {targetUser && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-punicao-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setTargetUser(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <AlertTriangle className="h-5 w-5 text-fatec-red" />
                  <h4 id="modal-punicao-title" className="text-base font-bold text-slate-900">
                    Aplicar Bloqueio por Data Única (Regra No-Show)
                  </h4>
                </div>
                <button
                  type="button"
                  onClick={() => setTargetUser(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleConfirmPunishment} className="p-6 space-y-5">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-0.5">
                  <p className="font-bold text-slate-900 text-sm">{targetUser.nome}</p>
                  <p className="text-slate-500">
                    {targetUser.email}
                    {targetUser.ra ? ` · RA ${targetUser.ra}` : ''}
                    {targetUser.curso ? ` · ${targetUser.curso}` : ''}
                  </p>
                </div>

                {/* DATA EXCLUSIVA DO BLOQUEIO (SEM SUSPENSÃO MULTI-DIAS) */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Data Exata do Bloqueio de Reservas
                  </label>
                  <input
                    type="date"
                    required
                    min={todayISO}
                    value={blockedDate}
                    onChange={(e) => setBlockedDate(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                  {blockedDate && (
                    <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900 space-y-0.5">
                      <p className="font-semibold">{formatNoShowTag(blockedDate)}</p>
                      <p className="text-[11px] text-rose-800">
                        O usuário ficará impedido de reservar salas exclusivamente nesta data. Datas seguintes e sua cota semanal permanecem liberadas.
                      </p>
                    </div>
                  )}
                </div>

                {/* ENQUADRAMENTO DISCIPLINAR */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Enquadramento da Ocorrência
                  </label>
                  <select
                    value={categoriaMotivo}
                    onChange={(e) => setCategoriaMotivo(e.target.value as PunishmentCategory)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  >
                    {(Object.keys(PUNISHMENT_CATEGORY_LABELS) as PunishmentCategory[]).map((cat) => (
                      <option key={cat} value={cat}>
                        {PUNISHMENT_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* JUSTIFICATIVA OBRIGATÓRIA */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Justificativa Detalhada (Exibida no Perfil do Usuário)
                  </label>
                  <textarea
                    rows={3}
                    required
                    placeholder="Descreva a ocorrência (ex: Ausência sem cancelamento prévio na reserva da data informada)..."
                    value={motivoTexto}
                    onChange={(e) => setMotivoTexto(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 resize-none outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                {/* OPÇÃO DE BLOQUEIO INTEGRAL DA CONTA */}
                <label className="flex items-start gap-3 p-3.5 bg-red-50/60 border border-red-100 rounded-xl cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bloquearConta}
                    onChange={(e) => setBloquearConta(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-fatec-red rounded"
                  />
                  <div className="text-xs">
                    <span className="font-semibold text-red-950 block">
                      Inativar conta administrativamente (Bloqueio Integral)
                    </span>
                    <span className="text-red-800">
                      Use apenas em infrações graves. Se desmarcado, aplica-se somente o bloqueio pontual na data selecionada acima.
                    </span>
                  </div>
                </label>

                <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setTargetUser(null)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2.5 text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {isSubmitting ? 'Registrando...' : 'Confirmar Bloqueio da Data'}
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
