/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Clock,
  Calendar,
  Plus,
  Trash2,
  Edit3,
  CheckCircle2,
  XCircle,
  Save,
  Wand2,
  X,
  Lock,
  Unlock,
  Building2,
  GraduationCap,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useScheduleStore, buildTimeBlocks } from '../../../store/useScheduleStore';
import { useRoomStore } from '../../../store/useRoomStore';
import { useReservationStore } from '../../../store/useReservationStore';
import {
  isSlotActiveOrReleased,
  matchesSlotRoom,
  useAvailableSlotsStore,
} from '../../../store/useAvailableSlotsStore';
import {
  getCurriculumClassesForRoomOnDate,
  isSpaceReleasedByAdmin,
} from '../../../services/reservationService';
import { DayOfWeek, ScheduleException, TimeBlock } from '../../../types';
import { formatDataBR, getTodayLocalISO, normalizeDateToISO } from '../../../utils/dateUtils';
import { cn } from '../../../lib/utils';

const ALL_WEEK_DAYS: DayOfWeek[] = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/**
 * Aba 1 — Abertura, Liberação Explícita (`available_slots`) e Controle Centralizado de Horários
 * Por padrão, todos os horários iniciam bloqueados para Usuários/Alunos.
 * O Administrador libera horários específicos por Sala + Data em `available_slots`, além de gerenciar
 * a grade base de blocos pedagógicos e exceções de calendário em `schedules`.
 */
export function AdminSchedulesTab() {
  const {
    config,
    exceptions,
    saveGlobalConfig,
    addException,
    updateException,
    deleteException,
  } = useScheduleStore();
  const rooms = useRoomStore((state) => state.rooms);
  const reservations = useReservationStore((state) => state.reservations);
  const {
    slots: availableSlots,
    setSlotReleaseStatus,
    releaseMultipleSlotsForRoomAndDate,
    blockAllSlotsForRoomAndDate,
    deleteSlot,
  } = useAvailableSlotsStore();

  const todayISO = getTodayLocalISO();
  const tomorrowISO = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return normalizeDateToISO(d);
  }, []);

  // Estado da seção de Liberação Explícita (`available_slots`) por Sala + Data
  const [releaseScopeRoomId, setReleaseScopeRoomId] = useState<string>('');
  const [releaseDate, setReleaseDate] = useState<string>(todayISO);
  const [customSlotStart, setCustomSlotStart] = useState<string>('17:00');
  const [customSlotEnd, setCustomSlotEnd] = useState<string>('17:50');
  const [customSlotLabel, setCustomSlotLabel] = useState<string>('');
  const [selectedBatchBlockIds, setSelectedBatchBlockIds] = useState<string[]>([]);
  const [isMutatingSlots, setIsMutatingSlots] = useState<boolean>(false);

  // Inicializa sala padrão quando lista de salas carregar
  useEffect(() => {
    if (!releaseScopeRoomId && rooms.length > 0) {
      setReleaseScopeRoomId(rooms[0].firestoreId);
    }
  }, [rooms, releaseScopeRoomId]);

  // Estado local editável da configuração global
  const [reservasAbertas, setReservasAbertas] = useState(config.reservasAbertas);
  const [horaAbertura, setHoraAbertura] = useState(config.horaAberturaSistema);
  const [janelaInicio, setJanelaInicio] = useState(config.janelaInicio);
  const [janelaFim, setJanelaFim] = useState(config.janelaFim);
  const [duracaoBloco, setDuracaoBloco] = useState(config.duracaoBlocoPadraoMinutos || 50);
  const [intervaloBlocos, setIntervaloBlocos] = useState(config.intervaloEntreBlocosMinutos ?? 10);
  const [antecedenciaDias, setAntecedenciaDias] = useState(config.antecedenciaMaximaDias || 1);
  const [diasPermitidos, setDiasPermitidos] = useState<DayOfWeek[]>(config.diasSemanaPermitidos);
  const [blocosPadrao, setBlocosPadrao] = useState<TimeBlock[]>(config.blocosPadrao);
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);

  // Estado para modal de novo bloco manual
  const [isBlockModalOpen, setIsBlockModalOpen] = useState(false);
  const [newBlockLabel, setNewBlockLabel] = useState('');
  const [newBlockStart, setNewBlockStart] = useState('19:00');
  const [newBlockEnd, setNewBlockEnd] = useState('19:50');

  // Estado para modal de exceção de data
  const [isExceptionModalOpen, setIsExceptionModalOpen] = useState(false);
  const [editingException, setEditingException] = useState<ScheduleException | null>(null);
  const [exData, setExData] = useState(getTodayLocalISO());
  const [exTitulo, setExTitulo] = useState('');
  const [exFechado, setExFechado] = useState(false);
  const [exJanelaInicio, setExJanelaInicio] = useState('08:00');
  const [exJanelaFim, setExJanelaFim] = useState('22:00');
  const [exSalaId, setExSalaId] = useState('TODAS');
  const [exMotivo, setExMotivo] = useState('');
  const [deletingExId, setDeletingExId] = useState<string | null>(null);

  useEffect(() => {
    setReservasAbertas(config.reservasAbertas);
    setHoraAbertura(config.horaAberturaSistema);
    setJanelaInicio(config.janelaInicio);
    setJanelaFim(config.janelaFim);
    setDuracaoBloco(config.duracaoBlocoPadraoMinutos || 50);
    setIntervaloBlocos(config.intervaloEntreBlocosMinutos ?? 10);
    setAntecedenciaDias(config.antecedenciaMaximaDias || 1);
    setDiasPermitidos(config.diasSemanaPermitidos || ALL_WEEK_DAYS);
    setBlocosPadrao(config.blocosPadrao || []);
  }, [config]);

  const selectedRoomForRelease = useMemo(
    () => rooms.find((r) => r.firestoreId === releaseScopeRoomId) || null,
    [rooms, releaseScopeRoomId]
  );

  // Monta os slots da sala selecionada na data de liberação
  const singleRoomSlotsForDate = useMemo(() => {
    if (!selectedRoomForRelease || !releaseDate) return [];

    const curriculumClasses = getCurriculumClassesForRoomOnDate(
      selectedRoomForRelease,
      releaseDate
    );
    const activeRoomReservations = reservations.filter(
      (r) =>
        (r.salaId === selectedRoomForRelease.firestoreId ||
          r.salaInstitutionalId === selectedRoomForRelease.id) &&
        r.data === releaseDate &&
        (r.status === 'PENDENTE' || r.status === 'CONFIRMADA')
    );

    const existingDocs = availableSlots.filter(
      (s) => s.data === releaseDate && matchesSlotRoom(s, selectedRoomForRelease)
    );

    const baseBlocks =
      selectedRoomForRelease.blocosHorarios && selectedRoomForRelease.blocosHorarios.length > 0
        ? selectedRoomForRelease.blocosHorarios
        : config.blocosPadrao || [];

    const map = new Map<string, { inicio: string; fim: string; label: string }>();
    for (const b of baseBlocks) {
      if (!b.inicio || !b.fim || b.inicio >= b.fim) continue;
      map.set(`${b.inicio}_${b.fim}`, {
        inicio: b.inicio,
        fim: b.fim,
        label: b.label || `Bloco ${b.inicio}–${b.fim}`,
      });
    }
    for (const s of existingDocs) {
      if (!s.inicio || !s.fim || s.inicio >= s.fim) continue;
      map.set(`${s.inicio}_${s.fim}`, {
        inicio: s.inicio,
        fim: s.fim,
        label: s.label || `Horário ${s.inicio}–${s.fim}`,
      });
    }

    return Array.from(map.values())
      .sort((a, b) => a.inicio.localeCompare(b.inicio))
      .map((item) => {
        const docMatch = existingDocs.find(
          (d) => d.inicio === item.inicio && d.fim === item.fim
        );
        const classMatch = curriculumClasses.find(
          (aula) => item.inicio < aula.horarioFim && item.fim > aula.horarioInicio
        );
        const resMatch = activeRoomReservations.find(
          (res) => item.inicio < res.fim && item.fim > res.inicio
        );
        const isReleased = Boolean(docMatch && isSlotActiveOrReleased(docMatch));

        return {
          ...item,
          slotDoc: docMatch,
          classMatch,
          resMatch,
          isReleased,
        };
      });
  }, [selectedRoomForRelease, releaseDate, reservations, availableSlots, config.blocosPadrao]);

  // Lista de registros atualmente liberados em `available_slots` (a partir de hoje)
  const activeUpcomingSlots = useMemo(() => {
    return availableSlots
      .filter((s) => s.data >= todayISO && isSlotActiveOrReleased(s))
      .sort((a, b) => {
        if (a.data !== b.data) return a.data.localeCompare(b.data);
        if (a.salaNome !== b.salaNome) return a.salaNome.localeCompare(b.salaNome);
        return a.inicio.localeCompare(b.inicio);
      });
  }, [availableSlots, todayISO]);

  const handleToggleSingleSlotRelease = async (item: {
    inicio: string;
    fim: string;
    label: string;
    isReleased: boolean;
  }) => {
    if (!selectedRoomForRelease || !releaseDate) return;
    setIsMutatingSlots(true);
    try {
      await setSlotReleaseStatus({
        room: selectedRoomForRelease,
        data: releaseDate,
        inicio: item.inicio,
        fim: item.fim,
        label: item.label,
        release: !item.isReleased,
      });
      toast.success(
        !item.isReleased
          ? `Horário ${item.inicio}–${item.fim} liberado para ${selectedRoomForRelease.nome} em ${formatDataBR(releaseDate)}.`
          : `Horário ${item.inicio}–${item.fim} bloqueado novamente.`
      );
    } catch {
      toast.error('Falha ao atualizar status de liberação do horário.');
    } finally {
      setIsMutatingSlots(false);
    }
  };

  const handleReleaseAllFreeForRoom = async () => {
    if (!selectedRoomForRelease || !releaseDate) return;
    const freeBlocks = singleRoomSlotsForDate
      .filter((item) => !item.classMatch && !item.resMatch)
      .map((item) => ({
        inicio: item.inicio,
        fim: item.fim,
        label: item.label,
      }));

    if (freeBlocks.length === 0) {
      toast.error('Não há blocos livres de aula regular para liberar nesta sala e data.');
      return;
    }

    setIsMutatingSlots(true);
    try {
      const count = await releaseMultipleSlotsForRoomAndDate({
        room: selectedRoomForRelease,
        data: releaseDate,
        blocks: freeBlocks,
      });
      toast.success(
        `${count} horário(s) liberado(s) em ${formatDataBR(releaseDate)} para ${selectedRoomForRelease.nome}.`
      );
    } catch {
      toast.error('Erro ao liberar horários em lote.');
    } finally {
      setIsMutatingSlots(false);
    }
  };

  const handleBlockAllForRoom = async () => {
    if (!selectedRoomForRelease || !releaseDate) return;
    setIsMutatingSlots(true);
    try {
      const count = await blockAllSlotsForRoomAndDate({
        room: selectedRoomForRelease,
        data: releaseDate,
      });
      if (count === 0) {
        toast.info('Nenhum horário estava liberado nesta data para esta sala.');
      } else {
        toast.success(
          `${count} horário(s) bloqueado(s) em ${formatDataBR(releaseDate)} para ${selectedRoomForRelease.nome}.`
        );
      }
    } catch {
      toast.error('Erro ao bloquear horários da sala.');
    } finally {
      setIsMutatingSlots(false);
    }
  };

  const handleAddAndReleaseCustomSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!releaseDate || !customSlotStart || !customSlotEnd || customSlotStart >= customSlotEnd) {
      toast.error('Informe um horário inicial anterior ao horário final.');
      return;
    }

    if (releaseScopeRoomId === 'TODAS_ATIVAS') {
      const activeRooms = rooms.filter((r) => isSpaceReleasedByAdmin(r).released);
      if (activeRooms.length === 0) {
        toast.error('Nenhuma sala ativa encontrada.');
        return;
      }
      setIsMutatingSlots(true);
      try {
        let totalReleased = 0;
        for (const room of activeRooms) {
          const classes = getCurriculumClassesForRoomOnDate(room, releaseDate);
          const hasClassConflict = classes.some(
            (aula) => customSlotStart < aula.horarioFim && customSlotEnd > aula.horarioInicio
          );
          if (hasClassConflict) continue;
          const c = await releaseMultipleSlotsForRoomAndDate({
            room,
            data: releaseDate,
            blocks: [
              {
                inicio: customSlotStart,
                fim: customSlotEnd,
                label: customSlotLabel.trim() || `Horário ${customSlotStart}–${customSlotEnd}`,
              },
            ],
          });
          totalReleased += c;
        }
        setCustomSlotLabel('');
        toast.success(
          `Horário ${customSlotStart}–${customSlotEnd} liberado em ${totalReleased} sala(s) sem conflito de aula em ${formatDataBR(releaseDate)}.`
        );
      } catch {
        toast.error('Erro ao liberar horário personalizado em lote.');
      } finally {
        setIsMutatingSlots(false);
      }
      return;
    }

    if (!selectedRoomForRelease) {
      toast.error('Selecione uma sala válida.');
      return;
    }

    const classes = getCurriculumClassesForRoomOnDate(selectedRoomForRelease, releaseDate);
    const conflict = classes.find(
      (aula) => customSlotStart < aula.horarioFim && customSlotEnd > aula.horarioInicio
    );
    if (conflict) {
      toast.error(
        `Conflito com aula regular da grade: ${conflict.materia} (${conflict.horarioInicio}–${conflict.horarioFim}).`
      );
      return;
    }

    setIsMutatingSlots(true);
    try {
      await setSlotReleaseStatus({
        room: selectedRoomForRelease,
        data: releaseDate,
        inicio: customSlotStart,
        fim: customSlotEnd,
        label: customSlotLabel.trim() || `Horário ${customSlotStart}–${customSlotEnd}`,
        release: true,
      });
      setCustomSlotLabel('');
      toast.success(
        `Horário personalizado ${customSlotStart}–${customSlotEnd} liberado para ${selectedRoomForRelease.nome}.`
      );
    } catch {
      toast.error('Falha ao liberar horário personalizado.');
    } finally {
      setIsMutatingSlots(false);
    }
  };

  const handleBatchReleaseAcrossAllActiveRooms = async () => {
    const chosenBlocks = (config.blocosPadrao || []).filter((b) =>
      selectedBatchBlockIds.includes(b.id)
    );
    if (chosenBlocks.length === 0) {
      toast.error('Selecione ao menos um bloco de horário para liberar nas salas ativas.');
      return;
    }

    const activeRooms = rooms.filter((r) => isSpaceReleasedByAdmin(r).released);
    if (activeRooms.length === 0) {
      toast.error('Nenhuma sala ativa disponível para liberação.');
      return;
    }

    setIsMutatingSlots(true);
    try {
      let totalCreated = 0;
      for (const room of activeRooms) {
        const classes = getCurriculumClassesForRoomOnDate(room, releaseDate);
        const nonConflicting = chosenBlocks.filter(
          (blk) =>
            !classes.some(
              (aula) => blk.inicio < aula.horarioFim && blk.fim > aula.horarioInicio
            )
        );
        if (nonConflicting.length > 0) {
          const added = await releaseMultipleSlotsForRoomAndDate({
            room,
            data: releaseDate,
            blocks: nonConflicting.map((b) => ({
              inicio: b.inicio,
              fim: b.fim,
              label: b.label,
            })),
          });
          totalCreated += added;
        }
      }
      toast.success(
        `${totalCreated} registro(s) liberado(s) em ${formatDataBR(releaseDate)} respeitando a grade curricular.`
      );
    } catch {
      toast.error('Erro ao liberar horários para múltiplas salas.');
    } finally {
      setIsMutatingSlots(false);
    }
  };

  const toggleDayOfWeek = (day: DayOfWeek) => {
    setDiasPermitidos((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const handleGenerateStandardBlocks = () => {
    const generated = buildTimeBlocks(janelaInicio, janelaFim, duracaoBloco, intervaloBlocos);
    if (generated.length === 0) {
      toast.error('Verifique o horário de início, término e a duração mínima do bloco (15 min).');
      return;
    }
    setBlocosPadrao(generated);
    toast.success(
      `${generated.length} blocos padrão de ${duracaoBloco} minutos gerados. Clique em Salvar Regras para publicar.`
    );
  };

  const handleAddSingleBlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBlockStart || !newBlockEnd || newBlockStart >= newBlockEnd) {
      toast.error('O horário final do bloco deve ser posterior ao início.');
      return;
    }
    const nextBlock: TimeBlock = {
      id: `blk_${Date.now()}`,
      label: newBlockLabel.trim() || `Bloco ${newBlockStart}–${newBlockEnd}`,
      inicio: newBlockStart,
      fim: newBlockEnd,
      ativo: true,
    };
    const updated = [...blocosPadrao, nextBlock].sort((a, b) => a.inicio.localeCompare(b.inicio));
    setBlocosPadrao(updated);
    setNewBlockLabel('');
    setIsBlockModalOpen(false);
  };

  const handleToggleBlockActive = (blockId: string) => {
    setBlocosPadrao((prev) =>
      prev.map((b) => (b.id === blockId ? { ...b, ativo: !b.ativo } : b))
    );
  };

  const handleRemoveBlock = (blockId: string) => {
    setBlocosPadrao((prev) => prev.filter((b) => b.id !== blockId));
  };

  const handleSaveGlobalRules = async (e: React.FormEvent) => {
    e.preventDefault();
    if (janelaInicio >= janelaFim) {
      toast.error('O fim da janela operacional deve ser posterior ao início.');
      return;
    }
    setIsSavingGlobal(true);
    try {
      await saveGlobalConfig({
        reservasAbertas,
        horaAberturaSistema: Number(horaAbertura),
        janelaInicio,
        janelaFim,
        duracaoBlocoPadraoMinutos: Number(duracaoBloco),
        intervaloEntreBlocosMinutos: Number(intervaloBlocos),
        antecedenciaMaximaDias: Number(antecedenciaDias),
        diasSemanaPermitidos: diasPermitidos,
        blocosPadrao,
      });
      toast.success('Janelas operacionais e grade base de blocos atualizadas em tempo real.');
    } catch {
      toast.error('Falha ao salvar configuração de horários.');
    } finally {
      setIsSavingGlobal(false);
    }
  };

  const handleQuickTogglePortal = async () => {
    const nextState = !reservasAbertas;
    setReservasAbertas(nextState);
    try {
      await saveGlobalConfig({ reservasAbertas: nextState });
      toast.success(
        nextState
          ? 'Portal de agendamentos habilitado para receber reservas nos horários liberados.'
          : 'Novos agendamentos suspensos temporariamente.'
      );
    } catch {
      setReservasAbertas(!nextState);
      toast.error('Não foi possível alterar o status de abertura.');
    }
  };

  const openNewExceptionModal = () => {
    setEditingException(null);
    setExData(getTodayLocalISO());
    setExTitulo('');
    setExFechado(false);
    setExJanelaInicio('08:00');
    setExJanelaFim('22:00');
    setExSalaId('TODAS');
    setExMotivo('');
    setIsExceptionModalOpen(true);
  };

  const openEditExceptionModal = (ex: ScheduleException) => {
    setEditingException(ex);
    setExData(ex.data);
    setExTitulo(ex.titulo);
    setExFechado(ex.fechado);
    setExJanelaInicio(ex.janelaInicio || config.janelaInicio);
    setExJanelaFim(ex.janelaFim || config.janelaFim);
    setExSalaId(ex.salaId || 'TODAS');
    setExMotivo(ex.motivo || '');
    setIsExceptionModalOpen(true);
  };

  const handleSaveException = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exData || !exTitulo.trim()) {
      toast.error('Preencha a data e o título da exceção.');
      return;
    }
    if (!exFechado && exJanelaInicio >= exJanelaFim) {
      toast.error('Na janela excepcional, o horário final deve ser posterior ao inicial.');
      return;
    }

    const roomObj = rooms.find((r) => r.firestoreId === exSalaId);
    const salaNome = exSalaId === 'TODAS' ? 'Todos os Ambientes' : roomObj?.nome || 'Sala Específica';

    try {
      if (editingException) {
        await updateException(editingException.id, {
          data: exData,
          titulo: exTitulo.trim(),
          fechado: exFechado,
          janelaInicio: exFechado ? undefined : exJanelaInicio,
          janelaFim: exFechado ? undefined : exJanelaFim,
          salaId: exSalaId,
          salaNome,
          motivo: exMotivo.trim(),
        });
        toast.success('Exceção de horário atualizada.');
      } else {
        await addException({
          data: exData,
          titulo: exTitulo.trim(),
          fechado: exFechado,
          janelaInicio: exFechado ? undefined : exJanelaInicio,
          janelaFim: exFechado ? undefined : exJanelaFim,
          salaId: exSalaId,
          salaNome,
          motivo: exMotivo.trim(),
        });
        toast.success('Exceção de horário registrada no calendário operacional.');
      }
      setIsExceptionModalOpen(false);
    } catch {
      toast.error('Erro ao salvar exceção de horário.');
    }
  };

  return (
    <div className="space-y-8">
      {/* BARRA DE ABERTURA IMEDIATA DO PORTAL */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="font-semibold text-slate-900">Status Global de Agendamentos</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Janela base: {config.janelaInicio} às {config.janelaFim}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Abertura diária às {String(config.horaAberturaSistema).padStart(2, '0')}:00
            </span>
          </div>
          <h3 className="text-lg font-bold text-slate-900">
            {reservasAbertas
              ? 'Portal aberto — horários bloqueados por padrão até liberação explícita por sala e data'
              : 'Agendamentos suspensos globalmente pela Coordenação'}
          </h3>
          <p className="text-sm text-slate-500 max-w-2xl">
            Usuários/Alunos visualizam apenas a grade regular de aulas e os slots que você liberar explicitamente abaixo.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleQuickTogglePortal}
            className={cn(
              'px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer',
              reservasAbertas
                ? 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            )}
          >
            {reservasAbertas ? (
              <>
                <Lock className="h-4 w-4" />
                Suspender Abertura Global
              </>
            ) : (
              <>
                <Unlock className="h-4 w-4" />
                Liberar Abertura Global
              </>
            )}
          </button>
        </div>
      </div>

      {/* SEÇÃO PRINCIPAL: LIBERAÇÃO EXPLÍCITA DE HORÁRIOS POR SALA E DATA (`available_slots`) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-fatec-red">Regra de Bloqueio Padrão Ativa</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {activeUpcomingSlots.length} slot(s) liberado(s) a partir de hoje
              </span>
            </div>
            <h3 className="text-base font-bold text-slate-900">
              Liberação de Horários por Sala e Data
            </h3>
            <p className="text-xs text-slate-500 max-w-2xl">
              Selecione a sala e a data para liberar ou bloquear horários de agendamento. Apenas os horários marcados como Liberados ficam clicáveis na visão do Aluno/Servidor.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setReleaseDate(todayISO)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap',
                releaseDate === todayISO
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
              )}
            >
              Hoje ({formatDataBR(todayISO)})
            </button>
            <button
              type="button"
              onClick={() => setReleaseDate(tomorrowISO)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap',
                releaseDate === tomorrowISO
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
              )}
            >
              Amanhã ({formatDataBR(tomorrowISO)})
            </button>
          </div>
        </div>

        {/* SELETORES DE SALA + DATA */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-7 space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 block">
              Espaço Físico / Sala
            </label>
            <select
              value={releaseScopeRoomId}
              onChange={(e) => setReleaseScopeRoomId(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
            >
              {rooms.map((r) => (
                <option key={r.firestoreId} value={r.firestoreId}>
                  {r.id} — {r.nome} ({r.andar})
                </option>
              ))}
              <option value="TODAS_ATIVAS">Lote: Todas as Salas Ativas da Unidade</option>
            </select>
          </div>

          <div className="md:col-span-5 space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 block">
              Data da Liberação
            </label>
            <input
              type="date"
              min={todayISO}
              value={releaseDate}
              onChange={(e) => setReleaseDate(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
            />
          </div>
        </div>

        {/* MODO 1: SALA INDIVIDUAL */}
        {releaseScopeRoomId !== 'TODAS_ATIVAS' && selectedRoomForRelease && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs text-slate-600 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-slate-400 shrink-0" />
                <span>
                  Grade de slots para <strong className="text-slate-900">{selectedRoomForRelease.nome}</strong> em{' '}
                  <strong className="font-mono tabular-nums text-slate-900">{formatDataBR(releaseDate)}</strong>
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isMutatingSlots}
                  onClick={handleReleaseAllFreeForRoom}
                  className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  Liberar Todos sem Aula
                </button>
                <button
                  type="button"
                  disabled={isMutatingSlots}
                  onClick={handleBlockAllForRoom}
                  className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <Lock className="h-3.5 w-3.5" />
                  Bloquear Todos na Data
                </button>
              </div>
            </div>

            {singleRoomSlotsForDate.length === 0 ? (
              <div className="p-8 text-center border border-dashed border-slate-200 rounded-xl text-xs text-slate-500">
                Nenhum bloco base cadastrado. Gere os blocos padrão abaixo ou libere um horário personalizado a seguir.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {singleRoomSlotsForDate.map((item) => {
                  const hasClass = Boolean(item.classMatch);
                  const hasRes = Boolean(item.resMatch);

                  return (
                    <div
                      key={`${item.inicio}_${item.fim}`}
                      className={cn(
                        'p-3.5 rounded-xl border flex items-center justify-between gap-3 transition-colors',
                        hasClass
                          ? 'bg-emerald-50/40 border-emerald-200'
                          : hasRes
                          ? 'bg-rose-50/40 border-rose-200'
                          : item.isReleased
                          ? 'bg-emerald-50/70 border-emerald-300'
                          : 'bg-slate-50/70 border-slate-200'
                      )}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-mono tabular-nums font-bold text-slate-900">
                          {item.inicio} – {item.fim}
                        </div>
                        <p className="text-xs text-slate-600 truncate">
                          {hasClass
                            ? `Aula: ${item.classMatch?.materia}`
                            : hasRes
                            ? 'Já reservado por usuário'
                            : item.isReleased
                            ? 'Liberado para agendamento'
                            : 'Bloqueado (Padrão)'}
                        </p>
                      </div>

                      {hasClass ? (
                        <span className="text-xs font-semibold text-emerald-800 flex items-center gap-1 shrink-0">
                          <GraduationCap className="h-3.5 w-3.5" />
                          Grade
                        </span>
                      ) : hasRes ? (
                        <span className="text-xs font-semibold text-rose-700 shrink-0">
                          Ocupado
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={isMutatingSlots}
                          onClick={() => handleToggleSingleSlotRelease(item)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 flex items-center gap-1.5 disabled:opacity-50',
                            item.isReleased
                              ? 'bg-white border border-slate-200 text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200'
                              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          )}
                        >
                          {item.isReleased ? (
                            <>
                              <Lock className="h-3 w-3" />
                              Bloquear
                            </>
                          ) : (
                            <>
                              <Unlock className="h-3 w-3" />
                              Liberar
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* MODO 2: LOTE EM TODAS AS SALAS ATIVAS */}
        {releaseScopeRoomId === 'TODAS_ATIVAS' && (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-bold text-slate-900">
                  Liberação em Lote para Todas as Salas Ativas ({formatDataBR(releaseDate)})
                </h4>
                <p className="text-xs text-slate-500">
                  Selecione os blocos que deseja abrir. Salas com aula regular na grade naquele horário são ignoradas automaticamente.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedBatchBlockIds((config.blocosPadrao || []).map((b) => b.id))
                  }
                  className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap"
                >
                  Marcar todos
                </button>
                <span className="text-slate-300">·</span>
                <button
                  type="button"
                  onClick={() => setSelectedBatchBlockIds([])}
                  className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap"
                >
                  Limpar
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {(config.blocosPadrao || []).map((blk) => {
                const checked = selectedBatchBlockIds.includes(blk.id);
                return (
                  <button
                    key={blk.id}
                    type="button"
                    onClick={() =>
                      setSelectedBatchBlockIds((prev) =>
                        prev.includes(blk.id)
                          ? prev.filter((id) => id !== blk.id)
                          : [...prev, blk.id]
                      )
                    }
                    className={cn(
                      'p-2.5 rounded-xl border text-left transition-colors cursor-pointer',
                      checked
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                    )}
                  >
                    <div className="text-xs font-mono tabular-nums font-bold">
                      {blk.inicio} – {blk.fim}
                    </div>
                    <div
                      className={cn(
                        'text-[11px] truncate',
                        checked ? 'text-slate-300' : 'text-slate-500'
                      )}
                    >
                      {blk.label}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={isMutatingSlots || selectedBatchBlockIds.length === 0}
                onClick={handleBatchReleaseAcrossAllActiveRooms}
                className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Unlock className="h-4 w-4" />
                Liberar Blocos Selecionados nas Salas sem Aula
              </button>
            </div>
          </div>
        )}

        {/* CRIAR E LIBERAR HORÁRIO PERSONALIZADO NA DATA */}
        <form
          onSubmit={handleAddAndReleaseCustomSlot}
          className="pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
        >
          <div className="sm:col-span-3 space-y-1">
            <label className="text-xs font-semibold text-slate-700 block">
              Horário Personalizado (Início)
            </label>
            <input
              type="time"
              value={customSlotStart}
              onChange={(e) => setCustomSlotStart(e.target.value)}
              required
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
            />
          </div>
          <div className="sm:col-span-3 space-y-1">
            <label className="text-xs font-semibold text-slate-700 block">Término</label>
            <input
              type="time"
              value={customSlotEnd}
              onChange={(e) => setCustomSlotEnd(e.target.value)}
              required
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
            />
          </div>
          <div className="sm:col-span-4 space-y-1">
            <label className="text-xs font-semibold text-slate-700 block">
              Identificação (Opcional)
            </label>
            <input
              type="text"
              placeholder="Ex: Plantão de Monitoria / Estudo"
              value={customSlotLabel}
              onChange={(e) => setCustomSlotLabel(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={isMutatingSlots}
              className="w-full py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 h-[38px] cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              Liberar Slot
            </button>
          </div>
        </form>

        {/* RESUMO DE SLOTS LIBERADOS A PARTIR DE HOJE */}
        {activeUpcomingSlots.length > 0 && (
          <div className="pt-4 border-t border-slate-100 space-y-2.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700">
                Horários Liberados Ativos (a partir de {formatDataBR(todayISO)})
              </h4>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                Total: {activeUpcomingSlots.length}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
              {activeUpcomingSlots.slice(0, 40).map((slot) => (
                <div
                  key={slot.id}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-50"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-mono tabular-nums font-bold text-slate-900">
                      {formatDataBR(slot.data)}
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="font-mono tabular-nums font-semibold text-emerald-700">
                      {slot.inicio} – {slot.fim}
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="font-semibold text-slate-800 truncate">{slot.salaNome}</span>
                  </div>
                  <button
                    type="button"
                    disabled={isMutatingSlots}
                    onClick={async () => {
                      setIsMutatingSlots(true);
                      try {
                        await deleteSlot(slot.id);
                        toast.success('Liberação removida.');
                      } catch {
                        toast.error('Erro ao remover liberação.');
                      } finally {
                        setIsMutatingSlots(false);
                      }
                    }}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer shrink-0"
                    title="Revogar e remover liberação"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* GRID SECUNDÁRIO: JANELAS OPERACIONAIS + BLOCOS PADRÃO */}
      <form onSubmit={handleSaveGlobalRules} className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* COLUNA ESQUERDA: PARÂMETROS DA JANELA */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">Janelas Operacionais Padrão</h3>
            <p className="text-xs text-slate-500 mt-1">
              Defina os parâmetros institucionais de abertura do portal e dias da semana habilitados.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">
                Início da Janela
              </label>
              <input
                type="time"
                value={janelaInicio}
                onChange={(e) => setJanelaInicio(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">
                Término da Janela
              </label>
              <input
                type="time"
                value={janelaFim}
                onChange={(e) => setJanelaFim(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">
                Abertura do Portal (Hora)
              </label>
              <select
                value={horaAbertura}
                onChange={(e) => setHoraAbertura(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
              >
                {Array.from({ length: 13 }, (_, i) => i).map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? '00:00 (24h liberado)' : `${String(h).padStart(2, '0')}:00`}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">
                Antecedência Máxima
              </label>
              <select
                value={antecedenciaDias}
                onChange={(e) => setAntecedenciaDias(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:ring-2 focus:ring-fatec-red outline-none"
              >
                <option value={0}>Somente para o próprio dia</option>
                <option value={1}>Até 1 dia (Hoje e Amanhã)</option>
                <option value={3}>Até 3 dias de antecedência</option>
                <option value={7}>Até 7 dias (1 semana)</option>
                <option value={15}>Até 15 dias</option>
                <option value={30}>Até 30 dias</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700 block">
              Dias da Semana Habilitados
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {ALL_WEEK_DAYS.map((day) => {
                const active = diasPermitidos.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDayOfWeek(day)}
                    className={cn(
                      'py-2 px-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer border',
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-500 border-slate-200 hover:text-slate-900'
                    )}
                  >
                    {day.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100">
            <button
              type="submit"
              disabled={isSavingGlobal}
              className="w-full py-3 px-4 bg-fatec-red hover:bg-red-800 text-white rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <Save className="h-4 w-4" />
              {isSavingGlobal ? 'Salvando configurações...' : 'Salvar Regras e Grade Base'}
            </button>
          </div>
        </div>

        {/* COLUNA DIREITA: GERADOR E GESTÃO DE BLOCOS PADRÃO */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Grade Base de Blocos Pedagógicos
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Define os blocos base (ex: 50 min) usados como modelo. Permanecem bloqueados para alunos até serem liberados por sala e data na seção acima.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsBlockModalOpen(true)}
              className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar Bloco
            </button>
          </div>

          {/* GERADOR AUTOMÁTICO DE BLOCOS */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-semibold text-slate-700 block">
                Duração da Aula / Bloco (min)
              </label>
              <input
                type="number"
                min={15}
                max={240}
                step={5}
                value={duracaoBloco}
                onChange={(e) => setDuracaoBloco(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
              />
            </div>

            <div className="flex-1 space-y-1">
              <label className="text-xs font-semibold text-slate-700 block">
                Intervalo entre Blocos (min)
              </label>
              <input
                type="number"
                min={0}
                max={60}
                step={5}
                value={intervaloBlocos}
                onChange={(e) => setIntervaloBlocos(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
              />
            </div>

            <button
              type="button"
              onClick={handleGenerateStandardBlocks}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer h-[38px]"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Gerar Blocos ({duracaoBloco} min)
            </button>
          </div>

          {/* LISTA DE BLOCOS */}
          {blocosPadrao.length === 0 ? (
            <div className="py-10 text-center border border-dashed border-slate-200 rounded-xl">
              <Clock className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">Nenhum bloco padrão definido</p>
              <p className="text-xs text-slate-500 mt-1">
                Use o gerador acima para criar blocos de 50 minutos ou adicione manualmente.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
              {blocosPadrao.map((blk) => (
                <div
                  key={blk.id}
                  className={cn(
                    'px-4 py-3 flex items-center justify-between gap-4 transition-colors',
                    blk.ativo ? 'bg-white' : 'bg-slate-50 opacity-60'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 truncate">
                        {blk.label}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">·</span>
                      <span className="text-xs font-mono tabular-nums font-semibold text-fatec-red">
                        {blk.inicio} – {blk.fim}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleBlockActive(blk.id)}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap',
                        blk.ativo
                          ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                          : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                      )}
                    >
                      {blk.ativo ? 'Na Grade Base' : 'Oculto'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveBlock(blk.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                      title="Remover bloco"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </form>

      {/* SEÇÃO DE EXCEÇÕES DE HORÁRIOS PARA DIAS ESPECÍFICOS */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Exceções de Horários para Datas Específicas
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Crie regras pontuais para eventos acadêmicos, sábados letivos, semanas de tecnologia ou fechamentos extraordinários.
            </p>
          </div>
          <button
            type="button"
            onClick={openNewExceptionModal}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Nova Exceção de Data
          </button>
        </div>

        {exceptions.length === 0 ? (
          <div className="p-12 text-center">
            <Calendar className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-800">
              Nenhuma exceção de calendário cadastrada
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Todos os dias seguem atualmente a janela operacional padrão ({config.janelaInicio} às{' '}
              {config.janelaFim}). Adicione uma exceção para abrir janelas especiais ou fechar datas.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="px-6 py-3.5">Data</th>
                  <th className="px-6 py-3.5">Evento / Regra</th>
                  <th className="px-6 py-3.5">Escopo</th>
                  <th className="px-6 py-3.5">Regime de Horário</th>
                  <th className="px-6 py-3.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {exceptions.map((ex) => (
                  <tr key={ex.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-6 py-3.5 font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                      {formatDataBR(ex.data)}
                    </td>
                    <td className="px-6 py-3.5">
                      <p className="font-semibold text-slate-900">{ex.titulo}</p>
                      {ex.motivo && <p className="text-xs text-slate-500 mt-0.5">{ex.motivo}</p>}
                    </td>
                    <td className="px-6 py-3.5 text-xs text-slate-600">
                      {ex.salaNome || 'Todos os Ambientes'}
                    </td>
                    <td className="px-6 py-3.5">
                      {ex.fechado ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
                          <XCircle className="h-3.5 w-3.5" />
                          Fechado / Bloqueado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-mono tabular-nums font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Janela Especial: {ex.janelaInicio} às {ex.janelaFim}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-right whitespace-nowrap">
                      {deletingExId === ex.id ? (
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              await deleteException(ex.id, ex.titulo);
                              setDeletingExId(null);
                              toast.success('Exceção removida.');
                            }}
                            className="px-2.5 py-1 bg-red-600 text-white rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingExId(null)}
                            className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditExceptionModal(ex)}
                            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            title="Editar exceção"
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingExId(ex.id)}
                            className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                            title="Excluir exceção"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL: NOVO BLOCO MANUAL */}
      <AnimatePresence>
        {isBlockModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-bloco-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsBlockModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6 space-y-5"
            >
              <div className="flex items-center justify-between">
                <h4 id="modal-bloco-title" className="text-base font-bold text-slate-900">
                  Adicionar Bloco na Grade Base
                </h4>
                <button
                  type="button"
                  onClick={() => setIsBlockModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleAddSingleBlock} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Identificação do Bloco
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: 1ª Aula Noturna (50 min)"
                    value={newBlockLabel}
                    onChange={(e) => setNewBlockLabel(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">Início</label>
                    <input
                      type="time"
                      value={newBlockStart}
                      onChange={(e) => setNewBlockStart(e.target.value)}
                      required
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">Término</label>
                    <input
                      type="time"
                      value={newBlockEnd}
                      onChange={(e) => setNewBlockEnd(e.target.value)}
                      required
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsBlockModalOpen(false)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white rounded-xl cursor-pointer"
                  >
                    Incluir na Lista
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: NOVA / EDITAR EXCEÇÃO DE DATA */}
      <AnimatePresence>
        {isExceptionModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-excecao-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsExceptionModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h4 id="modal-excecao-title" className="text-base font-bold text-slate-900">
                  {editingException ? 'Editar Exceção de Horário' : 'Nova Exceção de Data Específica'}
                </h4>
                <button
                  type="button"
                  onClick={() => setIsExceptionModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSaveException} className="p-6 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Data Específica
                    </label>
                    <input
                      type="date"
                      value={exData}
                      onChange={(e) => setExData(e.target.value)}
                      required
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 block">
                      Ambiente Aplicável
                    </label>
                    <select
                      value={exSalaId}
                      onChange={(e) => setExSalaId(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                    >
                      <option value="TODAS">Todos os Ambientes da Unidade</option>
                      {rooms.map((r) => (
                        <option key={r.firestoreId} value={r.firestoreId}>
                          {r.id} — {r.nome}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Título do Evento / Exceção
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: Semana de Tecnologia Fatec / Recesso Acadêmico"
                    value={exTitulo}
                    onChange={(e) => setExTitulo(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Comportamento nesta Data
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setExFechado(false)}
                      className={cn(
                        'py-2.5 px-3 rounded-xl border text-xs font-semibold transition-colors cursor-pointer',
                        !exFechado
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      )}
                    >
                      Liberar Janela Especial
                    </button>
                    <button
                      type="button"
                      onClick={() => setExFechado(true)}
                      className={cn(
                        'py-2.5 px-3 rounded-xl border text-xs font-semibold transition-colors cursor-pointer',
                        exFechado
                          ? 'bg-red-50 border-red-300 text-red-900'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      )}
                    >
                      Bloquear / Fechar Dia
                    </button>
                  </div>
                </div>

                {!exFechado && (
                  <div className="grid grid-cols-2 gap-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-700 block">
                        Abertura Especial
                      </label>
                      <input
                        type="time"
                        value={exJanelaInicio}
                        onChange={(e) => setExJanelaInicio(e.target.value)}
                        required={!exFechado}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-700 block">
                        Encerramento Especial
                      </label>
                      <input
                        type="time"
                        value={exJanelaFim}
                        onChange={(e) => setExJanelaFim(e.target.value)}
                        required={!exFechado}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono tabular-nums font-semibold outline-none focus:ring-2 focus:ring-fatec-red"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Observação Institucional (Opcional)
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Justificativa exibida aos alunos no momento da consulta..."
                    value={exMotivo}
                    onChange={(e) => setExMotivo(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 resize-none outline-none focus:ring-2 focus:ring-fatec-red"
                  />
                </div>

                <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setIsExceptionModalOpen(false)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2.5 text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white rounded-xl cursor-pointer"
                  >
                    {editingException ? 'Salvar Exceção' : 'Registrar Exceção'}
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
