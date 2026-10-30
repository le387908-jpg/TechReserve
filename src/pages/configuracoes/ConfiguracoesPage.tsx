/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User as UserIcon,
  Camera,
  Loader2,
  Calendar,
  GraduationCap,
  Layers,
  Lock,
  ShieldCheck,
  Hash,
  UserX,
  AlertTriangle,
  X,
  Phone,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  Send,
  Edit3,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useAuthStore } from '../../store/useAuthStore';
import { UserVinculo } from '../../types';
import { cn } from '../../lib/utils';
import { getTodayLocalISO, normalizeDateToISO } from '../../utils/dateUtils';
import { formatNoShowTag } from '../../services/reservationService';
import {
  formatPhone,
  getPhoneValidationMessage,
  sanitizePhone,
  validatePhone,
} from '../../utils/formatters';
import { sendTestWhatsAppAlert } from '../../services/whatsappService';
import { getFriendlyErrorMessage } from '../../services/firebase/utils';
import { EditProfileModal } from '../../components/profile/EditProfileModal';
import { WhatsAppGatewayCard } from '../../components/admin/WhatsAppGatewayCard';
import { ErrorBoundary } from '../../components/ErrorBoundary';

const COURSES_DICT: Record<string, { sigla: string; nome: string }> = {
  GTI: { sigla: 'GTI', nome: 'Gestão da Tecnologia da Informação' },
  GEEE: { sigla: 'GEEE', nome: 'Gestão de Energia e Eficiência Energética' },
};

export function ConfiguracoesPage() {
  const navigate = useNavigate();
  const { user, updateProfile, deactivateMyProfile } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [testingWhatsApp, setTestingWhatsApp] = useState(false);
  const [togglingWhatsApp, setTogglingWhatsApp] = useState(false);

  const [nome, setNome] = useState(user?.nome || '');
  const [phone, setPhone] = useState(() =>
    formatPhone(user?.phone || user?.phoneFormatted || '')
  );
  const [whatsappNotificationsEnabled, setWhatsappNotificationsEnabled] = useState<boolean>(
    user?.whatsappNotificationsEnabled !== false
  );
  const [ra, setRa] = useState(user?.ra || '');
  const [tipoVinculo, setTipoVinculo] = useState<UserVinculo>(user?.tipoVinculo || 'ALUNO');
  const [dataNascimento, setDataNascimento] = useState(
    normalizeDateToISO(user?.dataNascimento) || ''
  );
  const [semestre, setSemestre] = useState<number>(user?.semestre || 1);

  const [isQuickModalOpen, setIsQuickModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const isAdmin = user?.role === 'ADMIN';
  const userCourseKey = user?.curso || 'GTI';
  const userCourseInfo = COURSES_DICT[userCourseKey] || {
    sigla: userCourseKey,
    nome: userCourseKey,
  };

  React.useEffect(() => {
    if (user) {
      if (user.nome) setNome(user.nome);
      setPhone(formatPhone(user.phone || user.phoneFormatted || ''));
      setWhatsappNotificationsEnabled(user.whatsappNotificationsEnabled !== false);
      setRa(user.ra || '');
      if (user.tipoVinculo) setTipoVinculo(user.tipoVinculo);
      if (user.dataNascimento) setDataNascimento(normalizeDateToISO(user.dataNascimento));
      if (user.semestre) setSemestre(user.semestre);
    }
  }, [user]);

  const isPhoneValid = validatePhone(phone);
  const sanitizedPhone = sanitizePhone(phone);
  const formattedPhone = formatPhone(sanitizedPhone);
  const phoneErrorMessage = getPhoneValidationMessage(phone);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isPhoneValid) {
      toast.error(
        phoneErrorMessage ||
          'Informe um número de telefone válido com 11 dígitos no formato (00) 00000-0000.'
      );
      return;
    }

    setLoading(true);
    try {
      const cleanBirthdate = normalizeDateToISO(dataNascimento);
      if (isAdmin) {
        await updateProfile({
          nome: nome.trim(),
          phone: sanitizedPhone,
          phoneFormatted: formattedPhone,
          whatsappNotificationsEnabled,
          ra: ra.trim(),
          dataNascimento: cleanBirthdate,
        });
        toast.success('Perfil administrativo e WhatsApp atualizados com sucesso.');
      } else {
        await updateProfile({
          nome: nome.trim(),
          phone: sanitizedPhone,
          phoneFormatted: formattedPhone,
          whatsappNotificationsEnabled,
          ra: ra.trim(),
          tipoVinculo,
          dataNascimento: cleanBirthdate,
          semestre,
        });
        toast.success('Perfil acadêmico e preferências de WhatsApp atualizados.');
      }
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao atualizar configurações.'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggleWhatsAppPreference = async () => {
    const nextValue = !whatsappNotificationsEnabled;
    setWhatsappNotificationsEnabled(nextValue);

    // Se já houver um telefone válido de 11 dígitos salvo, persiste imediatamente a preferência no Firestore
    if (user?.phone && validatePhone(user.phone)) {
      setTogglingWhatsApp(true);
      try {
        await updateProfile({ whatsappNotificationsEnabled: nextValue });
        toast.success(
          nextValue
            ? 'Alertas e lembretes via WhatsApp ativados.'
            : 'Alertas via WhatsApp silenciados.'
        );
      } catch (err) {
        setWhatsappNotificationsEnabled(!nextValue);
        toast.error(
          getFriendlyErrorMessage(err, 'Não foi possível salvar a preferência de notificação.')
        );
      } finally {
        setTogglingWhatsApp(false);
      }
    }
  };

  const handleSendTestAlert = async () => {
    if (!user) return;
    if (!isPhoneValid) {
      toast.error(
        phoneErrorMessage || 'Informe um número de WhatsApp válido de 11 dígitos antes de testar.'
      );
      return;
    }
    if (!whatsappNotificationsEnabled) {
      toast.error('Ative o recebimento de alertas via WhatsApp antes de enviar um teste.');
      return;
    }

    setTestingWhatsApp(true);
    try {
      await updateProfile({
        phone: sanitizedPhone,
        phoneFormatted: formattedPhone,
        whatsappNotificationsEnabled: true,
      });

      const result = await sendTestWhatsAppAlert({
        id: user.id,
        nome: nome.trim() || user.nome,
        phone: sanitizedPhone,
        whatsappNotificationsEnabled: true,
      });

      if (result.delivered) {
        toast.success(`Mensagem de validação entregue no WhatsApp ${formattedPhone}!`);
      } else if (result.success) {
        toast.success(
          `Número ${formattedPhone} salvo e alerta processado (modo homologação).`
        );
      } else {
        console.error('[Configurações][Teste WhatsApp] Falha no disparo:', result);
        toast.error(
          result.reason || 'Falha ao enviar mensagem de teste via Evolution API. Verifique o console para detalhes.'
        );
      }
      } catch (err) {
      console.error('[Configurações][Teste WhatsApp] Exceção:', err);
      toast.error(getFriendlyErrorMessage(err, 'Erro ao validar alerta WhatsApp.'));
    } finally {
      setTestingWhatsApp(false);
    }
  };

  const handleConfirmDeactivate = async () => {
    setIsDeactivating(true);
    try {
      await deactivateMyProfile();
      toast.success('Seu perfil foi encerrado e marcado como inativo.');
      navigate('/login');
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Não foi possível excluir o perfil no momento.'));
    } finally {
      setIsDeactivating(false);
      setIsDeleteModalOpen(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Configurações</h2>
          <p className="text-slate-500 text-sm">
            {isAdmin
              ? 'Gerenciamento de perfil institucional e alertas operacionais via WhatsApp.'
              : 'Gerenciamento de dados pessoais, WhatsApp para alertas de reserva, RA e semestre.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsQuickModalOpen(true)}
          className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-auto"
        >
          <Edit3 className="h-4 w-4 text-fatec-red" />
          Edição Rápida em Modal
        </button>
      </div>

      {/* CARD PRINCIPAL DO PERFIL */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-900">
            {isAdmin ? 'Perfil do Coordenador Geral' : 'Meu Perfil Acadêmico'}
          </h3>
          <span className="text-xs font-semibold text-slate-500">
            {isAdmin
              ? 'Administrador / Coordenação'
              : tipoVinculo === 'SERVIDOR'
              ? 'Servidor / Docente'
              : 'Estudante Fatec'}
          </span>
        </div>

        <form onSubmit={handleUpdateProfile} className="p-6 space-y-6">
          <div className="flex flex-col items-center sm:flex-row gap-6">
            <div className="relative">
              <div className="h-20 w-20 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 overflow-hidden">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    className="h-full w-full object-cover"
                    alt={user.nome}
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <UserIcon className="h-9 w-9" />
                )}
              </div>
              <div className="absolute bottom-0 right-0 p-1.5 bg-fatec-red text-white rounded-full border-2 border-white">
                <Camera className="h-3 w-3" />
              </div>
            </div>
            <div className="flex-1 space-y-1 text-center sm:text-left">
              <h4 className="text-lg font-bold text-slate-900">{user?.nome}</h4>
              <p className="text-sm text-slate-500">{user?.email}</p>
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs text-slate-600 pt-1">
                {isAdmin ? (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                    <ShieldCheck className="h-4 w-4 text-fatec-red" />
                    Coordenação da Unidade · Acesso Global
                  </span>
                ) : (
                  <>
                    <span className="font-semibold text-fatec-red">{userCourseInfo.sigla}</span>
                    <span aria-hidden="true">·</span>
                    <span>{semestre}º Semestre</span>
                    {ra && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">RA {ra}</span>
                      </>
                    )}
                  </>
                )}
                {isPhoneValid && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-emerald-700 font-semibold">
                      WhatsApp {formattedPhone}
                    </span>
                  </>
                )}
              </div>
              {!isAdmin &&
                user?.blockedDate &&
                normalizeDateToISO(user.blockedDate) >= getTodayLocalISO() && (
                  <div className="pt-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 px-3 py-1.5 rounded-xl">
                      <AlertCircle className="h-3.5 w-3.5 text-fatec-red shrink-0" />
                      {formatNoShowTag(normalizeDateToISO(user.blockedDate))}
                    </span>
                  </div>
                )}
            </div>
          </div>

          {/* CAMPOS PESSOAIS, WHATSAPP & RA */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Nome Completo</label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-medium text-slate-800"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-700">
                  Número de Telefone / WhatsApp
                </label>
                {phone ? (
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
                ) : (
                  <span className="text-[11px] text-amber-700 font-medium">
                    Pendente de cadastro
                  </span>
                )}
              </div>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="tel"
                  inputMode="numeric"
                  required
                  maxLength={15}
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  placeholder="(00) 00000-0000"
                  className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums font-medium text-slate-800"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                RA / Matrícula Institucional
              </label>
              <div className="relative">
                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  maxLength={32}
                  value={ra}
                  onChange={(e) => setRa(e.target.value)}
                  placeholder="Ex: 1090482411001"
                  className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums font-medium text-slate-800"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Data de Nascimento</label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="date"
                  value={dataNascimento}
                  onChange={(e) => setDataNascimento(e.target.value)}
                  className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red outline-none text-sm font-mono tabular-nums font-medium text-slate-800"
                />
              </div>
            </div>
          </div>

          {/* REGULAR USER ACADEMIC SECTION */}
          {!isAdmin && (
            <div className="pt-4 border-t border-slate-100 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <GraduationCap className="h-4 w-4 text-fatec-red" />
                    Vínculo Acadêmico, Curso e Semestre
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    O curso foi definido no cadastro. Atualize seu semestre ou vínculo conforme necessário.
                  </p>
                </div>

                <div className="inline-flex p-1 bg-slate-100 border border-slate-200 rounded-xl self-start">
                  <button
                    type="button"
                    onClick={() => setTipoVinculo('ALUNO')}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer',
                      tipoVinculo === 'ALUNO'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    )}
                  >
                    Estudante
                  </button>
                  <button
                    type="button"
                    onClick={() => setTipoVinculo('SERVIDOR')}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer',
                      tipoVinculo === 'SERVIDOR'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    )}
                  >
                    Servidor
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-700">Curso Matriculado</label>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                      <Lock className="h-3 w-3" />
                      Fixo no cadastro
                    </span>
                  </div>
                  <div className="p-3 bg-slate-100 border border-slate-200 rounded-xl flex items-center justify-between text-slate-800">
                    <span className="text-xs font-semibold">
                      {userCourseInfo.sigla} — {userCourseInfo.nome}
                    </span>
                    <Lock className="h-4 w-4 text-slate-400 shrink-0 ml-2" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-fatec-red" />
                    Semestre Atual
                  </label>
                  <div className="grid grid-cols-6 gap-1 p-1 bg-slate-50 border border-slate-200 rounded-xl">
                    {[1, 2, 3, 4, 5, 6].map((s) => {
                      const isSelected = semestre === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setSemestre(s)}
                          className={cn(
                            'py-2 rounded-lg text-xs font-bold font-mono tabular-nums transition-colors cursor-pointer',
                            isSelected
                              ? 'bg-fatec-red text-white'
                              : 'text-slate-600 hover:bg-slate-200/60'
                          )}
                        >
                          {s}º
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-100 flex items-center justify-end">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 bg-fatec-red hover:bg-red-800 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50 cursor-pointer"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar Alterações'}
            </button>
          </div>
        </form>
      </div>

      {/* GATEWAY INSTITUCIONAL WHATSAPP (EXCLUSIVO PERFIL ADM) */}
      {isAdmin && (
        <ErrorBoundary variant="inline">
          <WhatsAppGatewayCard />
        </ErrorBoundary>
      )}

      {/* PREFERÊNCIAS DE NOTIFICAÇÃO VIA WHATSAPP */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Alertas e Mensageria via WhatsApp</h3>
              <p className="text-xs text-slate-500">
                Controle o recebimento automático de avisos operacionais das suas reservas.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSendTestAlert}
            disabled={testingWhatsApp || !isPhoneValid || !whatsappNotificationsEnabled}
            className="px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer self-start sm:self-auto"
          >
            {testingWhatsApp ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4 text-emerald-600" />
            )}
            Testar Recebimento
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-slate-900">
                Receber alertas e lembretes de reserva via WhatsApp
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {whatsappNotificationsEnabled
                  ? `Ativo para o número ${
                      isPhoneValid ? formattedPhone : 'informado acima (salve para ativar)'
                    }.`
                  : 'Notificações via WhatsApp silenciadas para sua conta.'}
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={whatsappNotificationsEnabled}
              disabled={togglingWhatsApp}
              onClick={handleToggleWhatsAppPreference}
              className={cn(
                'relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors duration-150 cursor-pointer disabled:opacity-50',
                whatsappNotificationsEnabled ? 'bg-emerald-600' : 'bg-slate-300'
              )}
            >
              <span
                className={cn(
                  'inline-block h-5 w-5 rounded-full bg-white shadow-xs transform transition-transform duration-150 mt-1',
                  whatsappNotificationsEnabled ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </div>

          <div className="pt-5 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-slate-600">
            <div className="space-y-1">
              <p className="font-semibold text-slate-900">Confirmação e Cancelamento</p>
              <p className="text-slate-500 leading-relaxed">
                Resumo imediato com ambiente, data e horário ao agendar ou caso a reserva seja cancelada.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-slate-900">Lembrete Prévio de Início (10 Minutos)</p>
              <p className="text-slate-500 leading-relaxed">
                Aviso enviado 10 minutos antes do início destacando o horário limite de check-in presencial via QR Code (5 min de tolerância).
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-slate-900">Alerta de Desocupação (10 Minutos)</p>
              <p className="text-slate-500 leading-relaxed">
                Disparo faltando 10 minutos para o término oficial do bloco de 50 minutos para organização e liberação do local.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-slate-900">Aviso de No-Show (5 Minutos)</p>
              <p className="text-slate-500 leading-relaxed">
                Notificação automática caso o limite de 5 minutos sem leitura do QR Code seja ultrapassado.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* SEGURANÇA */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-200">
          <h3 className="font-bold text-slate-900">Segurança da Conta</h3>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="font-bold text-slate-900 text-sm">Redefinir Senha</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Enviaremos um e-mail para {user?.email} com as instruções de redefinição.
              </p>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (user?.email) {
                  try {
                    await useAuthStore.getState().resetPassword(user.email);
                    toast.success('E-mail de redefinição enviado com sucesso.');
                  } catch (err) {
                    toast.error(
                      getFriendlyErrorMessage(err, 'Erro ao enviar e-mail de redefinição.')
                    );
                  }
                }
              }}
              className="bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-xl font-semibold text-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Redefinir Senha
            </button>
          </div>

          {!isAdmin && (
            <div className="pt-6 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="font-bold text-fatec-red text-sm">Excluir Meu Perfil</p>
                <p className="text-xs text-slate-500 mt-0.5 max-w-xl">
                  Ao excluir seu perfil, seu acesso será encerrado imediatamente e sua conta permanecerá registrada como inativa para fins de auditoria institucional.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(true)}
                className="px-5 py-2.5 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-fatec-red font-semibold text-xs inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <UserX className="h-4 w-4" />
                Excluir Perfil
              </button>
            </div>
          )}
        </div>
      </div>

      {/* MODAL DE EDIÇÃO RÁPIDA DE PERFIL */}
      <EditProfileModal isOpen={isQuickModalOpen} onClose={() => setIsQuickModalOpen(false)} />

      {/* MODAL DE CONFIRMAÇÃO DE EXCLUSÃO DE PERFIL */}
      <AnimatePresence>
        {isDeleteModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-delete-profile-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeleteModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden p-6 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center text-fatec-red shrink-0">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <h4 id="modal-delete-profile-title" className="text-base font-bold text-slate-900">
                      Confirmar Exclusão de Perfil
                    </h4>
                    <p className="text-xs text-slate-500">Esta ação encerrará seu acesso imediato.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                Seu perfil passará para o status <strong>Inativo</strong> junto à Coordenação e não poderá realizar novos logins ou reservas de salas até eventual reativação administrativa.
              </p>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isDeactivating}
                  onClick={handleConfirmDeactivate}
                  className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-fatec-red hover:bg-red-800 text-white cursor-pointer disabled:opacity-50"
                >
                  {isDeactivating ? 'Processando...' : 'Sim, Excluir Meu Perfil'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
