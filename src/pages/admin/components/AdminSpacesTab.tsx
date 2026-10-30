/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Plus,
  Search,
  Edit3,
  Trash2,
  Wrench,
  CheckCircle2,
  X,
  Building2,
  Users,
  Clock,
  Lock,
  Unlock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useRoomStore } from '../../../store/useRoomStore';
import { useReservationStore } from '../../../store/useReservationStore';
import { useScheduleStore } from '../../../store/useScheduleStore';
import {
  RealtimeSpaceStatus,
  Room,
  SpaceCategory,
  TimeBlock,
  inferSpaceCategory,
  resolveRoomRealtimeStatus,
} from '../../../types';
import { REALTIME_SPACE_STATUS_LABELS, SPACE_CATEGORY_LABELS } from '../../../constants';
import { cn } from '../../../lib/utils';
import { getFriendlyErrorMessage } from '../../../services/firebase/utils';

const FLOORS = ['Térreo', '1º andar', '2º andar'];
const CATEGORIES: { id: 'TODAS' | SpaceCategory; label: string }[] = [
  { id: 'TODAS', label: 'Todos' },
  { id: 'SALA', label: 'Salas' },
  { id: 'LABORATORIO', label: 'Laboratórios' },
  { id: 'AUDITORIO', label: 'Auditórios' },
  { id: 'ESPECIAL', label: 'Especiais' },
];

const REALTIME_STATUS_OPTIONS: RealtimeSpaceStatus[] = [
  'DISPONIVEL',
  'RESERVADO',
  'EM_USO',
  'MANUTENCAO',
];

/**
 * Aba 2 — Gestão Completa do Inventário de Espaços
 * Inclui formulário modal de Inclusão/Edição (Salas, Laboratórios, Auditórios),
 * alteração de status em tempo real e suspensão para manutenção com 1 clique.
 */
export function AdminSpacesTab() {
  const {
    rooms,
    loading,
    addRoom,
    updateRoom,
    setRoomRealtimeStatus,
    toggleMaintenanceOneClick,
    toggleRoomBookingRelease,
    deleteRoom,
    seedRooms,
  } = useRoomStore();
  const reservations = useReservationStore((state) => state.reservations);
  const scheduleConfig = useScheduleStore((state) => state.config);

  const [now, setNow] = useState(() => new Date());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'TODAS' | SpaceCategory>('TODAS');
  const [statusFilter, setStatusFilter] = useState<'TODOS' | RealtimeSpaceStatus>('TODOS');
  const [floorFilter, setFloorFilter] = useState<string>('TODOS');

  // Estados de Modal CRUD e Confirmação de Exclusão
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [useCustomRoomBlocks, setUseCustomRoomBlocks] = useState(false);
  const [roomBlocksDraft, setRoomBlocksDraft] = useState<TimeBlock[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);

  const openRoomModal = (room: Room | null) => {
    setEditingRoom(room);
    if (Array.isArray(room?.blocosHorarios) && room.blocosHorarios.length > 0) {
      setUseCustomRoomBlocks(true);
      setRoomBlocksDraft(room.blocosHorarios.map((b) => ({ ...b })));
    } else {
      setUseCustomRoomBlocks(false);
      setRoomBlocksDraft((scheduleConfig?.blocosPadrao || []).map((b) => ({ ...b })));
    }
    setIsModalOpen(true);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);

  const safeRooms = useMemo(() => (Array.isArray(rooms) ? rooms : []), [rooms]);

  const enrichedRooms = useMemo(() => {
    return safeRooms.map((room) => {
      const categoria = inferSpaceCategory(room);
      const realtime = resolveRoomRealtimeStatus(room, reservations, now);
      return {
        room,
        categoria,
        realtime,
      };
    });
  }, [safeRooms, reservations, now]);

  const filteredRooms = useMemo(() => {
    return enrichedRooms.filter(({ room, categoria, realtime }) => {
      if (!room) return false;
      if (categoryFilter !== 'TODAS' && categoria !== categoryFilter) return false;
      if (statusFilter !== 'TODOS' && realtime.status !== statusFilter) return false;
      if (floorFilter !== 'TODOS' && room.andar !== floorFilter) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const equips = Array.isArray(room.equipamentos) ? room.equipamentos.join(' ') : '';
        const hay = `${room.id || ''} ${room.codigo || ''} ${room.nome || ''} ${room.andar || ''} ${equips}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedRooms, categoryFilter, statusFilter, floorFilter, search]);

  const countsByStatus = useMemo(() => {
    const acc: Record<RealtimeSpaceStatus, number> = {
      DISPONIVEL: 0,
      RESERVADO: 0,
      EM_USO: 0,
      MANUTENCAO: 0,
    };
    enrichedRooms.forEach(({ realtime }) => {
      if (realtime?.status && acc[realtime.status] !== undefined) {
        acc[realtime.status]++;
      }
    });
    return acc;
  }, [enrichedRooms]);

  const handleRealtimeStatusChange = async (room: Room, nextStatus: RealtimeSpaceStatus) => {
    setBusyRoomId(room.firestoreId);
    try {
      await setRoomRealtimeStatus(room, nextStatus);
      toast.success(`Status de "${room.nome}" alterado para ${REALTIME_SPACE_STATUS_LABELS[nextStatus]}.`);
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Não foi possível alterar o status do espaço.'));
    } finally {
      setBusyRoomId(null);
    }
  };

  const handleOneClickMaintenance = async (room: Room, currentRealtimeStatus: RealtimeSpaceStatus) => {
    setBusyRoomId(room.firestoreId);
    try {
      await toggleMaintenanceOneClick(room);
      toast.success(
        currentRealtimeStatus === 'MANUTENCAO'
          ? `"${room.nome}" reativado e disponível para reservas.`
          : `"${room.nome}" suspenso temporariamente para manutenção.`
      );
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Falha ao alternar modo de manutenção.'));
    } finally {
      setBusyRoomId(null);
    }
  };

  const handleSaveRoom = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const chosenStatus = (fd.get('realtimeStatus') as RealtimeSpaceStatus) || 'DISPONIVEL';
    const blockDate = (fd.get('bloqueadaAteDate') as string) || '';
    const blockTime = (fd.get('bloqueadaAteTime') as string) || '';
    const motivoBloqueio = ((fd.get('motivoBloqueio') as string) || '').trim();

    let bloqueadaAte: number | null = null;
    if (blockDate && blockTime) {
      bloqueadaAte = new Date(`${blockDate}T${blockTime}`).getTime();
    }

    const payload: Omit<Room, 'firestoreId' | 'createdAt' | 'updatedAt'> = {
      id: ((fd.get('id') as string) || '').trim().toUpperCase(),
      codigo: ((fd.get('codigo') as string) || '').trim().toUpperCase(),
      nome: ((fd.get('nome') as string) || '').trim(),
      categoria: (fd.get('categoria') as SpaceCategory) || 'SALA',
      andar: (fd.get('andar') as string) || 'Térreo',
      capacidade: Math.max(1, Number(fd.get('capacidade')) || 30),
      descricao: ((fd.get('descricao') as string) || '').trim(),
      equipamentos: ((fd.get('equipamentos') as string) || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 15),
      imagem: editingRoom?.imagem || '/favicon.ico',
      status: chosenStatus === 'MANUTENCAO' ? 'MANUTENCAO' : 'ATIVO',
      liberadaParaReserva: fd.get('liberadaParaReserva') === 'on',
      blocosHorarios: useCustomRoomBlocks ? roomBlocksDraft.slice(0, 30) : [],
      statusManual: chosenStatus === 'DISPONIVEL' ? null : chosenStatus,
      bloqueadaAte,
      motivoBloqueio: motivoBloqueio || null,
    };

    try {
      if (editingRoom) {
        await updateRoom(editingRoom.firestoreId, payload);
        toast.success(`Espaço "${payload.nome}" atualizado com sucesso.`);
      } else {
        await addRoom(payload);
        toast.success(`Novo espaço "${payload.nome}" incluído no inventário.`);
      }
      setIsModalOpen(false);
      setEditingRoom(null);
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao salvar espaço no inventário.'));
    }
  };

  return (
    <div className="space-y-6">
      {/* RESUMO DO INVENTÁRIO + AÇÃO PRIMÁRIA */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white border border-slate-200 rounded-2xl p-6">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>{safeRooms.length} ambientes cadastrados</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-700 font-semibold">{countsByStatus.DISPONIVEL} disponíveis</span>
            <span aria-hidden="true">·</span>
            <span className="text-sky-700 font-semibold">{countsByStatus.RESERVADO} reservados</span>
            <span aria-hidden="true">·</span>
            <span className="text-fatec-red font-semibold">{countsByStatus.EM_USO} em uso</span>
            <span aria-hidden="true">·</span>
            <span className="text-amber-700 font-semibold">{countsByStatus.MANUTENCAO} em manutenção</span>
          </div>
          <h3 className="text-lg font-bold text-slate-900">Inventário Pedagógico de Espaços</h3>
          <p className="text-xs text-slate-500">
            Cadastre ou edite Salas, Laboratórios e Auditórios, altere o status operacional em tempo real ou suspenda ambientes com um clique.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {safeRooms.length === 0 && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await seedRooms();
                  toast.success('Inventário inicial padrão importado.');
                } catch (err) {
                  toast.error(getFriendlyErrorMessage(err, 'Erro ao importar salas padrão.'));
                }
              }}
              className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
            >
              Importar Salas Padrão
            </button>
          )}
          <button
            type="button"
            onClick={() => openRoomModal(null)}
            className="px-4 py-2.5 bg-fatec-red hover:bg-red-800 text-white rounded-xl text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Novo Espaço
          </button>
        </div>
      </div>

      {/* BARRA DE FILTROS E BUSCA */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* CATEGORIAS */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryFilter(cat.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                  categoryFilter === cat.id
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* FILTRO DE STATUS EM TEMPO REAL + ANDAR */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todos os Status</option>
              <option value="DISPONIVEL">Disponível</option>
              <option value="RESERVADO">Reservado</option>
              <option value="EM_USO">Em Uso</option>
              <option value="MANUTENCAO">Em Manutenção</option>
            </select>

            <select
              value={floorFilter}
              onChange={(e) => setFloorFilter(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-fatec-red"
            >
              <option value="TODOS">Todos os Andares</option>
              {FLOORS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar espaço por nome, código institucional (SALA-001, LAB-001), andar ou equipamento..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:bg-white focus:ring-2 focus:ring-fatec-red"
          />
        </div>
      </div>

      {/* TABELA DE ALTA DENSIDADE DO INVENTÁRIO */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {loading && rooms.length === 0 ? (
          <div className="p-8 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="p-14 text-center">
            <Building2 className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-800">Nenhum espaço encontrado</p>
            <p className="text-xs text-slate-500 mt-1">
              Ajuste os filtros aplicados ou cadastre um novo ambiente pedagógico.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="px-5 py-3.5">Ambiente / Código</th>
                  <th className="px-5 py-3.5">Categoria & Local</th>
                  <th className="px-5 py-3.5 text-right">Capacidade</th>
                  <th className="px-5 py-3.5">Liberação p/ Usuários</th>
                  <th className="px-5 py-3.5">Status em Tempo Real</th>
                  <th className="px-5 py-3.5">Manutenção Rápida</th>
                  <th className="px-5 py-3.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredRooms.map(({ room, categoria, realtime }) => {
                  const isBusy = busyRoomId === room.firestoreId;
                  const isMaint = realtime.status === 'MANUTENCAO';

                  return (
                    <tr key={room.firestoreId} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 truncate max-w-xs">
                            {room.nome}
                          </p>
                          <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                            <span className="font-mono tabular-nums font-semibold text-slate-700">
                              {room.id}
                            </span>
                            {room.codigo && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono">{room.codigo}</span>
                              </>
                            )}
                          </div>
                          {Array.isArray(room.equipamentos) && room.equipamentos.length > 0 && (
                            <p className="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">
                              {room.equipamentos.join(' · ')}
                            </p>
                          )}
                        </div>
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <p className="text-xs font-semibold text-slate-800">
                          {SPACE_CATEGORY_LABELS[categoria]}
                        </p>
                        <p className="text-xs text-slate-500">{room.andar}</p>
                      </td>

                      <td className="px-5 py-3.5 text-right font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3.5 w-3.5 text-slate-400" />
                          {room.capacidade}
                        </span>
                      </td>

                      {/* CONTROLE EXPLÍCITO DE LIBERAÇÃO P/ USUÁRIOS COMUNS */}
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={async () => {
                              setBusyRoomId(room.firestoreId);
                              try {
                                await toggleRoomBookingRelease(room);
                                toast.success(
                                  room.liberadaParaReserva === false
                                    ? `"${room.nome}" liberada para reservas de usuários.`
                                    : `"${room.nome}" bloqueada para reservas de usuários.`
                                );
                              } catch (err) {
                                toast.error(getFriendlyErrorMessage(err, 'Erro ao alterar liberação do espaço.'));
                              } finally {
                                setBusyRoomId(null);
                              }
                            }}
                            className={cn(
                              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer border',
                              room.liberadaParaReserva === false
                                ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                                : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200'
                            )}
                          >
                            {room.liberadaParaReserva === false ? (
                              <>
                                <Lock className="h-3.5 w-3.5" />
                                Bloqueada p/ Usuários
                              </>
                            ) : (
                              <>
                                <Unlock className="h-3.5 w-3.5" />
                                Liberada p/ Reserva
                              </>
                            )}
                          </button>
                          <span className="text-[11px] font-mono tabular-nums text-slate-500">
                            {Array.isArray(room.blocosHorarios) && room.blocosHorarios.length > 0
                              ? `${room.blocosHorarios.filter((b) => b.ativo).length} blocos próprios`
                              : 'Usa blocos globais ADM'}
                          </span>
                        </div>
                      </td>

                      {/* CONTROLE DE STATUS EM TEMPO REAL */}
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <select
                            disabled={isBusy}
                            value={realtime.status}
                            onChange={(e) =>
                              handleRealtimeStatusChange(
                                room,
                                e.target.value as RealtimeSpaceStatus
                              )
                            }
                            aria-label={`Status em tempo real de ${room.nome}`}
                            className={cn(
                              'px-3 py-1.5 rounded-lg text-xs font-semibold border outline-none transition-colors cursor-pointer w-40',
                              realtime.status === 'DISPONIVEL' &&
                                'bg-emerald-50 border-emerald-200 text-emerald-800',
                              realtime.status === 'RESERVADO' &&
                                'bg-sky-50 border-sky-200 text-sky-800',
                              realtime.status === 'EM_USO' &&
                                'bg-red-50 border-red-200 text-fatec-red',
                              realtime.status === 'MANUTENCAO' &&
                                'bg-amber-50 border-amber-200 text-amber-900'
                            )}
                          >
                            {REALTIME_STATUS_OPTIONS.map((st) => (
                              <option key={st} value={st}>
                                {REALTIME_SPACE_STATUS_LABELS[st]}
                              </option>
                            ))}
                          </select>
                          {realtime.currentReservation && (
                            <span className="text-[11px] font-mono tabular-nums text-slate-500">
                              Sessão até {realtime.currentReservation.fim}
                            </span>
                          )}
                          {realtime.isTemporarilyBlocked && room.bloqueadaAte && (
                            <span className="text-[11px] font-mono tabular-nums text-amber-700 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Até {new Date(room.bloqueadaAte).toLocaleString('pt-BR')}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* SUSPENSÃO COM 1 CLIQUE */}
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleOneClickMaintenance(room, realtime.status)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer border',
                            isMaint
                              ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'
                              : 'bg-slate-50 hover:bg-amber-50 text-slate-700 hover:text-amber-900 border-slate-200 hover:border-amber-300'
                          )}
                        >
                          {isMaint ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Reativar Espaço
                            </>
                          ) : (
                            <>
                              <Wrench className="h-3.5 w-3.5" />
                              Suspender p/ Manutenção
                            </>
                          )}
                        </button>
                      </td>

                      {/* EDITAR / EXCLUIR */}
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        {confirmDeleteId === room.firestoreId ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={async () => {
                                setBusyRoomId(room.firestoreId);
                                try {
                                  await deleteRoom(room.firestoreId, room.nome);
                                  setConfirmDeleteId(null);
                                  toast.success('Espaço removido do inventário.');
                                } catch (err) {
                                  toast.error(getFriendlyErrorMessage(err, 'Erro ao excluir espaço do inventário.'));
                                } finally {
                                  setBusyRoomId(null);
                                }
                              }}
                              className="px-2.5 py-1 bg-red-600 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
                            >
                              Excluir
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openRoomModal(room)}
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                              title="Editar espaço"
                            >
                              <Edit3 className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(room.firestoreId)}
                              className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                              title="Excluir espaço"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
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

      {/* MODAL DE INCLUSÃO E EDIÇÃO DE ESPAÇO */}
      <AnimatePresence>
        {isModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-space-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h4 id="modal-space-title" className="text-base font-bold text-slate-900">
                  {editingRoom ? `Editar Espaço: ${editingRoom.nome}` : 'Incluir Novo Espaço Acadêmico'}
                </h4>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form
                onSubmit={handleSaveRoom}
                className="p-6 space-y-4 max-h-[82vh] overflow-y-auto custom-scrollbar"
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Categoria do Espaço
                    </label>
                    <select
                      name="categoria"
                      defaultValue={editingRoom ? inferSpaceCategory(editingRoom) : 'SALA'}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    >
                      <option value="SALA">Sala de Aula</option>
                      <option value="LABORATORIO">Laboratório</option>
                      <option value="AUDITORIO">Auditório</option>
                      <option value="ESPECIAL">Espaço Especial</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      ID Institucional (QR Code)
                    </label>
                    <input
                      name="id"
                      required
                      defaultValue={editingRoom?.id || ''}
                      placeholder="Ex: SALA-013, LAB-010, AUD-002"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Código Curto
                    </label>
                    <input
                      name="codigo"
                      required
                      defaultValue={editingRoom?.codigo || ''}
                      placeholder="Ex: LAB-REDES"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Nome Oficial do Espaço
                    </label>
                    <input
                      name="nome"
                      required
                      defaultValue={editingRoom?.nome || ''}
                      placeholder="Ex: Laboratório de Redes e Cibersegurança"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Localização / Andar
                    </label>
                    <select
                      name="andar"
                      defaultValue={editingRoom?.andar || 'Térreo'}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    >
                      {FLOORS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Capacidade Máxima (Assentos)
                    </label>
                    <input
                      name="capacidade"
                      type="number"
                      min={1}
                      max={1000}
                      required
                      defaultValue={editingRoom?.capacidade || 40}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Status Operacional Inicial
                    </label>
                    <select
                      name="realtimeStatus"
                      defaultValue={
                        editingRoom
                          ? resolveRoomRealtimeStatus(editingRoom, reservations, now).status
                          : 'DISPONIVEL'
                      }
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    >
                      {REALTIME_STATUS_OPTIONS.map((st) => (
                        <option key={st} value={st}>
                          {REALTIME_SPACE_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Equipamentos e Infraestrutura (separados por vírgula)
                  </label>
                  <input
                    name="equipamentos"
                    defaultValue={Array.isArray(editingRoom?.equipamentos) ? editingRoom.equipamentos.join(', ') : ''}
                    placeholder="Ex: Projetor HD, 40 Computadores, Ar Condicionado, Lousa Branca"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Descrição Institucional
                  </label>
                  <textarea
                    name="descricao"
                    rows={2}
                    required
                    defaultValue={editingRoom?.descricao || ''}
                    placeholder="Finalidade pedagógica e orientações de uso do ambiente..."
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 resize-none outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                {/* LIBERAÇÃO PARA AGENDAMENTO DE USUÁRIOS E BLOCOS DE HORÁRIOS DA SALA */}
                <div className="p-4 bg-emerald-50/50 border border-emerald-200 rounded-xl space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      name="liberadaParaReserva"
                      defaultChecked={editingRoom ? editingRoom.liberadaParaReserva !== false : true}
                      className="mt-0.5 h-4 w-4 accent-emerald-600 rounded"
                    />
                    <div className="text-xs">
                      <span className="font-semibold text-emerald-950 block">
                        Sala liberada pelo ADM para visualização e reserva de usuários comuns
                      </span>
                      <span className="text-emerald-800">
                        Pré-requisito obrigatório: usuários comuns só visualizam e agendam salas liberadas com blocos de horários ativos.
                      </span>
                    </div>
                  </label>

                  <div className="pt-2 border-t border-emerald-200/70 space-y-2.5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800">
                        Blocos de Horários Liberados para Esta Sala
                      </span>
                      <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useCustomRoomBlocks}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setUseCustomRoomBlocks(next);
                            if (next && roomBlocksDraft.length === 0) {
                              setRoomBlocksDraft(
                                (scheduleConfig.blocosPadrao || []).map((b) => ({ ...b }))
                              );
                            }
                          }}
                          className="h-4 w-4 accent-fatec-red rounded"
                        />
                        Personalizar blocos exclusivos desta sala
                      </label>
                    </div>

                    {useCustomRoomBlocks ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {roomBlocksDraft.map((blk) => (
                          <button
                            key={blk.id}
                            type="button"
                            onClick={() =>
                              setRoomBlocksDraft((prev) =>
                                prev.map((item) =>
                                  item.id === blk.id ? { ...item, ativo: !item.ativo } : item
                                )
                              )
                            }
                            className={cn(
                              'px-2.5 py-2 rounded-lg border text-left text-xs transition-colors cursor-pointer',
                              blk.ativo
                                ? 'bg-white border-emerald-300 text-slate-900'
                                : 'bg-slate-100 border-slate-200 text-slate-400 line-through'
                            )}
                          >
                            <span className="block font-semibold truncate text-[11px]">
                              {blk.label}
                            </span>
                            <span className="font-mono tabular-nums text-[11px]">
                              {blk.inicio} – {blk.fim}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-600">
                        Herdando automaticamente os blocos ativos configurados na aba{' '}
                        <strong>Horários & Janelas</strong> (
                        {(scheduleConfig.blocosPadrao || []).filter((b) => b.ativo).length} blocos ativos).
                      </p>
                    )}
                  </div>
                </div>

                {/* BLOQUEIO PROGRAMADO OPCIONAL */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">
                      Suspensão Programada com Retorno Automático (Opcional)
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Se preenchido, o espaço ficará indisponível até a data/hora limite e retornará automaticamente ao expirar.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                        Data Limite
                      </label>
                      <input
                        name="bloqueadaAteDate"
                        type="date"
                        defaultValue={
                          editingRoom?.bloqueadaAte
                            ? new Date(editingRoom.bloqueadaAte).toLocaleDateString('en-CA')
                            : ''
                        }
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono tabular-nums outline-none focus:ring-2 focus:ring-fatec-red"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                        Horário Limite
                      </label>
                      <input
                        name="bloqueadaAteTime"
                        type="time"
                        defaultValue={
                          editingRoom?.bloqueadaAte
                            ? new Date(editingRoom.bloqueadaAte).toTimeString().slice(0, 5)
                            : ''
                        }
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono tabular-nums outline-none focus:ring-2 focus:ring-fatec-red"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                        Motivo da Manutenção
                      </label>
                      <input
                        name="motivoBloqueio"
                        type="text"
                        placeholder="Ex: Reparo elétrico"
                        defaultValue={editingRoom?.motivoBloqueio || ''}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-fatec-red"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2.5 text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white rounded-xl cursor-pointer"
                  >
                    {editingRoom ? 'Salvar Alterações' : 'Cadastrar Espaço'}
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
