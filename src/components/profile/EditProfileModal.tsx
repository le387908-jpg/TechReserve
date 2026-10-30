/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  X,
  User as UserIcon,
  Phone,
  Hash,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Send,
  Layers,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useAuthStore } from '../../store/useAuthStore';
import {
  formatPhone,
  getPhoneValidationMessage,
  sanitizePhone,
  validatePhone,
} from '../../utils/formatters';
import { sendTestWhatsAppAlert } from '../../services/whatsappService';
import { cn } from '../../lib/utils';

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal de Edição Rápida de Perfil e Preferências de Alerta WhatsApp.
 * Permite atualizar Nome, RA, Telefone/WhatsApp (com máscara e validação)
 * e chave de notificações diretamente de qualquer tela do TechReserve.
 */
export function EditProfileModal({ isOpen, onClose }: EditProfileModalProps) {
  const { user, updateProfile } = useAuthStore();

  const [nome, setNome] = useState('');
  const [phone, setPhone] = useState('');
  const [ra, setRa] = useState('');
  const [semestre, setSemestre] = useState<number>(1);
  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingAlert, setTestingAlert] = useState(false);

  useEffect(() => {
    if (isOpen && user) {
      setNome(user.nome || '');
      setPhone(formatPhone(user.phone || user.phoneFormatted || ''));
      setRa(user.ra || '');
      setSemestre(user.semestre || 1);
      setWhatsappEnabled(user.whatsappNotificationsEnabled !== false);
    }
  }, [isOpen, user]);

  if (!user) return null;

  const isAdmin = user.role === 'ADMIN';
  const isPhoneValid = validatePhone(phone);
  const sanitizedPhone = sanitizePhone(phone);
  const formattedPhone = formatPhone(sanitizedPhone);
  const phoneErrorMessage = getPhoneValidationMessage(phone);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isPhoneValid) {
      toast.error(
        phoneErrorMessage ||
          'Informe um número de telefone válido com 11 dígitos no formato (00) 00000-0000.'
      );
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        nome: nome.trim(),
        phone: sanitizedPhone,
        phoneFormatted: formattedPhone,
        whatsappNotificationsEnabled: whatsappEnabled,
        ra: ra.trim(),
        ...(!isAdmin && user.tipoVinculo !== 'SERVIDOR' ? { semestre } : {}),
      });
      toast.success('Perfil e preferências de WhatsApp atualizados com sucesso.');
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Não foi possível atualizar seu perfil.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    if (!isPhoneValid) {
      toast.error(
        phoneErrorMessage || 'Informe um número de WhatsApp válido de 11 dígitos antes de testar.'
      );
      return;
    }
    if (!whatsappEnabled) {
      toast.error('Ative a chave de alertas via WhatsApp para testar o envio.');
      return;
    }

    setTestingAlert(true);
    try {
      await updateProfile({
        phone: sanitizedPhone,
        phoneFormatted: formattedPhone,
        whatsappNotificationsEnabled: true,
      });

      const res = await sendTestWhatsAppAlert({
        id: user.id,
        nome: nome.trim() || user.nome,
        phone: sanitizedPhone,
        whatsappNotificationsEnabled: true,
      });

      if (res.delivered) {
        toast.success(`Alerta de teste entregue no WhatsApp ${formattedPhone}!`);
      } else if (res.success) {
        toast.success(
          `Alerta validado e registrado para ${formattedPhone} (modo homologação).`
        );
      } else {
        console.error('[Perfil][Teste WhatsApp] Falha no disparo:', res);
        toast.error(
          res.reason || 'Falha ao disparar teste de WhatsApp via Evolution API.'
        );
      }
    } catch (err: any) {
      console.error('[Perfil][Teste WhatsApp] Exceção:', err);
      toast.error(err?.message || 'Erro ao validar alerta de WhatsApp.');
    } finally {
      setTestingAlert(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-profile-modal-title"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 id="edit-profile-modal-title" className="text-base font-bold text-slate-900">
                  Editar Perfil e Alertas WhatsApp
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                aria-label="Fechar modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700">Nome Completo</label>
                  <div className="relative">
                    <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      required
                      value={nome}
                      onChange={(e) => setNome(e.target.value)}
                      className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-medium text-slate-900"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700">RA / Matrícula</label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      maxLength={32}
                      value={ra}
                      onChange={(e) => setRa(e.target.value)}
                      placeholder="Ex: 1090482411001"
                      className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums text-slate-900"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">
                    Número de Telefone / WhatsApp
                  </label>
                  {phone && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[11px] font-medium',
                        isPhoneValid ? 'text-emerald-700' : 'text-fatec-red'
                      )}
                    >
                      {isPhoneValid ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          11 dígitos válidos
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-3.5 w-3.5" />
                          Exige 11 dígitos
                        </>
                      )}
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="tel"
                      inputMode="numeric"
                      required
                      maxLength={15}
                      value={phone}
                      onChange={(e) => setPhone(formatPhone(e.target.value))}
                      placeholder="(00) 00000-0000"
                      className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums text-slate-900"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleSendTest}
                    disabled={testingAlert || !isPhoneValid || !whatsappEnabled}
                    className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
                  >
                    {testingAlert ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5 text-emerald-600" />
                    )}
                    Testar Alerta
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <MessageSquare className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-slate-900">
                      Receber alertas e lembretes de reserva via WhatsApp
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                      Inclui confirmação, cancelamento, lembrete prévio, aviso faltando 10 min para desocupação e alerta de No-Show.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={whatsappEnabled}
                  onClick={() => setWhatsappEnabled((prev) => !prev)}
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-150 cursor-pointer',
                    whatsappEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 rounded-full bg-white shadow-xs transform transition-transform duration-150 mt-0.5',
                      whatsappEnabled ? 'translate-x-5.5' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </div>

              {!isAdmin && user.tipoVinculo !== 'SERVIDOR' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-fatec-red" />
                    Semestre Atual ({user.curso || 'GTI'})
                  </label>
                  <div className="grid grid-cols-6 gap-1.5 p-1 bg-slate-50 border border-slate-200 rounded-xl">
                    {[1, 2, 3, 4, 5, 6].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSemestre(s)}
                        className={cn(
                          'py-2 rounded-lg text-xs font-bold font-mono tabular-nums transition-colors cursor-pointer',
                          semestre === s
                            ? 'bg-fatec-red text-white'
                            : 'text-slate-600 hover:bg-slate-200/60'
                        )}
                      >
                        {s}º
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar Perfil'}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
