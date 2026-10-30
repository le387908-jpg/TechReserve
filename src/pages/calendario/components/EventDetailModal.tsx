/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  X, 
  Clock, 
  Building2, 
  MapPin, 
  GraduationCap, 
  User, 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Calendar,
  Layers,
  Sparkles,
  Trash2,
  PlusCircle,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { CalendarEvent, Room, User as UserType } from '../../../types';
import { getFriendlyErrorMessage } from '../../../services/firebase/utils';
import { cn } from '../../../lib/utils';
import { toast } from 'sonner';

interface EventDetailModalProps {
  event: CalendarEvent | null;
  onClose: () => void;
  currentUser: UserType | null;
  roomDetails?: Room | null;
  onApproveReservation?: (reservationId: string) => Promise<void>;
  onCancelReservation?: (reservationId: string) => Promise<void>;
  onDeleteReservation?: (reservationId: string) => Promise<void>;
  onRequestRoomBooking?: (roomName: string, preferredTime?: string) => void;
}

export function EventDetailModal({
  event,
  onClose,
  currentUser,
  roomDetails,
  onApproveReservation,
  onCancelReservation,
  onDeleteReservation,
  onRequestRoomBooking,
}: EventDetailModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'delete' | null>(null);

  if (!event) return null;

  const isGrade = event.tipo === 'AULA_GRADE';
  const isReserva = event.tipo === 'RESERVA_USUARIO';
  const isAdmin = currentUser?.role === 'ADMIN';
  const isOwner = currentUser && event.usuarioId === currentUser.id;
  const canUserBookRoom =
    isAdmin ||
    !roomDetails ||
    (roomDetails.liberadaParaReserva !== false &&
      roomDetails.status !== 'MANUTENCAO' &&
      roomDetails.status !== 'INATIVO' &&
      roomDetails.statusManual !== 'MANUTENCAO');

  const handleApprove = async () => {
    if (!event?.reservationId || !onApproveReservation) return;
    setIsProcessing(true);
    try {
      await onApproveReservation(event.reservationId);
      toast.success('Reserva aprovada com sucesso!');
      onClose();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao aprovar reserva.'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = async () => {
    if (!event?.reservationId || !onCancelReservation) return;
    setIsProcessing(true);
    try {
      await onCancelReservation(event.reservationId);
      toast.success('Reserva cancelada. Cota semanal atualizada.');
      setConfirmAction(null);
      onClose();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao cancelar reserva.'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDelete = async () => {
    if (!event?.reservationId || !onDeleteReservation) return;
    setIsProcessing(true);
    try {
      await onDeleteReservation(event.reservationId);
      toast.success('Registro excluído com sucesso.');
      setConfirmAction(null);
      onClose();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao excluir registro.'));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.2 }}
          className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden relative"
        >
          {/* TOP ACCENT HEADER */}
          <div className={cn(
            "p-6 pb-5 relative text-white",
            isGrade ? "bg-blue-600" : isOwner ? "bg-emerald-600" : "bg-fatec-red"
          )}>
            <button
              onClick={onClose}
              className="absolute right-4 top-4 p-2 rounded-full bg-black/20 hover:bg-black/30 text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 mb-2">
              <span className={cn(
                "px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider",
                isGrade
                  ? "bg-blue-900/75 text-blue-50"
                  : isOwner
                  ? "bg-emerald-900/75 text-emerald-50"
                  : "bg-red-900/80 text-red-100"
              )}>
                {isGrade
                  ? 'Ocupado · Aula Regular'
                  : isOwner
                  ? 'Sua Reserva'
                  : 'Reservado'}
              </span>
              {event.status && (
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-white/20 text-white uppercase">
                  Status: {event.status}
                </span>
              )}
            </div>

            <h3 className="text-xl font-black tracking-tight text-white leading-tight">
              {event.materia}
            </h3>

            <p className="text-xs text-white/80 mt-1 flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5" />
              <span>{event.diaSemana}</span>
              {event.data && <span className="tabular-nums">· Data: {event.data}</span>}
              <span>·</span>
              <Clock className="h-3.5 w-3.5" />
              <span className="font-mono tabular-nums font-bold">{event.horarioInicio} às {event.horarioFim}</span>
            </p>
          </div>

          {/* BODY DETAILS */}
          <div className="p-6 space-y-5">
            {/* GRID OF ATTRIBUTES */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {/* SALA */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1 flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Espaço Físico / Sala
                </span>
                <p className="text-sm font-bold text-slate-900 leading-snug">
                  {event.sala}
                </p>
                {roomDetails && (
                  <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
                    {roomDetails.andar} · Capacidade: {roomDetails.capacidade} alunos
                  </p>
                )}
              </div>

              {/* PROFESSOR OU SOLICITANTE */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1 flex items-center gap-1">
                  {isGrade ? <GraduationCap className="h-3 w-3" /> : <User className="h-3 w-3" />}
                  {isGrade ? 'Professor Responsável' : 'Solicitante da Reserva'}
                </span>
                <p className="text-sm font-bold text-slate-900 leading-snug">
                  {isGrade ? (event.professor || 'Docente Fatec') : (event.solicitante || 'Usuário TechReserve')}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  {isGrade ? 'Corpo Docente Institucional' : 'Usuário Autenticado'}
                </p>
              </div>

              {/* CURSO */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1 flex items-center gap-1">
                  <Layers className="h-3 w-3" />
                  Curso
                </span>
                <p className="text-sm font-bold text-slate-900">
                  {event.curso}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Fatec Franco da Rocha
                </p>
              </div>

              {/* SEMESTRE */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1 flex items-center gap-1">
                  <BookOpen className="h-3 w-3" />
                  Semestre
                </span>
                <p className="text-sm font-bold text-slate-900">
                  {event.semestre}º Semestre
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Turma Regular
                </p>
              </div>
            </div>

            {/* OBSERVAÇÕES ADICIONAIS OU RECURSOS DA SALA */}
            {event.observacoes && (
              <div className="bg-amber-50/70 border border-amber-200/80 rounded-2xl p-3.5 text-xs text-amber-900">
                <p className="font-bold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  Observações da Reserva:
                </p>
                <p>{event.observacoes}</p>
              </div>
            )}

            {/* SE FOR AULA DA GRADE: MOSTRA RECURSOS DA SALA */}
            {isGrade && Array.isArray(roomDetails?.equipamentos) && roomDetails.equipamentos.length > 0 && (
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-2">
                  Recursos & Equipamentos Disponíveis:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {roomDetails.equipamentos.map((eq, idx) => (
                    <span key={idx} className="bg-white border border-slate-200 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-700 shadow-2xs">
                      {eq}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* FOOTER ACTIONS ACCORDING TO ROLE & EVENT TYPE */}
            <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2 justify-end items-center">
              {confirmAction ? (
                <div className="w-full flex items-center justify-between gap-2 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5 text-xs">
                  <span className="font-semibold text-rose-950">
                    {confirmAction === 'cancel'
                      ? 'Confirmar cancelamento desta reserva?'
                      : 'Excluir registro permanentemente?'}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={confirmAction === 'cancel' ? handleCancel : handleDelete}
                      className="px-3 py-1.5 rounded-lg bg-fatec-red text-white font-semibold cursor-pointer"
                    >
                      {isProcessing ? 'Processando...' : 'Confirmar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAction(null)}
                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 font-semibold cursor-pointer"
                    >
                      Voltar
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Regular curriculum class occupancy indicator for standard users; quick override only for ADM */}
                  {isGrade && !isAdmin && (
                    <span className="text-xs font-medium text-slate-500 mr-auto">
                      Horário ocupado pela grade curricular regular
                    </span>
                  )}
                  {isGrade && isAdmin && onRequestRoomBooking && canUserBookRoom && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onRequestRoomBooking(event.sala, event.horarioInicio);
                      }}
                      className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-colors flex items-center gap-2 cursor-pointer"
                    >
                      <PlusCircle className="h-4 w-4" />
                      Solicitar Reserva neste Espaço
                    </button>
                  )}

                  {/* ADM Actions for Reservations */}
                  {isReserva && isAdmin && (
                    <>
                      {event.status === 'Pendente' && onApproveReservation && (
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={handleApprove}
                          className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          {isProcessing ? 'Aprovando...' : 'Aprovar Reserva'}
                        </button>
                      )}
                      {onCancelReservation && (
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setConfirmAction('cancel')}
                          className="px-4 py-2.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-fatec-red border border-rose-200 text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <XCircle className="h-4 w-4" />
                          Cancelar Reserva
                        </button>
                      )}
                      {onDeleteReservation && (
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setConfirmAction('delete')}
                          className="p-2.5 rounded-xl text-slate-400 hover:text-fatec-red hover:bg-slate-100 transition-colors cursor-pointer"
                          title="Excluir Registro"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </>
                  )}

                  {/* Regular user owning the reservation */}
                  {isReserva && !isAdmin && isOwner && onCancelReservation && (
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => setConfirmAction('cancel')}
                      className="px-4 py-2.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-fatec-red border border-rose-200 text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <XCircle className="h-4 w-4" />
                      Cancelar Minha Reserva
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
                  >
                    Fechar
                  </button>
                </>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
