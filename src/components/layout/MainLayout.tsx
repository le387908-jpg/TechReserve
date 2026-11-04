/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarDays,
  Calendar,
  Building2,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  User as UserIcon,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { isUserInactive } from '../../types';
import { useReservationStore } from '../../store/useReservationStore';
import { useRoomStore } from '../../store/useRoomStore';
import { useScheduleStore } from '../../store/useScheduleStore';
import { useAvailableSlotsStore } from '../../store/useAvailableSlotsStore';
import { usePunishmentStore } from '../../store/usePunishmentStore';
import { useAdminSettingsStore } from '../../store/useAdminSettingsStore';
import { useConnectivityStore } from '../../store/useConnectivityStore';
import { useWhatsAppReservationAlerts } from '../../hooks/useWhatsAppReservationAlerts';
import { Logo } from '../Logo';
import { GlobalAlert } from '../GlobalAlert';
import { ConnectivityBanner, ConnectivityHeaderBadge } from '../ConnectivityBanner';
import { CameraPermissionGuard } from '../CameraPermissionGuard';
import { EditProfileModal } from '../profile/EditProfileModal';
import { ErrorBoundary } from '../ErrorBoundary';
import { getFriendlyErrorMessage } from '../../services/firebase/utils';
import { cn } from '../../lib/utils';

interface SidebarItem {
  icon: React.ElementType;
  label: string;
  path: string;
  adminOnly?: boolean;
}

const MENU_ITEMS: SidebarItem[] = [
  { icon: LayoutDashboard, label: 'Painel ADM', path: '/admin', adminOnly: true },
  { icon: Building2, label: 'Salas', path: '/salas' },
  { icon: CalendarDays, label: 'Reservas', path: '/reservas' },
  { icon: Calendar, label: 'Calendário', path: '/calendario' },
  { icon: Users, label: 'Usuários', path: '/usuarios', adminOnly: true },
  { icon: Settings, label: 'Configurações', path: '/configuracoes' },
];

function formatPunishmentDuration(millis: number): string {
  if (millis <= 0) return '0 segundos';
  const totalSeconds = Math.floor(millis / 1000);

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${days === 1 ? 'dia' : 'dias'}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? 'hora' : 'horas'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`);
  }

  if (parts.length === 1) return parts[0];
  const lastPart = parts.pop();
  return `${parts.join(' ')} e ${lastPart}`;
}

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const [now, setNow] = useState(Date.now());
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Monitora lembretes prévios de reserva e alertas de desocupação (faltando 10 min) via WhatsApp
  useWhatsAppReservationAlerts();

  React.useEffect(() => {
    const timer = setInterval(() => {
      setNow(useConnectivityStore.getState().getOfficialNow());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchReservations = useReservationStore((state) => state.fetchReservations);
  const reconcileServerReservation = useReservationStore(
    (state) => state.reconcileServerReservation
  );
  const fetchRooms = useRoomStore((state) => state.fetchRooms);
  const fetchSchedules = useScheduleStore((state) => state.fetchSchedules);
  const fetchAvailableSlots = useAvailableSlotsStore((state) => state.fetchAvailableSlots);
  const fetchPunishments = usePunishmentStore((state) => state.fetchPunishments);
  const fetchUserPunishments = usePunishmentStore((state) => state.fetchUserPunishments);
  const fetchWhatsAppIntegration = useAdminSettingsStore(
    (state) => state.fetchWhatsAppIntegration
  );
  const notifyOfflineDetected = useConnectivityStore((state) => state.notifyOfflineDetected);
  const synchronizeAfterReconnect = useConnectivityStore(
    (state) => state.synchronizeAfterReconnect
  );

  React.useEffect(() => {
    if (user?.id) {
      const unsubs = [
        fetchReservations(),
        fetchRooms(),
        fetchSchedules(),
        fetchAvailableSlots(),
        fetchWhatsAppIntegration(),
        user?.role === 'ADMIN' ? fetchPunishments() : fetchUserPunishments(user.id),
      ];
      return () => {
        for (const unsub of unsubs) {
          if (typeof unsub === 'function') {
            try {
              unsub();
            } catch (err) {
              console.warn('[MainLayout] Falha ao encerrar listener Firestore:', err);
            }
          }
        }
      };
    }
  }, [
    user?.id,
    user?.role,
    fetchReservations,
    fetchRooms,
    fetchSchedules,
    fetchAvailableSlots,
    fetchWhatsAppIntegration,
    fetchPunishments,
    fetchUserPunishments,
  ]);

  React.useEffect(() => {
    if (user?.id) {
      void synchronizeAfterReconnect(user.id, 'STARTUP', reconcileServerReservation);
    }

    const handleOnline = () => {
      if (user?.id) {
        void synchronizeAfterReconnect(user.id, 'ONLINE_EVENT', reconcileServerReservation);
      }
    };
    const handleOffline = () => {
      void notifyOfflineDetected(user?.id);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && user?.id) {
        const st = useConnectivityStore.getState();
        if (st.status !== 'CONECTADO' || st.pendingCheckInsCount > 0) {
          void synchronizeAfterReconnect(user.id, 'VISIBILITY', reconcileServerReservation);
        }
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user?.id, notifyOfflineDetected, synchronizeAfterReconnect, reconcileServerReservation]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  React.useEffect(() => {
    if (!isMobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileMenuOpen]);

  const isAdmin = user?.role === 'ADMIN';
  const isInactiveUser = isUserInactive(user);

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, 'Erro ao encerrar a sessão.'));
    } finally {
      setIsMobileMenuOpen(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans relative">
      <ConnectivityBanner />

      <GlobalAlert />
      <EditProfileModal
        isOpen={isEditProfileOpen}
        onClose={() => setIsEditProfileOpen(false)}
      />

      <CameraPermissionGuard>
        {/* Sidebar - Desktop */}
        <motion.aside
          initial={false}
          animate={{ width: isSidebarOpen ? 280 : 80 }}
          className={cn(
            'hidden md:flex flex-col bg-slate-900 text-white transition-all duration-200 relative z-20',
            !isSidebarOpen && 'items-center'
          )}
        >
          <div className="p-6 flex items-center justify-between">
            {isSidebarOpen ? (
              <Link
                to={isAdmin ? '/admin' : '/salas'}
                className="flex items-center gap-2 overflow-hidden"
              >
                <Logo variant="dark" />
              </Link>
            ) : (
              <Logo hideText variant="dark" />
            )}
          </div>

          <nav className="flex-1 px-4 space-y-1 mt-4">
            {MENU_ITEMS.map((item) => {
              if (item.adminOnly && !isAdmin) return null;
              const isActive = location.pathname === item.path;

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group relative whitespace-nowrap',
                    isActive
                      ? 'bg-fatec-red text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                  )}
                >
                  <item.icon
                    className={cn('h-5 w-5 shrink-0', isActive ? 'text-white' : 'group-hover:text-white')}
                  />
                  {isSidebarOpen && <span className="font-medium">{item.label}</span>}
                  {!isSidebarOpen && (
                    <div className="absolute left-full ml-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                      {item.label}
                    </div>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="p-4 mt-auto border-t border-slate-800">
            <button
              onClick={handleLogout}
              className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors group relative cursor-pointer"
            >
              <LogOut className="h-5 w-5 group-hover:text-white shrink-0" />
              {isSidebarOpen && <span className="font-medium">Sair</span>}
            </button>
          </div>

          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="absolute -right-3 top-20 bg-fatec-red text-white p-1 rounded-full shadow-lg hover:scale-110 transition-transform cursor-pointer"
            aria-label={isSidebarOpen ? 'Recolher menu lateral' : 'Expandir menu lateral'}
          >
            {isSidebarOpen ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </motion.aside>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between gap-8 px-4 md:px-8 shrink-0 z-10">
            <div className="flex items-center gap-4 min-w-0">
              <button
                onClick={() => setIsMobileMenuOpen(true)}
                className="md:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
                aria-label="Abrir menu"
              >
                <Menu className="h-6 w-6" />
              </button>
              <h1 className="text-xl font-semibold text-slate-900 truncate">
                {MENU_ITEMS.find((i) => i.path === location.pathname)?.label || 'TechReserve'}
              </h1>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <ConnectivityHeaderBadge />
              <button
                type="button"
                onClick={() => setIsEditProfileOpen(true)}
                className="flex items-center gap-3 py-1.5 px-2.5 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer text-left"
                title="Editar perfil e preferências de WhatsApp"
              >
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-semibold text-slate-900 leading-tight">{user?.nome}</p>
                  <p className="text-xs text-slate-500">
                    {user?.phoneFormatted || (user?.role === 'ADMIN' ? 'Coordenação' : 'Editar WhatsApp')}
                  </p>
                </div>
                <div className="h-10 w-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600 overflow-hidden">
                  {user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={user.nome}
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <UserIcon className="h-5 w-5" />
                  )}
                </div>
              </button>
            </div>
          </header>

          {/* Content Area */}
          <main className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar overflow-touch">
            {isInactiveUser && (
              <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                className="mb-6 bg-red-50 border border-red-200 rounded-2xl p-5 flex items-center gap-4 shadow-xs"
              >
                <div className="h-10 w-10 rounded-xl bg-fatec-red flex items-center justify-center text-white shrink-0">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-bold text-rose-950 leading-relaxed">
                    Perfil inativado pelo ADM, caso tenha dúvidas procure o coordenador do curso para mais informações
                  </p>
                </div>
              </motion.div>
            )}

            {user?.punidoAte && user.punidoAte > now && (
              <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-6 bg-red-50 border border-red-200 rounded-2xl p-5 flex items-start gap-4"
              >
                <div className="h-10 w-10 rounded-xl bg-fatec-red flex items-center justify-center text-white shrink-0">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="flex-1 space-y-1.5">
                  <h4 className="text-sm font-bold text-rose-950">
                    Sua conta possui uma restrição temporária ativa
                  </h4>
                  <p className="text-xs text-rose-800 leading-relaxed">
                    Devido a um descumprimento das normas de uso ou ausência de check-in, sua conta está temporariamente suspensa de realizar novas reservas.
                  </p>
                  <div className="pt-2 flex flex-wrap items-center gap-2 text-xs text-rose-900 border-t border-red-200/70">
                    <span>Tempo restante:</span>
                    <span className="font-mono tabular-nums font-bold">
                      {formatPunishmentDuration(user.punidoAte - now)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Motivo: {user?.motivoPunicao || 'Não informado'}</span>
                  </div>
                </div>
              </motion.div>
            )}

            <ErrorBoundary
              resetKey={location.pathname}
              variant="inline"
              onGoHome={() => navigate(isAdmin ? '/admin' : '/salas')}
            >
              <div key={location.pathname} className="animate-in fade-in duration-150">
                {children}
              </div>
            </ErrorBoundary>
          </main>
        </div>

        {/* Mobile Menu Overlay */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileMenuOpen(false)}
                className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-40 md:hidden"
              />
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="Menu de navegação"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.2 }}
                className="fixed inset-y-0 left-0 w-80 bg-slate-900 text-white z-50 p-6 flex flex-col md:hidden"
              >
                <div className="flex items-center justify-between mb-8">
                  <Logo variant="dark" />
                  <button
                    type="button"
                    aria-label="Fechar menu"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="p-2 text-slate-400 hover:text-white"
                  >
                    <X className="h-6 w-6" />
                  </button>
                </div>

                <nav className="flex-1 space-y-2">
                  {MENU_ITEMS.map((item) => {
                    if (item.adminOnly && !isAdmin) return null;
                    const isActive = location.pathname === item.path;

                    return (
                      <Link
                        key={item.path}
                        to={item.path}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={cn(
                          'flex items-center gap-4 px-4 py-3.5 rounded-xl transition-colors',
                          isActive ? 'bg-fatec-red text-white' : 'text-slate-400 hover:bg-slate-800'
                        )}
                      >
                        <item.icon className="h-5 w-5" />
                        <span className="font-medium text-base">{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>

                <div className="pt-6 border-t border-slate-800">
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-4 w-full px-4 py-3.5 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    <LogOut className="h-5 w-5" />
                    <span className="font-medium text-base">Sair</span>
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </CameraPermissionGuard>
    </div>
  );
}
