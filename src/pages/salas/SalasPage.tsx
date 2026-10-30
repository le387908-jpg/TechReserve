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
import {
  isSlotActiveOrReleased,
  matchesSlotRoom,
  useAvailableSlotsStore,
} from '../../store/useAvailableSlotsStore';
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
  UNAVAILABLE_AWAITING_RELEASE_LABEL,
  checkNoShowSuspensionForDate,
  checkWeeklyQuotaLocal,
  formatNoShowTag,
  getCurriculumClassesForRoomOnDate,
  getReleasedBlocksForRoomOnDate,
  getRoomScheduleSlotsForDate,
  getUserNoShowBlockedDate,
  isSpaceReleasedByAdmin,
} from '../../services/reservationService';
import { RoomSlotSelector } from '../../components/reservations/RoomSlotSelector';
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

  // Subscribe to schedule config, exceptions & explicit `available_slots` so UI reacts immediately
  const scheduleConfig = useScheduleStore((state) => state.config);
  const scheduleExceptions = useScheduleStore((state) => state.exceptions);
  const availableSlots = useAvailableSlotsStore((state) => state.slots);
  const fetchAvailableSlots = useAvailableSlotsStore((state) => state.fetchAvailableSlots);
  const setSlotReleaseStatus = useAvailableSlotsStore((state) => state.setSlotReleaseStatus);
  const releaseMultipleSlotsForRoomAndDate = useAvailableSlotsStore(
    (state) => state.releaseMultipleSlotsForRoomAndDate
  );
  const blockAllSlotsForRoomAndDate = useAvailableSlotsStore(
    (state) => state.blockAllSlotsForRoomAndDate
  );

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
  const [slotAdminRoom, setSlotAdminRoom] = useState<Room | null>(null);
  const [slotAdminDate, setSlotAdminDate] = useState<string>('');
  const [customSlotStart, setCustomSlotStart] = useState('14:00');
  const [customSlotEnd, setCustomSlotEnd] = useState('14:50');
  const [customSlotLabel, setCustomSlotLabel] = useState('');
  const [isUpdatingSlotAdmin, setIsUpdatingSlotAdmin] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const dateLimits = getReservationDateLimits(now);
  const windowStatus = isBookingWindowOpen(now, isAdmin);
  const [selectedBookingDate, setSelectedBookingDate] = useState(dateLimits.minDate);
  const [bookingStartTime, setBookingStartTime] = useState('');
  const [bookingEndTime, setBookingEndTime] = useState('');
  const [selectedAvailableSlotId, setSelectedAvailableSlotId] = useState<string | undefined>(
    undefined
  );

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
      !isAdmin &&
      userBlockedDate === currentLimits.todayStr &&
      currentLimits.tomorrowStr <= currentLimits.maxDate
        ? currentLimits.tomorrowStr
        : currentLimits.minDate;

    const slotView = getRoomScheduleSlotsForDate({
      room,
      dateISO: initialDate,
      config: scheduleConfig,
      exceptions: scheduleExceptions,
      availableSlots,
      reservations,
      now: new Date(),
    });
    const firstReservable = slotView.slots.find((s) => s.selectableForUser);

    setSelectedBookingDate(initialDate);
    if (firstReservable) {
      setBookingStartTime(firstReservable.inicio);
      setBookingEndTime(firstReservable.fim);
      setSelectedAvailableSlotId(firstReservable.availableSlotId);
    } else if (isAdmin) {
      setBookingStartTime(scheduleConfig.janelaInicio || '17:00');
      setBookingEndTime('17:50');
      setSelectedAvailableSlotId(undefined);
    } else {
      setBookingStartTime('');
      setBookingEndTime('');
      setSelectedAvailableSlotId(undefined);
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
        now,
        availableSlots
      ),
    [bookingRoom, selectedBookingDate, scheduleConfig, scheduleExceptions, now, availableSlots]
  );

  const bookingSlotView = React.useMemo(
    () =>
      getRoomScheduleSlotsForDate({
        room: bookingRoom,
        dateISO: selectedBookingDate,
        config: scheduleConfig,
        exceptions: scheduleExceptions,
        availableSlots,
        reservations,
        now,
      }),
    [bookingRoom, selectedBookingDate, scheduleConfig, scheduleExceptions, availableSlots, reservations, now]
  );

  const selectedDateQuota = React.useMemo(() => {
    if (!user || isAdmin) return null;
    return checkWeeklyQuotaLocal(reservations, user.id, selectedBookingDate);
  }, [reservations, user, isAdmin, selectedBookingDate]);

  const selectedDateNoShow = React.useMemo(
    () => checkNoShowSuspensionForDate(user, effectivePunishments, selectedBookingDate),
    [user, effectivePunishments, selectedBookingDate]
  );

  // Atualiza automaticamente a seleção quando o usuário troca a data ou quando o ADM libera/bloqueia slots em tempo real
  useEffect(() => {
    if (!bookingRoom) return;
    const reservableList = bookingSlotView.slots.filter((s) => s.selectableForUser);
    if (reservableList.length > 0) {
      const currentValid = reservableList.find(
        (s) => s.inicio === bookingStartTime && s.fim === bookingEndTime
      );
      if (currentValid) {
        if (selectedAvailableSlotId !== currentValid.availableSlotId) {
          setSelectedAvailableSlotId(currentValid.availableSlotId);
        }
      } else if (!isAdmin || !bookingStartTime || !bookingEndTime) {
        setBookingStartTime(reservableList[0].inicio);
        setBookingEndTime(reservableList[0].fim);
        setSelectedAvailableSlotId(reservableList[0].availableSlotId);
      }
    } else if (!isAdmin) {
      setBookingStartTime('');
      setBookingEndTime('');
      setSelectedAvailableSlotId(undefined);
    }
  }, [
    selectedBookingDate,
    bookingRoom,
    bookingSlotView.slots,
    isAdmin,
  ]);

  useEffect(() => {
    const unsubRooms = fetchRooms();
    const unsubReservations = fetchReservations();
    const unsubAvailable = fetchAvailableSlots();
    const unsubUserPunishments =
      user && !isAdmin ? fetchUserPunishments(user.id) : () => {};
    return () => {
      unsubRooms();
      unsubReservations();
      unsubAvailable();
      unsubUserPunishments();
    };
  }, [fetchRooms, fetchReservations, fetchAvailableSlots, fetchUserPunishments, user?.id, isAdmin]);

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
    if (!isAdmin) return;
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

    roomData.liberadaParaReserva = formData.get('liberadaParaReserva') === 'on';
    const blockDate = formData.get('bloqueadaAteDate') as string;
    const blockTime = formData.get('bloqueadaAteTime') as string;
    if (blockDate && blockTime) {
      roomData.bloqueadaAte = new Date(`${blockDate}T${blockTime}`).getTime();
    } else {
      roomData.bloqueadaAte = null;
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
    if (!isAdmin) return;
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
        availableSlotId: isAdmin ? undefined : selectedAvailableSlotId,
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

                    const todaySchedule = getRoomScheduleSlotsForDate({
                      room,
                      dateISO: dateLimits.todayStr,
                      config: scheduleConfig,
                      exceptions: scheduleExceptions,
                      availableSlots,
                      reservations,
                      now,
                    });

                    const upcomingReleasedCount = availableSlots.filter(
                      (slot) =>
                        matchesSlotRoom(slot, room) &&
                        slot.data >= dateLimits.todayStr &&
                        (isAdmin || slot.data <= dateLimits.maxDate) &&
                        isSlotActiveOrReleased(slot)
                    ).length;

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

                          {isAdmin ? (
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
                          ) : isMaintenance ? (
                            <span className="text-xs font-semibold shrink-0 text-slate-600">
                              Em Manutenção
                            </span>
                          ) : rt.status === 'EM_USO' ? (
                            <span className="text-xs font-semibold shrink-0 text-fatec-red">
                              Em Uso
                            </span>
                          ) : todaySchedule.reservableCount > 0 || upcomingReleasedCount > 0 ? (
                            <span className="text-xs font-semibold shrink-0 text-emerald-700">
                              Horários Liberados
                            </span>
                          ) : (
                            <span className="text-xs font-semibold shrink-0 text-slate-500 flex items-center gap-1">
                              <Lock className="h-3 w-3" />
                              Bloqueado
                            </span>
                          )}
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

                        {/* INDICADOR DE LIBERAÇÃO DE HORÁRIOS (`available_slots`) */}
                        {!isMaintenance && !rt.currentReservation && (
                          todaySchedule.reservableCount > 0 ? (
                            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                              <span className="font-semibold">Liberados hoje:</span>
                              <span className="font-mono tabular-nums font-bold">
                                {todaySchedule.reservableCount}{' '}
                                {todaySchedule.reservableCount === 1 ? 'horário' : 'horários'}
                              </span>
                            </div>
                          ) : upcomingReleasedCount > 0 ? (
                            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                              <span className="font-semibold">Próximas datas:</span>
                              <span className="font-mono tabular-nums font-bold">
                                {upcomingReleasedCount} liberado(s)
                              </span>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 flex items-center gap-1.5">
                              <Lock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                              <span className="truncate">{UNAVAILABLE_AWAITING_RELEASE_LABEL}</span>
                            </div>
                          )
                        )}

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

                        {/* CONTROLES RÁPIDOS ADM (LIBERAR SLOTS + VISIBILIDADE + MANUTENÇÃO + EDITAR + EXCLUIR) */}
                        {isAdmin && (
                          <div className="pt-3 border-t border-slate-100 space-y-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSlotAdminRoom(room);
                                setSlotAdminDate(dateLimits.todayStr);
                              }}
                              className="w-full px-3 py-2 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white transition-colors cursor-pointer"
                              title="Liberar ou bloquear horários específicos para esta sala no Firestore (available_slots)"
                            >
                              <Clock className="h-3.5 w-3.5 text-emerald-400" />
                              Liberar Horários por Data
                            </button>

                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await toggleRoomBookingRelease(room);
                                    toast.success(
                                      room.liberadaParaReserva === false
                                        ? `${room.nome} liberada para visualização de usuários.`
                                        : `${room.nome} ocultada para usuários.`
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
                                title="Controla se usuários comuns podem visualizar esta sala"
                              >
                                {room.liberadaParaReserva === false ? (
                                  <>
                                    <Lock className="h-3.5 w-3.5" />
                                    Oculta p/ Usuários
                                  </>
                                ) : (
                                  <>
                                    <Unlock className="h-3.5 w-3.5" />
                                    Visível p/ Usuários
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
                              : !isAdmin && todaySchedule.reservableCount === 0 && upcomingReleasedCount === 0
                              ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 cursor-pointer'
                              : 'bg-slate-900 text-white hover:bg-fatec-red cursor-pointer'
                          )}
                        >
                          {isMaintenance
                            ? 'Em Manutenção / Suspenso'
                            : isAdmin
                            ? 'Reservar (ADM)'
                            : todaySchedule.reservableCount > 0 || upcomingReleasedCount > 0
                            ? 'Selecionar Horário Liberado'
                            : 'Consultar Grade e Horários'}
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
                ) : null}

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-slate-400" />
                      Data da Consulta / Reserva
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

                  {/* SELETOR FILTRADO POR `available_slots` (BLOQUEIO PADRÃO + LIBERAÇÃO DO ADM) */}
                  <RoomSlotSelector
                    room={bookingRoom}
                    date={selectedBookingDate}
                    selectedStartTime={bookingStartTime}
                    selectedEndTime={bookingEndTime}
                    onSelectSlot={(slot) => {
                      setBookingStartTime(slot.inicio);
                      setBookingEndTime(slot.fim);
                      setSelectedAvailableSlotId(slot.availableSlotId);
                    }}
                    disabledByUserRule={
                      !isAdmin &&
                      (selectedDateNoShow.blocked ||
                        Boolean(selectedDateQuota && !selectedDateQuota.allowed))
                    }
                    isAdmin={isAdmin}
                  />

                  {/* CAMPOS MANUAIS DE HORÁRIO APENAS PARA ADM */}
                  {isAdmin ? (
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-slate-700">
                          Início (ADM)
                        </label>
                        <input
                          name="startTime"
                          type="time"
                          required
                          value={bookingStartTime}
                          onChange={(e) => setBookingStartTime(e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-fatec-red font-mono tabular-nums text-xs font-semibold"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-slate-700">
                          Término (ADM)
                        </label>
                        <input
                          name="endTime"
                          type="time"
                          required
                          value={bookingEndTime}
                          onChange={(e) => setBookingEndTime(e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-fatec-red font-mono tabular-nums text-xs font-semibold"
                        />
                      </div>
                    </div>
                  ) : (
                    bookingStartTime &&
                    bookingEndTime && (
                      <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between text-xs text-emerald-950">
                        <span className="font-semibold">Horário selecionado:</span>
                        <span className="font-mono tabular-nums font-bold">
                          {bookingStartTime} às {bookingEndTime}
                        </span>
                      </div>
                    )
                  )}
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
                      !bookingStartTime ||
                      !bookingEndTime ||
                      (!isAdmin &&
                        (!blockRelease.released ||
                          bookingSlotView.reservableCount === 0 ||
                          !selectedAvailableSlotId ||
                          selectedDateNoShow.blocked ||
                          Boolean(selectedDateQuota && !selectedDateQuota.allowed)))
                    }
                    className={cn(
                      'px-5 py-2.5 rounded-xl font-semibold text-xs transition-colors whitespace-nowrap shrink-0',
                      !windowStatus.isOpen ||
                        !bookingStartTime ||
                        !bookingEndTime ||
                        (!isAdmin &&
                          (!blockRelease.released ||
                            bookingSlotView.reservableCount === 0 ||
                            !selectedAvailableSlotId ||
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

      {/* MODAL RÁPIDO ADM: LIBERAÇÃO DE HORÁRIOS (`available_slots`) POR SALA E DATA */}
      <AnimatePresence>
        {slotAdminRoom && isAdmin && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSlotAdminRoom(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden p-6 max-h-[90vh] overflow-y-auto custom-scrollbar space-y-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-fatec-red">
                    Liberação de Horários (available_slots)
                  </span>
                  <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                    {slotAdminRoom.nome}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Por padrão, todos os horários ficam bloqueados para alunos até serem liberados aqui para a data escolhida.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSlotAdminRoom(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* SELETOR DE DATA ADM */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">
                  Data para Liberação / Bloqueio
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setSlotAdminDate(dateLimits.todayStr)}
                    className={cn(
                      'py-2 px-3 rounded-xl text-xs font-semibold border transition-colors cursor-pointer',
                      slotAdminDate === dateLimits.todayStr
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    Hoje ({formatDataBR(dateLimits.todayStr).slice(0, 5)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSlotAdminDate(dateLimits.tomorrowStr)}
                    className={cn(
                      'py-2 px-3 rounded-xl text-xs font-semibold border transition-colors cursor-pointer',
                      slotAdminDate === dateLimits.tomorrowStr
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    Amanhã ({formatDataBR(dateLimits.tomorrowStr).slice(0, 5)})
                  </button>
                  <input
                    type="date"
                    value={slotAdminDate}
                    min={dateLimits.todayStr}
                    onChange={(e) => setSlotAdminDate(e.target.value)}
                    className="px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>
              </div>

              {(() => {
                const adminView = getRoomScheduleSlotsForDate({
                  room: slotAdminRoom,
                  dateISO: slotAdminDate,
                  config: scheduleConfig,
                  exceptions: scheduleExceptions,
                  availableSlots,
                  reservations,
                  now,
                });
                const classesOnDate = getCurriculumClassesForRoomOnDate(
                  slotAdminRoom,
                  slotAdminDate
                );

                return (
                  <div className="space-y-4">
                    {/* AÇÕES EM LOTE */}
                    <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-xs font-semibold text-slate-700">
                        {formatDataBR(slotAdminDate)}: {adminView.reservableCount} liberado(s)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isUpdatingSlotAdmin}
                          onClick={async () => {
                            const freeCandidates = adminView.slots
                              .filter(
                                (s) =>
                                  s.state !== 'OCUPADO_AULA' && s.state !== 'OCUPADO_RESERVA'
                              )
                              .map((s) => ({
                                inicio: s.inicio,
                                fim: s.fim,
                                label: s.label,
                              }));
                            if (freeCandidates.length === 0) {
                              toast.error('Não há faixas livres de aula para liberar nesta data.');
                              return;
                            }
                            setIsUpdatingSlotAdmin(true);
                            try {
                              const count = await releaseMultipleSlotsForRoomAndDate({
                                room: slotAdminRoom,
                                data: slotAdminDate,
                                blocks: freeCandidates,
                              });
                              toast.success(
                                `${count} horário(s) liberado(s) para ${slotAdminRoom.nome} em ${formatDataBR(
                                  slotAdminDate
                                )}.`
                              );
                            } catch {
                              toast.error('Erro ao liberar horários em lote.');
                            } finally {
                              setIsUpdatingSlotAdmin(false);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                        >
                          Liberar Todos s/ Aula
                        </button>
                        <button
                          type="button"
                          disabled={isUpdatingSlotAdmin}
                          onClick={async () => {
                            setIsUpdatingSlotAdmin(true);
                            try {
                              await blockAllSlotsForRoomAndDate({
                                room: slotAdminRoom,
                                data: slotAdminDate,
                              });
                              toast.success(
                                `Horários bloqueados para ${slotAdminRoom.nome} em ${formatDataBR(
                                  slotAdminDate
                                )}.`
                              );
                            } catch {
                              toast.error('Erro ao bloquear horários.');
                            } finally {
                              setIsUpdatingSlotAdmin(false);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-semibold cursor-pointer disabled:opacity-50"
                        >
                          Bloquear Todos
                        </button>
                      </div>
                    </div>

                    {/* LISTA DE FAIXAS HORÁRIAS */}
                    <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
                      {adminView.slots.map((slot) => {
                        const isReleased =
                          slot.rawAvailableSlot &&
                          isSlotActiveOrReleased(slot.rawAvailableSlot);
                        const isClass = slot.state === 'OCUPADO_AULA';
                        const isBooked = slot.state === 'OCUPADO_RESERVA';

                        return (
                          <div
                            key={slot.key}
                            className={cn(
                              'px-3 py-2.5 rounded-xl border flex items-center justify-between gap-3 text-xs',
                              isClass
                                ? 'bg-emerald-50/50 border-emerald-200 text-emerald-950'
                                : isBooked
                                ? 'bg-rose-50/60 border-rose-200 text-rose-950'
                                : isReleased
                                ? 'bg-emerald-50 border-emerald-300 text-slate-900'
                                : 'bg-white border-slate-200 text-slate-700'
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-mono tabular-nums font-bold">
                                  {slot.inicio} – {slot.fim}
                                </span>
                                <span className="text-[11px] opacity-80 truncate">
                                  {slot.label}
                                </span>
                              </div>
                              <p className="text-[11px] opacity-75 truncate mt-0.5">
                                {isClass
                                  ? slot.statusDetail
                                  : isBooked
                                  ? 'Já possui reserva ativa nesta data'
                                  : isReleased
                                  ? 'Status: Liberado para agendamento de alunos'
                                  : 'Status: Bloqueado (padrão)'}
                              </p>
                            </div>

                            {!isClass && (
                              <button
                                type="button"
                                disabled={isUpdatingSlotAdmin}
                                onClick={async () => {
                                  setIsUpdatingSlotAdmin(true);
                                  try {
                                    await setSlotReleaseStatus({
                                      room: slotAdminRoom,
                                      data: slotAdminDate,
                                      inicio: slot.inicio,
                                      fim: slot.fim,
                                      label: slot.label,
                                      release: !isReleased,
                                    });
                                    toast.success(
                                      !isReleased
                                        ? `Horário ${slot.inicio}–${slot.fim} liberado!`
                                        : `Horário ${slot.inicio}–${slot.fim} bloqueado.`
                                    );
                                  } catch {
                                    toast.error('Falha ao atualizar horário.');
                                  } finally {
                                    setIsUpdatingSlotAdmin(false);
                                  }
                                }}
                                className={cn(
                                  'px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-colors cursor-pointer disabled:opacity-50',
                                  isReleased
                                    ? 'bg-amber-100 hover:bg-amber-200 text-amber-900'
                                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                )}
                              >
                                {isReleased ? 'Bloquear' : 'Liberar'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* ADICIONAR E LIBERAR HORÁRIO PERSONALIZADO */}
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
                      <p className="text-xs font-bold text-slate-800">
                        Liberar Horário Específico / Extra
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          type="time"
                          value={customSlotStart}
                          onChange={(e) => setCustomSlotStart(e.target.value)}
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono tabular-nums font-semibold"
                        />
                        <input
                          type="time"
                          value={customSlotEnd}
                          onChange={(e) => setCustomSlotEnd(e.target.value)}
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono tabular-nums font-semibold"
                        />
                        <input
                          type="text"
                          placeholder="Rótulo opcional"
                          value={customSlotLabel}
                          onChange={(e) => setCustomSlotLabel(e.target.value)}
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={isUpdatingSlotAdmin}
                        onClick={async () => {
                          if (!customSlotStart || !customSlotEnd || customSlotStart >= customSlotEnd) {
                            toast.error('Informe um intervalo de início e término válido.');
                            return;
                          }
                          const hasClass = classesOnDate.find(
                            (aula) =>
                              customSlotStart < aula.horarioFim &&
                              customSlotEnd > aula.horarioInicio
                          );
                          if (hasClass) {
                            toast.error(
                              `Conflito com aula regular (${hasClass.materia}: ${hasClass.horarioInicio}–${hasClass.horarioFim}).`
                            );
                            return;
                          }
                          setIsUpdatingSlotAdmin(true);
                          try {
                            await setSlotReleaseStatus({
                              room: slotAdminRoom,
                              data: slotAdminDate,
                              inicio: customSlotStart,
                              fim: customSlotEnd,
                              label:
                                customSlotLabel.trim() ||
                                `Horário Extra ${customSlotStart}–${customSlotEnd}`,
                              release: true,
                            });
                            setCustomSlotLabel('');
                            toast.success(
                              `Horário ${customSlotStart}–${customSlotEnd} liberado em ${formatDataBR(
                                slotAdminDate
                              )}.`
                            );
                          } catch {
                            toast.error('Erro ao liberar horário personalizado.');
                          } finally {
                            setIsUpdatingSlotAdmin(false);
                          }
                        }}
                        className="w-full py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                      >
                        + Criar e Liberar Horário nesta Data
                      </button>
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL CRUD DE AMBIENTE (EXCLUSIVO PERFIL ADM) */}
      <AnimatePresence>
        {isModalOpen && isAdmin && (
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
