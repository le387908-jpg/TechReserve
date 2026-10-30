/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { 
  GraduationCap, 
  Calendar, 
  Building2, 
  Search, 
  Layers, 
  Clock, 
  Sparkles,
  Filter,
  Check
} from 'lucide-react';
import { CalendarCourse, DayOfWeek, Room } from '../../../types';
import { cn } from '../../../lib/utils';

export type CalendarViewMode = 'MES' | 'SEMANA' | 'DIA';

interface CalendarFiltersProps {
  isAdmin: boolean;
  selectedCourse: CalendarCourse;
  onSelectCourse: (curso: CalendarCourse) => void;
  selectedSemester: number;
  onSelectSemester: (semestre: number) => void;
  selectedDay: DayOfWeek | 'TODOS';
  onSelectDay: (dia: DayOfWeek | 'TODOS') => void;
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
  selectedRoomId: string; // 'TODAS' or room firestoreId / id / name
  onSelectRoomId: (id: string) => void;
  rooms: Room[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedDate: string; // YYYY-MM-DD
  onDateChange: (date: string) => void;
  showOnlyReservations: boolean;
  onToggleOnlyReservations: (val: boolean) => void;
  onEditEnrollment?: () => void;
}

const COURSES: { id: CalendarCourse; label: string; sigla: string; desc: string }[] = [
  { id: 'GTI', label: 'Gestão da Tecnologia da Informação', sigla: 'GTI', desc: 'Sistemas, Governança & TI' },
  { id: 'GEEE', label: 'Gestão de Energia e Eficiência Energética', sigla: 'GEEE', desc: 'Smart Grids, Sustentabilidade & Automação' },
];

const SEMESTERS = [1, 2, 3, 4, 5, 6];

const DAYS: { id: DayOfWeek | 'TODOS'; label: string }[] = [
  { id: 'TODOS', label: 'Semana Inteira' },
  { id: 'Segunda', label: 'Segunda' },
  { id: 'Terça', label: 'Terça' },
  { id: 'Quarta', label: 'Quarta' },
  { id: 'Quinta', label: 'Quinta' },
  { id: 'Sexta', label: 'Sexta' },
  { id: 'Sábado', label: 'Sábado' },
];

export function CalendarFilters({
  isAdmin,
  selectedCourse,
  onSelectCourse,
  selectedSemester,
  onSelectSemester,
  selectedDay,
  onSelectDay,
  viewMode,
  onViewModeChange,
  selectedRoomId,
  onSelectRoomId,
  rooms,
  searchQuery,
  onSearchChange,
  selectedDate,
  onDateChange,
  showOnlyReservations,
  onToggleOnlyReservations,
  onEditEnrollment,
}: CalendarFiltersProps) {
  const currentCourseObj = COURSES.find(c => c.id === selectedCourse);

  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-5 md:p-6 shadow-sm space-y-6">
      {/* 1. SELEÇÃO DE CURSO / BANNER DO ALUNO E MODO DE VISUALIZAÇÃO */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-fatec-red" />
              {isAdmin ? '1. Seleção de Curso (Visão ADM):' : 'Minha Turma Matriculada:'}
            </label>
            {isAdmin && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 uppercase tracking-wider">
                Controle ADM
              </span>
            )}
          </div>

          {/* VIEW MODE TABS: MÊS (CALENDÁRIO NORMAL) / SEMANA / DIA */}
          <div className="flex items-center bg-slate-100 p-1 rounded-2xl self-start sm:self-auto border border-slate-200/80">
            <button
              type="button"
              onClick={() => onViewModeChange('MES')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                viewMode === 'MES'
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              )}
            >
              <Calendar className="h-3.5 w-3.5 text-fatec-red" />
              <span>Calendário Normal (Mês)</span>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('SEMANA')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                viewMode === 'SEMANA'
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              )}
            >
              <Layers className="h-3.5 w-3.5 text-slate-500" />
              <span>Grade Semanal</span>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('DIA')}
              className={cn(
                "px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1.5",
                viewMode === 'DIA'
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              )}
            >
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              <span>Dia</span>
            </button>
          </div>
        </div>

        {isAdmin ? (
          /* ADMIN ONLY: COURSE SELECTION */
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {COURSES.map((course) => {
              const isSelected = selectedCourse === course.id;
              return (
                <button
                  key={course.id}
                  type="button"
                  onClick={() => onSelectCourse(course.id)}
                  className={cn(
                    "p-3.5 rounded-2xl border text-left transition-all duration-200 flex flex-col justify-between relative overflow-hidden group",
                    isSelected
                      ? "bg-slate-900 border-slate-900 text-white shadow-md shadow-slate-900/10 ring-2 ring-fatec-red/50"
                      : "bg-slate-50 border-slate-200 hover:bg-slate-100 hover:border-slate-300 text-slate-800"
                  )}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <span className={cn(
                      "text-xs font-black px-2 py-0.5 rounded-lg uppercase tracking-wider",
                      isSelected ? "bg-fatec-red text-white" : "bg-slate-200 text-slate-700 group-hover:bg-slate-300"
                    )}>
                      {course.sigla}
                    </span>
                    {isSelected && <Check className="h-4 w-4 text-emerald-400" />}
                  </div>
                  <div>
                    <h4 className={cn("text-sm font-bold leading-tight line-clamp-1", isSelected ? "text-white" : "text-slate-900")}>
                      {course.label}
                    </h4>
                    <p className={cn("text-[11px] mt-0.5 line-clamp-1", isSelected ? "text-slate-300" : "text-slate-500")}>
                      {course.desc}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          /* REGULAR USER: FOCUSED ENROLLED CLASS CARD (NO SELECTION BUTTONS) */
          <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 text-white p-4.5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 shadow-sm border border-slate-800">
            <div className="flex items-center gap-3.5">
              <div className="h-12 w-12 rounded-2xl bg-fatec-red text-white flex items-center justify-center shrink-0 shadow-lg shadow-red-500/20">
                <GraduationCap className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wider bg-fatec-red text-white px-2 py-0.5 rounded-md">
                    {currentCourseObj?.sigla || selectedCourse}
                  </span>
                  <span className="text-xs text-slate-300 font-semibold">
                    {selectedSemester}º Semestre • Fatec Franco da Rocha
                  </span>
                </div>
                <h3 className="text-base font-black text-white mt-1">
                  {currentCourseObj?.label || selectedCourse}
                </h3>
                <p className="text-[11px] text-slate-400">
                  Exibindo o calendário e a grade horária exclusiva da sua matrícula de estudante.
                </p>
              </div>
            </div>

            {onEditEnrollment && (
              <button
                type="button"
                onClick={onEditEnrollment}
                className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-bold transition-all self-start sm:self-auto flex items-center gap-1.5 active:scale-95"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                <span>Alterar Turma</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 2. SELEÇÃO DE SEMESTRE (ADMIN ONLY) & DIA DA SEMANA */}
      <div className={cn(
        "grid grid-cols-1 gap-5 pt-2 border-t border-slate-100",
        isAdmin ? "lg:grid-cols-12" : "lg:grid-cols-1"
      )}>
        {isAdmin && (
          /* SEMESTRE (1º ao 6º) - ADMIN ONLY */
          <div className="lg:col-span-5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-2">
                <Layers className="h-4 w-4 text-slate-500" />
                2. Semestre (Painel ADM):
              </label>
              <span className="text-[10px] font-bold text-slate-400">
                1º ao 6º Semestre
              </span>
            </div>
            <div className="grid grid-cols-6 gap-1.5 p-1 bg-slate-100 rounded-2xl">
              {SEMESTERS.map((sem) => {
                const isSelected = selectedSemester === sem;
                return (
                  <button
                    key={sem}
                    type="button"
                    onClick={() => onSelectSemester(sem)}
                    className={cn(
                      "py-2 rounded-xl text-xs font-black transition-all flex flex-col items-center justify-center",
                      isSelected
                        ? "bg-white text-slate-900 shadow-sm border border-slate-200/80 scale-[1.02]"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                    )}
                  >
                    <span>{sem}º</span>
                    <span className="text-[9px] font-normal text-slate-400 uppercase hidden sm:inline">sem</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* DIA DA SEMANA */}
        <div className={cn(
          "space-y-2",
          isAdmin ? "lg:col-span-7" : "w-full"
        )}>
          <label className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-slate-500" />
            {isAdmin ? '3. Dia da Semana:' : 'Dia da Semana:'}
          </label>
          <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100 rounded-2xl">
            {DAYS.map((day) => {
              const isSelected = selectedDay === day.id;
              return (
                <button
                  key={day.id}
                  type="button"
                  onClick={() => onSelectDay(day.id)}
                  className={cn(
                    "flex-1 min-w-[70px] py-2 px-2 text-center rounded-xl text-xs font-black transition-all whitespace-nowrap",
                    isSelected
                      ? "bg-fatec-red text-white shadow-sm shadow-red-500/20 scale-[1.02]"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                  )}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 3. FILTROS AVANÇADOS: SALA, BUSCA & DATA */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
        {/* FILTRO DE SALA ESPECÍFICA (Solicitado para ADM e Usuário) */}
        <div>
          <label className="text-[11px] font-black uppercase tracking-wider text-slate-500 block mb-1.5 flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 text-slate-400" />
            Filtrar por Sala:
          </label>
          <select
            value={selectedRoomId}
            onChange={(e) => onSelectRoomId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red focus:border-transparent transition-all"
          >
            <option value="TODAS">Todas as Salas e Laboratórios</option>
            {rooms.map((room) => (
              <option key={room.firestoreId} value={room.nome}>
                {room.id ? `${room.id} - ` : ''}{room.nome}
              </option>
            ))}
          </select>
        </div>

        {/* DATA DE REFERÊNCIA PARA RESERVAS */}
        <div>
          <label className="text-[11px] font-black uppercase tracking-wider text-slate-500 block mb-1.5 flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-slate-400" />
            Data de Referência:
          </label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-fatec-red focus:border-transparent transition-all"
          />
        </div>

        {/* BUSCA POR MATÉRIA OU PROFESSOR */}
        <div>
          <label className="text-[11px] font-black uppercase tracking-wider text-slate-500 block mb-1.5 flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            Buscar Matéria / Professor:
          </label>
          <div className="relative">
            <input
              type="text"
              placeholder="Ex: Prog_Internet, Raphael..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-xs font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-fatec-red focus:border-transparent transition-all"
            />
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* TOGGLE: APENAS RESERVAS ATIVAS */}
        <div className="flex flex-col justify-end">
          <button
            type="button"
            onClick={() => onToggleOnlyReservations(!showOnlyReservations)}
            className={cn(
              "w-full py-2 px-3 rounded-xl border text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap",
              showOnlyReservations
                ? "bg-rose-50 border-rose-300 text-fatec-red shadow-sm"
                : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
            )}
          >
            <Filter className={cn("h-3.5 w-3.5 shrink-0", showOnlyReservations ? "text-fatec-red" : "text-slate-400")} />
            {showOnlyReservations ? 'Ver Apenas Reservas' : 'Todas as Ocorrências'}
          </button>
        </div>
      </div>
    </div>
  );
}
