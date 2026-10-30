/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Mail,
  Lock,
  User,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  Calendar,
  GraduationCap,
  BookOpen,
  Info,
  Hash,
  Phone,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { Logo } from '../../components/Logo';
import { CalendarCourse, UserVinculo } from '../../types';
import { normalizeDateToISO } from '../../utils/dateUtils';
import {
  formatPhone,
  getPhoneValidationMessage,
  sanitizePhone,
  validatePhone,
} from '../../utils/formatters';
import { cn } from '../../lib/utils';

const COURSES: { id: CalendarCourse; label: string; name: string }[] = [
  { id: 'GTI', label: 'GTI', name: 'Gestão da Tecnologia da Informação' },
  { id: 'GEEE', label: 'GEEE', name: 'Gestão de Energia e Eficiência Energética' },
];

export function SignupPage() {
  const navigate = useNavigate();
  const { signUp, loading, user } = useAuth();

  const [nome, setNome] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [whatsappNotificationsEnabled, setWhatsappNotificationsEnabled] = useState(true);
  const [ra, setRa] = useState('');
  const [tipoVinculo, setTipoVinculo] = useState<UserVinculo>('ALUNO');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dataNascimento, setDataNascimento] = useState('');
  const [role, setRole] = useState<'USUARIO' | 'ADMIN'>('USUARIO');
  const [adminCode, setAdminCode] = useState('');
  const [curso, setCurso] = useState<CalendarCourse>('GTI');
  const [semestre, setSemestre] = useState<number>(1);
  const [showPassword, setShowPassword] = useState(false);

  React.useEffect(() => {
    if (user) {
      navigate(user.role === 'ADMIN' ? '/admin' : '/salas');
    }
  }, [user, navigate]);

  const isPhoneValid = validatePhone(phone);
  const phoneErrorMessage = getPhoneValidationMessage(phone);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhone(formatPhone(e.target.value));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneTouched(true);

    if (!isPhoneValid) {
      toast.error(
        phoneErrorMessage ||
          'Informe um número de telefone válido com 11 dígitos no formato (00) 00000-0000.'
      );
      return;
    }

    const selectedRole: 'USUARIO' | 'ADMIN' = role === 'ADMIN' ? 'ADMIN' : 'USUARIO';

    try {
      const createdUser = await signUp({
        email: email.trim(),
        pass: password,
        nome: nome.trim(),
        phone: sanitizePhone(phone),
        whatsappNotificationsEnabled,
        ra: ra.trim(),
        tipoVinculo:
          selectedRole === 'ADMIN'
            ? 'COORDENACAO'
            : tipoVinculo === 'SERVIDOR'
            ? 'SERVIDOR'
            : 'ALUNO',
        dataNascimento: normalizeDateToISO(dataNascimento) || '2000-01-01',
        role: selectedRole,
        ...(selectedRole === 'ADMIN' ? { code: adminCode.trim() } : {}),
        ...(selectedRole === 'USUARIO'
          ? {
              curso,
              ...(tipoVinculo === 'ALUNO' ? { semestre } : {}),
            }
          : {}),
      });
      toast.success('Cadastro realizado com sucesso! Bem-vindo ao TechReserve.');
      navigate(createdUser.role === 'ADMIN' ? '/admin' : '/salas', { replace: true });
    } catch (err: any) {
      toast.error(err.message || 'Erro ao realizar cadastro.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            <Logo />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Solicitar Acesso</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Cadastre seu perfil acadêmico ou administrativo no TechReserve
          </p>
        </div>

        <div className="bg-white rounded-3xl shadow-sm p-8 border border-slate-200 relative overflow-hidden">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 ml-1">Nome Completo</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  required
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors text-sm outline-none"
                  placeholder="Ex: João Silva"
                />
              </div>
            </div>

            {/* CAMPO OBRIGATÓRIO: NÚMERO DE TELEFONE / WHATSAPP COM MÁSCARA */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between ml-1">
                <label className="text-xs font-semibold text-slate-700">
                  Número de Telefone / WhatsApp <span className="text-fatec-red">*</span>
                </label>
                {phone && isPhoneValid && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    11 dígitos válidos
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
                  onChange={handlePhoneChange}
                  onBlur={() => setPhoneTouched(true)}
                  className={cn(
                    'w-full pl-10 pr-4 py-3 bg-slate-50 border rounded-xl focus:ring-2 transition-colors text-sm font-mono tabular-nums outline-none',
                    phoneTouched && !isPhoneValid
                      ? 'border-red-300 focus:ring-fatec-red'
                      : 'border-slate-200 focus:ring-fatec-red'
                  )}
                  placeholder="(00) 00000-0000"
                />
              </div>
              {phoneTouched && !isPhoneValid && (
                <p className="text-[11px] text-fatec-red flex items-center gap-1 ml-1">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{phoneErrorMessage}</span>
                </p>
              )}

              {/* PREFERÊNCIA INICIAL DE ALERTAS WHATSAPP */}
              <div className="pt-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={whatsappNotificationsEnabled}
                  onClick={() => setWhatsappNotificationsEnabled((prev) => !prev)}
                  className="w-full flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100/70 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <MessageSquare className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span className="text-xs font-medium text-slate-700 leading-snug">
                      Receber alertas e lembretes de reserva via WhatsApp
                    </span>
                  </div>
                  <span
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
                      whatsappNotificationsEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 rounded-full bg-white shadow-xs transform transition-transform duration-150 mt-0.5',
                        whatsappNotificationsEnabled ? 'translate-x-4.5' : 'translate-x-0.5'
                      )}
                    />
                  </span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 ml-1">
                  RA / Matrícula
                </label>
                <div className="relative">
                  <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    required={role === 'USUARIO'}
                    maxLength={32}
                    value={ra}
                    onChange={(e) => setRa(e.target.value)}
                    className="w-full pl-9 pr-3 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors text-sm font-mono tabular-nums outline-none"
                    placeholder="Ex: 1090482411001"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 ml-1">
                  Data de Nascimento
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="date"
                    required
                    value={dataNascimento}
                    onChange={(e) => setDataNascimento(e.target.value)}
                    className="w-full pl-9 pr-3 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors text-sm font-mono tabular-nums outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 ml-1">
                E-mail Institucional ou Pessoal
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors text-sm outline-none"
                  placeholder="seu@email.com"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 ml-1">Senha de Acesso</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors text-sm outline-none"
                  placeholder="Mínimo 6 caracteres"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="pt-1">
              <label className="text-xs font-semibold text-slate-700 mb-2 block">
                Tipo de Perfil
              </label>
              <div className="grid grid-cols-2 gap-2.5 p-1 bg-slate-100 rounded-xl border border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setRole('USUARIO');
                    setAdminCode('');
                  }}
                  className={`py-2.5 px-3 rounded-lg transition-colors font-semibold text-xs cursor-pointer ${
                    role === 'USUARIO'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Acadêmico (Aluno / Servidor)
                </button>
                <button
                  type="button"
                  onClick={() => setRole('ADMIN')}
                  className={`py-2.5 px-3 rounded-lg transition-colors font-semibold text-xs cursor-pointer ${
                    role === 'ADMIN'
                      ? 'bg-slate-900 text-white shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Admin / Coordenação
                </button>
              </div>
            </div>

            {role === 'USUARIO' && (
              <div className="space-y-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 text-left">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">
                    Vínculo Institucional
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setTipoVinculo('ALUNO')}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition-colors cursor-pointer ${
                        tipoVinculo === 'ALUNO'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Aluno / Estudante
                    </button>
                    <button
                      type="button"
                      onClick={() => setTipoVinculo('SERVIDOR')}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition-colors cursor-pointer ${
                        tipoVinculo === 'SERVIDOR'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Servidor / Docente
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                    <GraduationCap className="h-4 w-4 text-fatec-red" />
                    Curso de Atuação / Matrícula
                  </label>
                  <select
                    value={curso}
                    onChange={(e) => setCurso(e.target.value as CalendarCourse)}
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red text-xs font-semibold text-slate-800 outline-none"
                  >
                    {COURSES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} — {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {tipoVinculo === 'ALUNO' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <BookOpen className="h-4 w-4 text-fatec-red" />
                      Semestre Atual
                    </label>
                    <div className="grid grid-cols-6 gap-1.5 p-1 bg-white border border-slate-200 rounded-xl">
                      {[1, 2, 3, 4, 5, 6].map((s) => {
                        const isSelected = semestre === s;
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setSemestre(s)}
                            className={`py-2 rounded-lg text-xs font-bold font-mono tabular-nums transition-colors cursor-pointer ${
                              isSelected
                                ? 'bg-fatec-red text-white'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                          >
                            {s}º
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-2 pt-2 border-t border-slate-200 text-[11px] text-slate-500 leading-relaxed">
                  <Info className="h-4 w-4 text-fatec-red shrink-0 mt-0.5" />
                  <span>
                    Seu curso define sua grade horária de referência. Telefone, preferências de WhatsApp e semestre poderão ser editados a qualquer momento no perfil.
                  </span>
                </div>
              </div>
            )}

            {role === 'ADMIN' && (
              <div className="space-y-3 text-left">
                <div className="p-3.5 bg-slate-900 text-white rounded-2xl border border-slate-800 space-y-1">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-amber-400" />
                    <span className="text-xs font-semibold text-amber-300">
                      Coordenação Institucional
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Exige o código de autorização institucional (<code className="font-mono">code-auth</code>) gerenciado no Painel ADM.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 ml-1">
                    Código de Autorização (code-auth)
                  </label>
                  <div className="relative">
                    <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="password"
                      required={role === 'ADMIN'}
                      value={adminCode}
                      onChange={(e) => setAdminCode(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 bg-red-50/40 border border-red-200 rounded-xl focus:ring-2 focus:ring-fatec-red transition-colors font-mono tabular-nums font-semibold text-sm outline-none"
                      placeholder="Informe o code-auth vigente"
                    />
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-fatec-red hover:bg-red-800 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2 text-sm cursor-pointer disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Finalizar Cadastro'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-100 text-center">
            <p className="text-slate-500 text-sm">
              Já possui conta?{' '}
              <Link to="/login" className="text-fatec-red font-semibold hover:underline">
                Acesse aqui
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
