/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useScheduleStore, buildTimeBlocks } from '../../../store/useScheduleStore';
import { useRoomStore } from '../../../store/useRoomStore';
import { DayOfWeek, ScheduleException, TimeBlock } from '../../../types';
import { formatDataBR, getTodayLocalISO } from '../../../utils/dateUtils';
import { cn } from '../../../lib/utils';

const ALL_WEEK_DAYS: DayOfWeek[] = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/**
 * Aba 1 — Abertura e Controle Centralizado de Horários
 * Permite ao Administrador configurar janelas operacionais, blocos padrão (ex: aulas de 50 min)
 * e exceções de horários para datas/ambientes específicos com persistência em `schedules`.
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
    toast.success(`${generated.length} blocos padrão de ${duracaoBloco} minutos gerados. Clique em Salvar Regras para publicar.`);
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
      toast.success('Janelas operacionais e blocos de horários atualizados em tempo real.');
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
          ? 'Portal de agendamentos liberado para estudantes e servidores.'
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
              Janela ativa: {config.janelaInicio} às {config.janelaFim}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Abertura diária às {String(config.horaAberturaSistema).padStart(2, '0')}:00
            </span>
          </div>
          <h3 className="text-lg font-bold text-slate-900">
            {reservasAbertas
              ? 'Ambientes pedagógicos liberados para reserva dentro das janelas operacionais'
              : 'Agendamentos suspensos globalmente pela Coordenação'}
          </h3>
          <p className="text-sm text-slate-500 max-w-2xl">
            Alterações salvas nesta tela entram em vigor instantaneamente no Mapa de Salas e no Calendário Institucional.
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

      {/* GRID PRINCIPAL: JANELAS OPERACIONAIS + BLOCOS PADRÃO */}
      <form onSubmit={handleSaveGlobalRules} className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* COLUNA ESQUERDA: PARÂMETROS DA JANELA */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">Janelas Operacionais Padrão</h3>
            <p className="text-xs text-slate-500 mt-1">
              Defina os horários em que salas, laboratórios e auditórios aceitam reservas regulares.
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
              {isSavingGlobal ? 'Salvando configurações...' : 'Salvar Regras e Blocos Padrão'}
            </button>
          </div>
        </div>

        {/* COLUNA DIREITA: GERADOR E GESTÃO DE BLOCOS PADRÃO (EX: AULAS DE 50 MIN) */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Blocos Padrão de Horários Pedagógicos
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Configure blocos padrão (ex: aulas de 50 minutos) oferecidos como seleção rápida na reserva.
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
                          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                      )}
                    >
                      {blk.ativo ? 'Liberado' : 'Inativo'}
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
              {config.janelaFim}). Adicione uma exceção para abrir horários especiais ou bloquear datas.
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
                          Liberado: {ex.janelaInicio} às {ex.janelaFim}
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
                  Adicionar Bloco de Horário
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
