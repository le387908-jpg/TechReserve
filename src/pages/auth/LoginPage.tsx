/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { Logo } from '../../components/Logo';

export function LoginPage() {
  const navigate = useNavigate();
  const { signIn, resetPassword, clearError, loading, user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [isResetting, setIsResetting] = useState(false);

  React.useEffect(() => {
    // Redireciona imediatamente se já estiver logado nesta aba
    if (user) {
      navigate('/');
    }
  }, [user, navigate]);

  React.useEffect(() => {
    // Limpa erro anterior ao carregar a página de login
    clearError();
  }, [clearError]);

  const handleForgotPassword = async () => {
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      toast.error('Por favor, informe seu e-mail no campo acima primeiro.');
      return;
    }

    setIsResetting(true);
    try {
      await resetPassword(cleanEmail);
      toast.success(`E-mail de redefinição enviado com sucesso para ${cleanEmail}! Verifique sua caixa de entrada e também a pasta de SPAM.`);
    } catch (err: any) {
      console.error('Password reset error:', err);
      let errorMsg = 'Erro ao enviar e-mail de redefinição.';
      if (err.code === 'auth/user-not-found') {
        errorMsg = 'Usuário não encontrado com este e-mail.';
      } else if (err.code === 'auth/invalid-email') {
        errorMsg = 'E-mail inválido.';
      }
      toast.error(errorMsg);
    } finally {
      setIsResetting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await signIn(email, password);
      toast.success('Login realizado com sucesso!');
      navigate('/');
    } catch (err: any) {
      console.error('Login submit error:', err);
      toast.error(err.message || 'E-mail ou senha incorretos.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-6">
            <Logo />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">TechReserve</h1>
          <p className="text-slate-500 mt-2">Plataforma de gestão de espaços</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 p-8 border border-slate-100">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700 ml-1">E-mail</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red focus:border-fatec-red transition-all"
                  placeholder="seu@email.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center px-1">
                <label className="text-sm font-semibold text-slate-700">Senha</label>
                <button 
                  type="button" 
                  onClick={handleForgotPassword}
                  disabled={isResetting}
                  className="text-xs font-semibold text-fatec-red hover:underline disabled:opacity-50"
                >
                  {isResetting ? 'Enviando...' : 'Esqueceu a senha?'}
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-fatec-red focus:border-fatec-red transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-fatec-red hover:bg-red-800 text-white font-bold py-4 rounded-xl shadow-lg shadow-red-200 transition-all flex items-center justify-center gap-2 group"
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                'Entrar na conta'
              )}
            </button>
          </form>

          <div className="mt-8 pt-8 border-t border-slate-100 text-center">
            <p className="text-slate-500">
              Ainda não tem acesso?{' '}
              <Link to="/signup" className="text-fatec-red font-bold hover:underline">
                Solicite seu cadastro
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
