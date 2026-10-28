/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Plus,
  Search,
  Building2,
  Users,
  Wifi,
  Edit,
  Trash2,
  X,
  Layers,
  Clock,
  Calendar,
  Wrench,
  CheckCircle2,
  Lock,
  Unlock,
  AlertCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useRoomStore } from '../../store/useRoomStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useReservationStore } from '../../store/useReservationStore';
import { useScheduleStore } from '../../store/useScheduleStore';
import { usePunishmentStore } from '../../store/usePunishmentStore';
import { useLogStore } from '../../store/useLogStore';
import {
  Room,
  RoomStatus,
  SpaceCategory,
  inferSpaceCategory,
  resolveRoomRealtimeStatus,
} from '../../types';
import { REALTIME_SPACE_STATUS_LABELS, SPACE_CATEGORY_LABELS } from '../../constants';
import { cn } from '../../lib/utils';
import { INITIAL_ROOMS } from '../../data/initialRooms';
import {
  validateReservationRules,
  isBookingWindowOpen,
  getReservationDateLimits,
} from '../../utils/reservationRules';
import {
  checkNoShowSuspensionForDate,
  checkWeeklyQuotaLocal,
  formatNoShowTag,
  getReleasedBlocksForRoomOnDate,
  getUserNoShowBlockedDate,
  isSpaceReleasedByAdmin,
} from '../../services/reservationService';
import { formatDataBR, createSafeLocalDateTime } from '../../utils/dateUtils';

const FLOORS = ['Térreo', '1º andar', '2º andar'];
const DEFAULT_ROOM_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600' viewBox='0 0 800 600'%3E%3Crect width='800' height='600' fill='%230f172a'/%3E%3C/svg%3E";

export function SalasPage() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const rooms = useRoomStore((state) => state.rooms);
  const loading = useRoomStore((state) => state.loading);
  const fetchRooms = useRoomStore((state) => state.fetchRooms);
  const addRoom = useRoomStore((state) => state.addRoom);
  const updateRoom = useRoomStore((state) => state.updateRoom);
  const deleteRoom = useRoomStore((state) => state.deleteRoom);
  const toggleMaintenanceOneClick = useRoomStore((state) => state.toggleMaintenanceOneClick);
  const toggleRoomBookingRelease = useRoomStore((state) => state.toggleRoomBookingRelease);

  const user = useAuthStore((state) => state.user);

  const reservations = useReservationStore((state) => state.reservations);
  const fetchReservations = useReservationStore((state) => state.fetchReservations);
  const addReservation = useReservationStore((state) => state.addReservation);

  const punishments = usePunishmentStore((state) => state.punishments);
  const activePunishment = usePunishmentStore((state) => state.activePunishment);
  const fetchUserPunishments = usePunishmentStore((state) => state.fetchUserPunishments);

  // Subscribe to schedule config & exceptions so booking modal reacts immediately to ADM changes
  const scheduleConfig = useScheduleStore((state) => state.config);
  const scheduleExceptions = useScheduleStore((state) => state.exceptions);

  const isAdmin = user?.role === 'ADMIN';
  const effectivePunishments = React.useMemo(() => {
    if (isAdmin) return punishments;
    return activePunishment ? [activePunishment] : [];
  }, [isAdmin, punishments, activePunishment]);

  const [search, setSearch] = useState('');
  const [selectedFloor, setSelectedFloor] = useState<string | 'Todos'>('Todos');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [bookingRoom, setBookingRoom] = useState<Room | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const dateLimits = getReservationDateLimits(now);
  const windowStatus = isBookingWindowOpen(now, isAdmin);
  const [selectedBookingDate, setSelectedBookingDate] = useState(dateLimits.minDate);
  const [bookingStartTime, setBookingStartTime] = useState(scheduleConfig.janelaInicio || '17:00');
  const [bookingEndTime, setBookingEndTime] = useState('18:40');

  // Cota semanal atual (Segunda a Domingo) e status de No-Show do usuário logado
  const currentWeekQuota = React.useMemo(() => {
    if (!user || isAdmin) return null;
    return checkWeeklyQuotaLocal(reservations, user.id, dateLimits.todayStr);
  }, [reservations, user, isAdmin, dateLimits.todayStr]);

  const userBlockedDate = React.useMemo(
    () => getUserNoShowBlockedDate(user, effectivePunishments),
    [user, effectivePunishments]
  );

  // Salas visíveis: usuários comuns SÓ visualizam salas explicitamente liberadas pelo ADM
  const visibleRooms = React.useMemo(() => {
    if (isAdmin) return rooms;
    return rooms.filter((r) => isSpaceReleasedByAdmin(r, now).released);
  }, [rooms, isAdmin, now]);

  const openBookingModal = (room: Room) => {
    if (user?.bloqueado || user?.inativo) {
      toast.error('Sua conta está inativa ou bloqueada e não pode realizar reservas.');
      return;
    }
    if (!isAdmin) {
      const spaceCheck = isSpaceReleasedByAdmin(room, new Date());
      if (!spaceCheck.released) {
        toast.error(spaceCheck.reason || 'Esta sala não está liberada pelo ADM para reservas.');
        return;
      }
    }
    const check = isBookingWindowOpen(new Date(), isAdmin);
    if (!check.isOpen) {
      toast.error(check.message);
      return;
    }
    const currentLimits = getReservationDateLimits(new Date());
    const initialDate =
      !isAdmin && userBlockedDate === currentLimits.todayStr && currentLimits.tomorrowStr <= currentLimits.maxDate
        ? currentLimits.tomorrowStr
        : currentLimits.minDate;

    const releaseInfo = getReleasedBlocksForRoomOnDate(
      room,
      initialDate,
      scheduleConfig,
      scheduleExceptions,
      new Date()
    );
    setSelectedBookingDate(initialDate);
    if (releaseInfo.blocks.length > 0) {
      setBookingStartTime(releaseInfo.blocks[0].inicio);
      setBookingEndTime(releaseInfo.blocks[0].fim);
    } else {
      setBookingStartTime('');
      setBookingEndTime('');
    }
    setBookingRoom(room);
  };

  const blockRelease = React.useMemo(
    () =>
      getReleasedBlocksForRoomOnDate(
        bookingRoom,
        selectedBookingDate,
        scheduleConfig,
        scheduleExceptions,
        now
      ),
    [bookingRoom, selectedBookingDate, scheduleConfig, scheduleExceptions, now]
  );

  const selectedDateQuota = React.useMemo(() => {
    if (!user || isAdmin) return null;
    return checkWeeklyQuotaLocal(reservations, user.id, selectedBookingDate);
  }, [reservations, user, isAdmin, selectedBookingDate]);

  const selectedDateNoShow = React.useMemo(
    () => checkNoShowSuspensionForDate(user, effectivePunishments, selectedBookingDate),
    [user, effectivePunishments, selectedBookingDate]
  );

  // Atualiza automaticamente o bloco selecionado quando o usuário troca a data no modal
  useEffect(() => {
    if (!bookingRoom) return;
    const rel = getReleasedBlocksForRoomOnDate(
      bookingRoom,
      selectedBookingDate,
      scheduleConfig,
      scheduleExceptions
    );
    if (rel.blocks.length > 0) {
      const stillValid = rel.blocks.some(
        (b) => b.inicio === bookingStartTime && b.fim === bookingEndTime
      );
      if (!stillValid) {
        setBookingStartTime(rel.blocks[0].inicio);
        setBookingEndTime(rel.blocks[0].fim);
      }
    } else if (!isAdmin) {
      setBookingStartTime('');
      setBookingEndTime('');
    }
  }, [selectedBookingDate, bookingRoom, scheduleConfig, scheduleExceptions, isAdmin]);

  const existingBookingsForSelectedDate = bookingRoom
    ? reservations
        .filter(
          (r) =>
            (r.salaId === bookingRoom.firestoreId || r.salaInstitutionalId === bookingRoom.id) &&
            r.data === selectedBookingDate &&
            (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
        )
        .sort((a, b) => a.inicio.localeCompare(b.inicio))
    : [];

  useEffect(() => {
    const unsubRooms = fetchRooms();
    const unsubReservations = fetchReservations();
    const unsubUserPunishments =
      user && !isAdmin ? fetchUserPunishments(user.id) : () => {};
    return () => {
      unsubRooms();
      unsubReservations();
      unsubUserPunishments();
    };
  }, [fetchRooms, fetchReservations, fetchUserPunishments, user?.id, isAdmin]);

  // Automatic standardization restricted strictly to ADMIN clients to respect Firestore write rules
  useEffect(() => {
    if (!isAdmin || rooms.length === 0) return;

    const autoStandardize = async () => {
      let updatedSomething = false;
      const { updateReservation } = useReservationStore.getState();

      for (const room of rooms) {
        const roomLower = room.nome
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        const normId = room.id.toUpperCase().trim();
        let targetMatch = null;

        if (
          roomLower.includes('informatica 02 a') ||
          roomLower.includes('informatica 2 a') ||
          normId === 'LAB-002A'
        ) {
          targetMatch = INITIAL_ROOMS.find((x) => x.id === 'LAB-002A');
        } else if (roomLower.includes('braile a') || normId === 'BRA-001A') {
          targetMatch = INITIAL_ROOMS.find((x) => x.id === 'BRA-001A');
        } else if (roomLower.includes('quimica') || normId === 'QUI-001') {
          targetMatch = INITIAL_ROOMS.find((x) => x.id === 'QUI-001');
        } else if (
          roomLower.includes('autocad a') ||
          roomLower.includes('cad a') ||
          normId === 'CAD-001A'
        ) {
          targetMatch = INITIAL_ROOMS.find((x) => x.id === 'CAD-001A');
        }

        if (targetMatch) {
          const isStandardized =
            room.id === targetMatch.id &&
            room.nome === targetMatch.nome &&
            room.codigo === targetMatch.codigo &&
            room.capacidade === targetMatch.capacidade &&
            room.descricao === targetMatch.descricao &&
            room.imagem === targetMatch.imagem;

          if (!isStandardized) {
            await updateRoom(room.firestoreId, {
              id: targetMatch.id,
              nome: targetMatch.nome,
              codigo: targetMatch.codigo,
              capacidade: targetMatch.capacidade,
              descricao: targetMatch.descricao,
              equipamentos: targetMatch.equipamentos,
              imagem: targetMatch.imagem,
            });

            const roomReservations = reservations.filter((r) => r.salaId === room.firestoreId);
            for (const res of roomReservations) {
              if (
                res.salaInstitutionalId !== targetMatch.id ||
                res.salaNome !== targetMatch.nome
              ) {
                await updateReservation(res.id, {
                  salaInstitutionalId: targetMatch.id,
                  salaNome: targetMatch.nome,
                });
              }
            }

            await useLogStore.getState().addLog({
              acao: 'PADRONIZACAO_SALA',
              usuarioId: 'SISTEMA_AUTO',
              usuarioNome: 'Sistema (Padronização Automática)',
              entidade: 'SALAS',
              detalhes: `Padronização automática realizada para sala ${room.nome} -> ${targetMatch.nome} (ID: ${targetMatch.id})`,
            });

            updatedSomething = true;
          }
        }
      }

      if (updatedSomething) {
        toast.success('Padronização institucional de ambientes aplicada com sucesso.');
      }
    };

    autoStandardize();
  }, [isAdmin, rooms, reservations, updateRoom]);

  const roomsByFloor = FLOORS.reduce((acc, floor) => {
    const floorRooms = visibleRooms.filter(
      (r) =>
        r.andar === floor &&
        (search === '' ||
          r.nome.toLowerCase().includes(search.toLowerCase()) ||
          r.id.toLowerCase().includes(search.toLowerCase()) ||
          r.codigo.toLowerCase().includes(search.toLowerCase()))
    );
    if (floorRooms.length > 0) {
      acc[floor] = floorRooms;
    }
    return acc;
  }, {} as Record<string, Room[]>);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const roomData: any = {
      id: (formData.get('id') as string).trim(),
      codigo: (formData.get('codigo') as string).trim(),
      nome: (formData.get('nome') as string).trim(),
      categoria: (formData.get('categoria') as SpaceCategory) || 'SALA',
      andar: formData.get('andar') as string,
      capacidade: Number(formData.get('capacidade')),
      descricao: (formData.get('descricao') as string).trim(),
      status: formData.get('status') as RoomStatus,
      equipamentos: (formData.get('equipamentos') as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20),
      imagem: (formData.get('imagem') as string) || DEFAULT_ROOM_COVER,
    };

    if (isAdmin) {
      roomData.liberadaParaReserva = formData.get('liberadaParaReserva') === 'on';
      const blockDate = formData.get('bloqueadaAteDate') as string;
      const blockTime = formData.get('bloqueadaAteTime') as string;
      if (blockDate && blockTime) {
        roomData.bloqueadaAte = new Date(`${blockDate}T${blockTime}`).getTime();
      } else {
        roomData.bloqueadaAte = null;
      }
    }

    try {
      if (editingRoom) {
        await updateRoom(editingRoom.firestoreId, roomData);
        toast.success('Ambiente atualizado.');
      } else {
        await addRoom(roomData);
        toast.success('Ambiente cadastrado.');
      }
      setIsModalOpen(false);
      setEditingRoom(null);
    } catch (err: any) {
      console.error('Room save error:', err);
      toast.error('Erro ao salvar dados do ambiente.');
    }
  };

  const handleConfirmDelete = async (room: Room) => {
    try {
      await deleteRoom(room.firestoreId, room.nome);
      setConfirmDeleteId(null);
      toast.success('Ambiente removido do inventário.');
    } catch {
      toast.error('Erro ao excluir ambiente.');
    }
  };

  const handleBooking = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !bookingRoom) return;

    if (user.bloqueado || user.inativo) {
      toast.error('Sua conta está inativa ou bloqueada e não pode realizar reservas.');
      return;
    }

    if (!isAdmin) {
      if (selectedDateNoShow.blocked) {
        toast.error(selectedDateNoShow.error || formatNoShowTag(selectedBookingDate));
        return;
      }
      if (selectedDateQuota && !selectedDateQuota.allowed) {
        toast.error(selectedDateQuota.error);
        return;
      }
      if (!blockRelease.released) {
        toast.error(
          blockRelease.reason ||
            'Esta sala não possui blocos de horários liberados pelo ADM para esta data.'
        );
        return;
      }
    }

    const localNow = new Date();
    const date = selectedBookingDate;
    const startTime = bookingStartTime;
    const endTime = bookingEndTime;

    if (!date || !startTime || !endTime) {
      toast.error('Selecione uma data e um bloco de horário liberado.');
      return;
    }

    const validation = validateReservationRules(
      {
        date,
        startTime,
        endTime,
        salaFirestoreId: bookingRoom.firestoreId,
        isAdmin,
      },
      localNow
    );
    if (!validation.valid) {
      toast.error(validation.error || 'Dados de reserva inválidos.');
      return;
    }

    const startDateTime = createSafeLocalDateTime(date, startTime);
    const endDateTime = createSafeLocalDateTime(date, endTime);

    const conflict = reservations.find(
      (r) =>
        (r.salaId === bookingRoom.firestoreId || r.salaInstitutionalId === bookingRoom.id) &&
        r.data === date &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA') &&
        startTime < r.fim &&
        endTime > r.inicio
    );

    if (conflict) {
      toast.error('Este horário já está reservado para este ambiente. Escolha outro bloco.');
      return;
    }

    const userTimeConflict = reservations.find(
      (r) =>
        r.usuarioId === user.id &&
        r.data === date &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA') &&
        startTime < r.fim &&
        endTime > r.inicio
    );

    if (userTimeConflict && !isAdmin) {
      toast.error('Você já possui uma reserva ativa neste mesmo horário.');
      return;
    }

    const nowWithTolerance = new Date(localNow.getTime() - 60000);
    if (startDateTime < nowWithTolerance) {
      toast.error('O horário de início não pode ser no passado.');
      return;
    }

    if (endDateTime <= startDateTime) {
      toast.error('O horário de término deve ser após o horário de início.');
      return;
    }

    try {
      await addReservation({
        salaId: bookingRoom.firestoreId,
        salaInstitutionalId: bookingRoom.id,
        salaNome: bookingRoom.nome,
        usuarioId: user.id,
        data: date,
        inicio: startTime,
        fim: endTime,
        status: isAdmin ? 'CONFIRMADA' : 'PENDENTE',
        checkInExpiracao: isAdmin ? null : startDateTime.getTime() + 5 * 60 * 1000,
        checkInRealizado: isAdmin,
        observacoes: isAdmin ? 'Reserva Administrativa' : 'Reserva Acadêmica',
      });

      toast.success(
        isAdmin ? 'Ambiente reservado pela Coordenação.' : 'Reserva realizada com sucesso.'
      );
      setBookingRoom(null);
      setSelectedBookingDate(getReservationDateLimits().minDate);
    } catch (err: any) {
      console.error('Reservation error:', err);
      toast.error(
        err?.message && !String(err.message).startsWith('{')
          ? err.message
          : 'Não foi possível registrar a reserva. Verifique sua cota semanal e situação cadastral.'
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Mapa de Espaços</h2>
          <p className="text-slate-500 text-sm">
            Selecione uma sala, laboratório ou auditório para conferir horários e disponibilidade em tempo real.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setEditingRoom(null);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-2 bg-fatec-red hover:bg-red-800 text-white px-5 py-2.5 rounded-xl font-semibold transition-colors text-sm whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Novo Espaço
          </button>
        )}
      </div>

      {/* FAIXA DE ELEGIBILIDADE ACADÊMICA (COTA SEMANAL + PUNIÇÃO DE NO-SHOW DO DIA) */}
      {!isAdmin && user && (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">Cota Semanal (Seg–Dom):</span>
              <span className="font-mono tabular-nums font-semibold">
                {currentWeekQuota?.usedCount || 0}/1 reserva utilizada
              </span>
              {currentWeekQuota && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-500">
                    Semana {currentWeekQuota.weekBounds.startLabel} a{' '}
                    {currentWeekQuota.weekBounds.endLabel}
                  </span>
                </>
              )}
            </div>
            {currentWeekQuota && !currentWeekQuota.allowed ? (
              <p className="text-xs font-semibold text-amber-800">
                {currentWeekQuota.error} Caso cancele previamente sua reserva ativa, a cota da semana será restabelecida.
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                Você possui 1 reserva disponível nesta semana para salas e blocos liberados pelo ADM.
              </p>
            )}
          </div>

          {userBlockedDate && (
            <div className="px-3.5 py-2 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-center gap-2 shrink-0">
              <AlertCircle className="h-4 w-4 text-fatec-red shrink-0" />
              <span className="font-semibold">{formatNoShowTag(userBlockedDate)}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-center">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar ambiente por nome, código ou ID institucional..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-3 bg-white border border-slate-200 rounded-2xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
          />
        </div>
        <div className="flex gap-1 bg-white p-1.5 rounded-2xl border border-slate-200 w-full md:w-auto overflow-x-auto">
          {['Todos', ...FLOORS].map((floor) => {
            const count =
              floor === 'Todos'
                ? visibleRooms.length
                : visibleRooms.filter((r) => r.andar === floor).length;
            return (
              <button
                key={floor}
                type="button"
                onClick={() => setSelectedFloor(floor)}
                className={cn(
                  'px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors flex items-center gap-2 cursor-pointer',
                  selectedFloor === floor
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-50'
                )}
              >
                <span>{floor}</span>
                <span
                  className={cn(
                    'font-mono tabular-nums text-[11px]',
                    selectedFloor === floor ? 'text-slate-300' : 'text-slate-400'
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-12">
        {loading && rooms.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-2xl border border-slate-200 p-6 animate-pulse space-y-4"
              >
                <div className="h-4 bg-slate-200 rounded w-3/4" />
                <div className="h-3 bg-slate-100 rounded w-1/2" />
                <div className="h-10 bg-slate-200 rounded-xl w-full" />
              </div>
            ))}
          </div>
        ) : Object.keys(roomsByFloor).length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-14 text-center space-y-2">
            <Building2 className="h-10 w-10 text-slate-300 mx-auto" />
            <p className="text-sm font-bold text-slate-800">
              {!isAdmin
                ? 'Nenhuma sala liberada pelo Administrador no momento'
                : 'Nenhum ambiente encontrado para este filtro'}
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {!isAdmin
                ? 'Apenas espaços ativos e explicitamente liberados pela Coordenação aparecem disponíveis para agendamento.'
                : 'Ajuste os termos de pesquisa ou cadastre um novo espaço pedagógico.'}
            </p>
          </div>
        ) : (
          Object.entries(roomsByFloor)
            .filter(([floor]) => selectedFloor === 'Todos' || floor === selectedFloor)
            .map(([floor, floorRooms]) => (
              <section key={floor} className="space-y-5">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <div className="flex items-center gap-2.5">
                    <Building2 className="h-5 w-5 text-fatec-red" />
                    <h3 className="text-lg font-bold text-slate-900 tracking-tight">{floor}</h3>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                    <span>{floorRooms.length} ambientes</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {floorRooms.reduce((acc, r) => acc + r.capacidade, 0)} lugares totais
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
                  {floorRooms.map((room) => {
                    const categoria = inferSpaceCategory(room);
                    const rt = resolveRoomRealtimeStatus(room, reservations, now);
                    const isMaintenance = rt.status === 'MANUTENCAO';

                    let countdownText = '';
                    if (rt.currentReservation) {
                      const endTimeObj = createSafeLocalDateTime(
                        rt.currentReservation.data,
                        rt.currentReservation.fim
                      );
                      const diffSecs = Math.max(
                        0,
                        Math.floor((endTimeObj.getTime() - now.getTime()) / 1000)
                      );
                      const hours = Math.floor(diffSecs / 3600);
                      const mins = Math.floor((diffSecs % 3600) / 60);
                      const secs = diffSecs % 60;
                      countdownText =
                        hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
                    }

                    return (
                      <div
                        key={room.firestoreId}
                        className={cn(
                          'bg-white rounded-2xl border p-5 flex flex-col gap-4 transition-colors',
                          isMaintenance ? 'border-slate-300 bg-slate-50/60' : 'border-slate-200'
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-1.5 text-xs text-slate-500">
                              <span className="font-mono tabular-nums font-semibold text-slate-700">
                                {room.id}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{SPACE_CATEGORY_LABELS[categoria]}</span>
                            </div>
                            <h4 className="text-base font-bold text-slate-900 truncate">
                              {room.nome}
                            </h4>
                          </div>

                          <span
                            className={cn(
                              'text-xs font-semibold shrink-0',
                              rt.status === 'DISPONIVEL'
                                ? 'text-emerald-700'
                                : rt.status === 'RESERVADO'
                                ? 'text-amber-700'
                                : rt.status === 'EM_USO'
                                ? 'text-fatec-red'
                                : 'text-slate-600'
                            )}
                          >
                            {REALTIME_SPACE_STATUS_LABELS[rt.status]}
                          </span>
                        </div>

                        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">
                          {room.descricao}
                        </p>

                        <div className="flex items-center gap-2 text-xs text-slate-600 mt-auto">
                          <Users className="h-3.5 w-3.5 text-slate-400" />
                          <span className="font-mono tabular-nums font-semibold">
                            {room.capacidade} lugares
                          </span>
                          <span aria-hidden="true">·</span>
                          <Wifi className="h-3.5 w-3.5 text-slate-400" />
                          <span>Wi-Fi</span>
                        </div>

                        {rt.currentReservation && countdownText && (
                          <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 flex items-center justify-between">
                            <span>Liberação prevista:</span>
                            <span className="font-mono tabular-nums font-bold">
                              {countdownText}
                            </span>
                          </div>
                        )}

                        {!rt.currentReservation && rt.nextReservation && !isMaintenance && (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-center gap-1.5 font-mono tabular-nums">
                            <Calendar className="h-3.5 w-3.5 shrink-0" />
                            <span>Próxima reserva às {rt.nextReservation.inicio}</span>
                          </div>
                        )}

                        {rt.isTemporarilyBlocked && room.bloqueadaAte && (
                          <div className="text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 font-mono tabular-nums">
                            Suspenso até {new Date(room.bloqueadaAte).toLocaleString('pt-BR')}
                          </div>
                        )}

                        {/* CONTROLES RÁPIDOS ADM (LIBERAÇÃO P/ USUÁRIOS + MANUTENÇÃO + EDITAR + EXCLUIR) */}
                        {isAdmin && (
                          <div className="pt-3 border-t border-slate-100 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await toggleRoomBookingRelease(room);
                                    toast.success(
                                      room.liberadaParaReserva === false
                                        ? `${room.nome} liberada para reservas de usuários.`
                                        : `${room.nome} bloqueada para reservas de usuários.`
                                    );
                                  } catch {
                                    toast.error('Erro ao alterar liberação da sala.');
                                  }
                                }}
                                className={cn(
                                  'px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 border',
                                  room.liberadaParaReserva === false
                                    ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-300'
                                    : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border-emerald-200'
                                )}
                                title="Controla se usuários comuns podem visualizar e agendar esta sala"
                              >
                                {room.liberadaParaReserva === false ? (
                                  <>
                                    <Lock className="h-3.5 w-3.5" />
                                    Oculta p/ Usuários
                                  </>
                                ) : (
                                  <>
                                    <Unlock className="h-3.5 w-3.5" />
                                    Liberada p/ Reserva
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await toggleMaintenanceOneClick(room);
                                    toast.success(
                                      isMaintenance
                                        ? `${room.nome} reativado para uso.`
                                        : `${room.nome} suspenso para manutenção.`
                                    );
                                  } catch {
                                    toast.error('Erro ao alterar status de manutenção.');
                                  }
                                }}
                                className={cn(
                                  'px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0',
                                  isMaintenance
                                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                                    : 'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200'
                                )}
                              >
                                {isMaintenance ? (
                                  <>
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Reativar
                                  </>
                                ) : (
                                  <>
                                    <Wrench className="h-3.5 w-3.5" />
                                    Manutenção
                                  </>
                                )}
                              </button>
                            </div>

                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingRoom(room);
                                  setIsModalOpen(true);
                                }}
                                className="p-2 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                                title="Editar espaço"
                              >
                                <Edit className="h-4 w-4" />
                              </button>

                              {confirmDeleteId === room.firestoreId ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleConfirmDelete(room)}
                                    className="px-2 py-1 rounded bg-fatec-red text-white text-[11px] font-semibold cursor-pointer"
                                  >
                                    Confirmar
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-[11px] font-semibold cursor-pointer"
                                  >
                                    Não
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(room.firestoreId)}
                                  className="p-2 text-slate-400 hover:text-fatec-red hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                                  title="Excluir espaço"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        <button
                          type="button"
                          disabled={isMaintenance}
                          onClick={() => openBookingModal(room)}
                          className={cn(
                            'w-full py-3 rounded-xl font-semibold text-xs transition-colors whitespace-nowrap shrink-0',
                            isMaintenance
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                              : 'bg-slate-900 text-white hover:bg-fatec-red cursor-pointer'
                          )}
                        >
                          {isMaintenance ? 'Em Manutenção / Suspenso' : 'Solicitar Reserva'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
        )}
      </div>

      {/* MODAL DE RESERVA SINCRONIZADO COM REGRAS CENTRALIZADAS (`schedules`) */}
      <AnimatePresence>
        {bookingRoom && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setBookingRoom(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden p-6 max-h-[90vh] overflow-y-auto custom-scrollbar"
            >
              <div className="flex items-start justify-between gap-3 mb-5">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Reservar Ambiente</h3>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {bookingRoom.nome} · {bookingRoom.andar}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setBookingRoom(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleBooking} className="space-y-4">
                {!windowStatus.isOpen ? (
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-900">
                    <Clock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-amber-950">Portal Fechado para Agendamentos</p>
                      <p className="mt-0.5 text-amber-800 leading-relaxed">{windowStatus.message}</p>
                    </div>
                  </div>
                ) : !isAdmin && selectedDateNoShow.blocked ? (
                  <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-900">
                    <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold text-rose-950">
                        {selectedDateNoShow.tag}
                      </p>
                      <p className="text-rose-800 leading-relaxed">
                        Você está impossibilitado de realizar reservas apenas para o restante de{' '}
                        <strong>{formatDataBR(selectedBookingDate)}</strong>. Selecione uma data futura para agendar normalmente.
                      </p>
                    </div>
                  </div>
                ) : !isAdmin && selectedDateQuota && !selectedDateQuota.allowed ? (
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-900">
                    <AlertCircle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold text-amber-950">
                        {selectedDateQuota.error}
                      </p>
                      <p className="text-amber-800 leading-relaxed">
                        Semana de {selectedDateQuota.weekBounds.startLabel} a{' '}
                        {selectedDateQuota.weekBounds.endLabel} (1 reserva ativa ou concluída por semana).
                      </p>
                    </div>
                  </div>
                ) : !blockRelease.released && !isAdmin ? (
                  <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-900">
                    <AlertCircle className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-rose-950">Horários Não Liberados pelo ADM</p>
                      <p className="mt-0.5 text-rose-800">{blockRelease.reason}</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                      <Clock className="h-3.5 w-3.5 text-fatec-red" />
                      Janela Operacional Vigente
                    </div>
                    <p className="font-mono tabular-nums text-[11px]">
                      Horários liberados das <strong>{blockRelease.janelaInicio}</strong> às{' '}
                      <strong>{blockRelease.janelaFim}</strong> · Antecedência até{' '}
                      <strong>{formatDataBR(dateLimits.maxDate)}</strong>.
                    </p>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-slate-400" />
                      Data da Reserva
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedBookingDate(dateLimits.todayStr)}
                        className={cn(
                          'py-2 px-3 rounded-xl font-semibold text-xs transition-colors border flex items-center justify-between cursor-pointer',
                          selectedBookingDate === dateLimits.todayStr
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        )}
                      >
                        <span>Hoje</span>
                        <span className="font-mono tabular-nums">
                          {formatDataBR(dateLimits.todayStr)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedBookingDate(dateLimits.tomorrowStr)}
                        className={cn(
                          'py-2 px-3 rounded-xl font-semibold text-xs transition-colors border flex items-center justify-between cursor-pointer',
                          selectedBookingDate === dateLimits.tomorrowStr
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        )}
                      >
                        <span>Amanhã</span>
                        <span className="font-mono tabular-nums">
                          {formatDataBR(dateLimits.tomorrowStr)}
                        </span>
                      </button>
                    </div>

                    <input
                      name="reservaDate"
                      type="date"
                      required
                      min={dateLimits.minDate}
                      max={isAdmin ? undefined : dateLimits.maxDate}
                      value={selectedBookingDate}
                      onChange={(e) => setSelectedBookingDate(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-fatec-red font-mono tabular-nums text-xs font-semibold"
                    />
                  </div>

                  {/* BLOCOS DE HORÁRIOS LIBERADOS PELO ADM */}
                  {blockRelease.blocks.length > 0 ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-700">
                          Blocos Liberados pelo ADM
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {!isAdmin &&
                          (selectedDateNoShow.blocked ||
                            (selectedDateQuota && !selectedDateQuota.allowed))
                            ? 'Seleção bloqueada'
                            : 'Selecione um bloco'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                        {blockRelease.blocks.map((blk) => {
                          const isTaken = existingBookingsForSelectedDate.some(
                            (r) => blk.inicio < r.fim && blk.fim > r.inicio
                          );
                          const isBlockedByRule =
                            !isAdmin &&
                            (selectedDateNoShow.blocked ||
                              Boolean(selectedDateQuota && !selectedDateQuota.allowed));
                          const isDisabled = isTaken || isBlockedByRule;
                          const isSelected =
                            bookingStartTime === blk.inicio && bookingEndTime === blk.fim;
                          return (
                            <button
                              key={blk.id}
                              type="button"
                              disabled={isDisabled}
                              onClick={() => {
                                setBookingStartTime(blk.inicio);
                                setBookingEndTime(blk.fim);
                              }}
                              className={cn(
                                'px-2.5 py-2 rounded-xl border text-left text-xs transition-colors',
                                isTaken
                                  ? 'bg-slate-100 border-slate-200 text-slate-400 line-through cursor-not-allowed'
                                  : isBlockedByRule
                                  ? 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed'
                                  : isSelected
                                  ? 'bg-slate-900 border-slate-900 text-white'
                                  : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50 cursor-pointer'
                              )}
                            >
                              <span className="block font-semibold truncate text-[11px]">
                                {blk.label}
                              </span>
                              <span className="font-mono tabular-nums text-[11px] opacity-85">
                                {blk.inicio} – {blk.fim}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    !isAdmin && (
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
                        Nenhum bloco de horário ativo foi liberado pelo ADM para esta sala na data selecionada.
                      </div>
                    )
                  )}

                  {existingBookingsForSelectedDate.length > 0 && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                      <p className="text-xs font-semibold text-slate-700">
                        Horários já reservados nesta data:
                      </p>
                      <div className="flex flex-wrap gap-1.5 font-mono tabular-nums text-xs text-slate-700">
                        {existingBookingsForSelectedDate.map((res) => (
                          <span
                            key={res.id}
                            className="bg-white border border-slate-200 px-2.5 py-1 rounded-lg"
                          >
                            {res.inicio} – {res.fim}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700">Início</label>
                      <input
                        name="startTime"
                        type="time"
                        required
                        readOnly={!isAdmin}
                        value={bookingStartTime}
                        min={isAdmin ? undefined : blockRelease.janelaInicio}
                        max={isAdmin ? undefined : blockRelease.janelaFim}
                        onChange={(e) => isAdmin && setBookingStartTime(e.target.value)}
                        className={cn(
                          'w-full px-3.5 py-2.5 border border-slate-200 rounded-xl outline-none font-mono tabular-nums text-xs font-semibold',
                          isAdmin
                            ? 'bg-slate-50 focus:ring-2 focus:ring-fatec-red'
                            : 'bg-slate-100 text-slate-700 cursor-default'
                        )}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700">Término</label>
                      <input
                        name="endTime"
                        type="time"
                        required
                        readOnly={!isAdmin}
                        value={bookingEndTime}
                        min={isAdmin ? undefined : blockRelease.janelaInicio}
                        max={isAdmin ? undefined : blockRelease.janelaFim}
                        onChange={(e) => isAdmin && setBookingEndTime(e.target.value)}
                        className={cn(
                          'w-full px-3.5 py-2.5 border border-slate-200 rounded-xl outline-none font-mono tabular-nums text-xs font-semibold',
                          isAdmin
                            ? 'bg-slate-50 focus:ring-2 focus:ring-fatec-red'
                            : 'bg-slate-100 text-slate-700 cursor-default'
                        )}
                      />
                    </div>
                  </div>
                </div>

                {!isAdmin && (
                  <div className="flex items-start gap-2 text-amber-800 bg-amber-50 p-3 rounded-xl border border-amber-200 text-xs">
                    <Clock className="h-4 w-4 shrink-0 mt-0.5" />
                    <p>
                      Realize o check-in via QR Code em até 5 minutos após o início agendado. Em caso de No-Show, o bloqueio ocorre apenas no dia da falta e sua cota semanal permanece liberada para outros dias.
                    </p>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setBookingRoom(null)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={
                      !windowStatus.isOpen ||
                      (!isAdmin &&
                        (!blockRelease.released ||
                          selectedDateNoShow.blocked ||
                          Boolean(selectedDateQuota && !selectedDateQuota.allowed)))
                    }
                    className={cn(
                      'px-5 py-2.5 rounded-xl font-semibold text-xs transition-colors whitespace-nowrap shrink-0',
                      !windowStatus.isOpen ||
                        (!isAdmin &&
                          (!blockRelease.released ||
                            selectedDateNoShow.blocked ||
                            Boolean(selectedDateQuota && !selectedDateQuota.allowed)))
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        : 'bg-fatec-red hover:bg-red-800 text-white cursor-pointer'
                    )}
                  >
                    Confirmar Reserva
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL CRUD DE AMBIENTE */}
      <AnimatePresence>
        {isModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
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
              className="relative w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-base font-bold text-slate-900">
                  {editingRoom ? 'Editar Espaço Pedagógico' : 'Cadastrar Novo Espaço'}
                </h3>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form
                onSubmit={handleSubmit}
                className="p-6 space-y-4 max-h-[80vh] overflow-y-auto custom-scrollbar"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">
                      ID Institucional
                    </label>
                    <input
                      name="id"
                      required
                      defaultValue={editingRoom?.id}
                      placeholder="Ex: SALA-001"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Código Curto</label>
                    <input
                      name="codigo"
                      required
                      defaultValue={editingRoom?.codigo}
                      placeholder="Ex: LAB-INFO"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Categoria</label>
                    <select
                      name="categoria"
                      defaultValue={editingRoom ? inferSpaceCategory(editingRoom) : 'SALA'}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
                    >
                      <option value="SALA">Sala de Aula</option>
                      <option value="LABORATORIO">Laboratório</option>
                      <option value="AUDITORIO">Auditório</option>
                      <option value="ESPECIAL">Espaço Especial</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Nome do Espaço</label>
                    <input
                      name="nome"
                      required
                      defaultValue={editingRoom?.nome}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Andar</label>
                    <select
                      name="andar"
                      defaultValue={editingRoom?.andar || 'Térreo'}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
                    >
                      {FLOORS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Capacidade</label>
                    <input
                      name="capacidade"
                      type="number"
                      min={1}
                      max={1000}
                      required
                      defaultValue={editingRoom?.capacidade || 40}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Status</label>
                    <select
                      name="status"
                      defaultValue={editingRoom?.status || 'ATIVO'}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
                    >
                      <option value="ATIVO">Disponível (Ativo)</option>
                      <option value="MANUTENCAO">Em Manutenção</option>
                      <option value="INATIVO">Inativo</option>
                    </select>
                  </div>
                </div>

                {isAdmin && (
                  <label className="flex items-start gap-3 p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-xl cursor-pointer">
                    <input
                      type="checkbox"
                      name="liberadaParaReserva"
                      defaultChecked={editingRoom ? editingRoom.liberadaParaReserva !== false : true}
                      className="mt-0.5 h-4 w-4 accent-emerald-600 rounded"
                    />
                    <div className="text-xs">
                      <span className="font-semibold text-emerald-950 block">
                        Liberar sala para visualização e agendamento de usuários comuns
                      </span>
                      <span className="text-emerald-800">
                        Se desmarcado, apenas administradores poderão visualizar e reservar este espaço.
                      </span>
                    </div>
                  </label>
                )}

                {isAdmin && editingRoom && (
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <h4 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <Clock className="h-4 w-4 text-slate-500" />
                      Suspensão Programada (Opcional)
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-600">Suspender até a data</label>
                        <input
                          name="bloqueadaAteDate"
                          type="date"
                          defaultValue={
                            editingRoom?.bloqueadaAte
                              ? new Date(editingRoom.bloqueadaAte).toLocaleDateString('en-CA')
                              : ''
                          }
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono tabular-nums"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-600">Horário</label>
                        <input
                          name="bloqueadaAteTime"
                          type="time"
                          defaultValue={
                            editingRoom?.bloqueadaAte
                              ? new Date(editingRoom.bloqueadaAte).toTimeString().slice(0, 5)
                              : ''
                          }
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono tabular-nums"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700">Descrição</label>
                  <textarea
                    name="descricao"
                    required
                    defaultValue={editingRoom?.descricao}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none h-20 resize-none text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700">
                    Equipamentos (separados por vírgula)
                  </label>
                  <input
                    name="equipamentos"
                    defaultValue={editingRoom?.equipamentos.join(', ')}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm"
                  />
                </div>

                <input
                  type="hidden"
                  name="imagem"
                  value={editingRoom?.imagem || DEFAULT_ROOM_COVER}
                />

                <div className="pt-3 flex justify-end gap-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl font-semibold bg-fatec-red text-white hover:bg-red-800 transition-colors text-xs cursor-pointer"
                  >
                    {editingRoom ? 'Salvar Alterações' : 'Criar Espaço'}
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
