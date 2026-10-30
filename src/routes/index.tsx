/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MainLayout } from '../components/layout/MainLayout';

// Lazy load pages
const LoginPage = lazy(() => import('../pages/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('../pages/auth/SignupPage').then(m => ({ default: m.SignupPage })));
const AdminPanelPage = lazy(() => import('../pages/admin/AdminPanelPage').then(m => ({ default: m.AdminPanelPage })));
const ReservasPage = lazy(() => import('../pages/reservas/ReservasPage').then(m => ({ default: m.ReservasPage })));
const CalendarioPage = lazy(() => import('../pages/calendario/CalendarioPage').then(m => ({ default: m.CalendarioPage })));
const SalasPage = lazy(() => import('../pages/salas/SalasPage').then(m => ({ default: m.SalasPage })));
const UsuariosPage = lazy(() => import('../pages/usuarios/UsuariosPage').then(m => ({ default: m.UsuariosPage })));
const ConfiguracoesPage = lazy(() => import('../pages/configuracoes/ConfiguracoesPage').then(m => ({ default: m.ConfiguracoesPage })));

function LoadingFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 border-4 border-slate-200 border-t-fatec-red rounded-full animate-spin"></div>
        <p className="text-slate-500 font-medium">Carregando TechReserve...</p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode, adminOnly?: boolean }) {
  const { user, initialized } = useAuth();
  const location = useLocation();

  if (!initialized) {
    return <LoadingFallback />;
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (adminOnly && user.role !== 'ADMIN') {
    return <Navigate to="/salas" replace />;
  }

  return <MainLayout>{children}</MainLayout>;
}

function HomeRedirect() {
  const { user, initialized } = useAuth();
  if (!initialized) {
    return <LoadingFallback />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={user.role === 'ADMIN' ? '/admin' : '/salas'} replace />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        <Route path="/" element={<HomeRedirect />} />
        <Route path="/salas" element={<ProtectedRoute><SalasPage /></ProtectedRoute>} />
        <Route path="/reservas" element={<ProtectedRoute><ReservasPage /></ProtectedRoute>} />
        <Route path="/calendario" element={<ProtectedRoute><CalendarioPage /></ProtectedRoute>} />

        {/* Rotas Exclusivas do Perfil ADM */}
        <Route path="/admin" element={<ProtectedRoute adminOnly><AdminPanelPage /></ProtectedRoute>} />
        <Route path="/usuarios" element={<ProtectedRoute adminOnly><UsuariosPage /></ProtectedRoute>} />

        <Route path="/configuracoes" element={<ProtectedRoute><ConfiguracoesPage /></ProtectedRoute>} />

        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </Suspense>
  );
}
