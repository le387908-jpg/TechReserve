/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  QrCode,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ConnectionRecoveryState,
  useConnectivityStore,
} from '../store/useConnectivityStore';
import { useAuthStore } from '../store/useAuthStore';
import { useReservationStore } from '../store/useReservationStore';
import { cn } from '../lib/utils';

const STATE_LABELS: Record<ConnectionRecoveryState, string> = {
  CONECTADO: 'Conectado',
  SEM_CONEXAO: 'Sem conexão',
  RECONECTANDO: 'Reconectando',
  SINCRONIZANDO: 'Sincronizando',
  RESERVA_RECUPERADA: 'Reserva recuperada',
  FALHA_SINCRONIZACAO: 'Falha na sincronização',
};

/**
 * Indicador compacto e discreto no cabeçalho exibindo o estado de conexão e sincronização.
 */
export function ConnectivityHeaderBadge() {
  const status = useConnectivityStore((s) => s.status);
  const pendingCheckInsCount = useConnectivityStore((s) => s.pendingCheckInsCount);
  const synchronizeAfterReconnect = useConnectivityStore((s) => s.synchronizeAfterReconnect);
  const user = useAuthStore((s) => s.user);
  const reconcileServerReservation = useReservationStore((s) => s.reconcileServerReservation);

  const label = STATE_LABELS[status];

  const badgeStyles: Record<ConnectionRecoveryState, string> = {
    CONECTADO: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
    SEM_CONEXAO: 'bg-red-50 text-fatec-red border-red-200',
    RECONECTANDO: 'bg-amber-50 text-amber-800 border-amber-200',
    SINCRONIZANDO: 'bg-blue-50 text-blue-800 border-blue-200',
    RESERVA_RECUPERADA: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    FALHA_SINCRONIZACAO: 'bg-rose-50 text-rose-800 border-rose-200',
  };

  const renderIcon = () => {
    switch (status) {
      case 'CONECTADO':
        return <Wifi className="h-3.5 w-3.5 text-emerald-600 shrink-0" aria-hidden="true" />;
      case 'SEM_CONEXAO':
        return <WifiOff className="h-3.5 w-3.5 text-fatec-red shrink-0" aria-hidden="true" />;
      case 'RECONECTANDO':
      case 'SINCRONIZANDO':
        return (
          <RefreshCw
            className="h-3.5 w-3.5 animate-spin shrink-0"
            aria-hidden="true"
          />
        );
      case 'RESERVA_RECUPERADA':
        return (
          <CheckCircle2
            className="h-3.5 w-3.5 text-emerald-600 shrink-0"
            aria-hidden="true"
          />
        );
      case 'FALHA_SINCRONIZACAO':
        return (
          <AlertTriangle
            className="h-3.5 w-3.5 text-rose-600 shrink-0"
            aria-hidden="true"
          />
        );
    }
  };

  const isActionable = status === 'FALHA_SINCRONIZACAO' || status === 'SEM_CONEXAO';

  return (
    <button
      type="button"
      onClick={() => {
        if (isActionable && user?.id) {
          void synchronizeAfterReconnect(user.id, 'MANUAL', reconcileServerReservation);
        }
      }}
      disabled={!isActionable}
      aria-label={`Status de conexão: ${label}${
        pendingCheckInsCount > 0
          ? `, ${pendingCheckInsCount} leitura de QR pendente de validação`
          : ''
      }`}
      title={
        isActionable
          ? `${label} — Clique para verificar conexão e sincronizar agora`
          : `Status da conexão: ${label}`
      }
      className={cn(
        'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-colors',
        badgeStyles[status],
        isActionable ? 'cursor-pointer hover:opacity-90' : 'cursor-default'
      )}
    >
      {renderIcon()}
      <span>{label}</span>
      {pendingCheckInsCount > 0 && (
        <span className="inline-flex items-center gap-1 pl-1 border-l border-current/20 font-mono tabular-nums">
          <QrCode className="h-3 w-3" aria-hidden="true" />
          {pendingCheckInsCount}
        </span>
      )}
    </button>
  );
}

/**
 * Faixa superior discreta e responsiva para estados de perda de conexão, reconexão,
 * sincronização, recuperação de reserva e falha temporária de sincronização.
 */
export function ConnectivityBanner() {
  const status = useConnectivityStore((s) => s.status);
  const statusMessage = useConnectivityStore((s) => s.statusMessage);
  const pendingCheckInsCount = useConnectivityStore((s) => s.pendingCheckInsCount);
  const synchronizeAfterReconnect = useConnectivityStore((s) => s.synchronizeAfterReconnect);
  const user = useAuthStore((s) => s.user);
  const reconcileServerReservation = useReservationStore((s) => s.reconcileServerReservation);

  const bannerTheme: Record<Exclude<ConnectionRecoveryState, 'CONECTADO'>, string> = {
    SEM_CONEXAO: 'bg-fatec-red text-white',
    RECONECTANDO: 'bg-slate-900 text-white',
    SINCRONIZANDO: 'bg-slate-900 text-white',
    RESERVA_RECUPERADA: 'bg-emerald-700 text-white',
    FALHA_SINCRONIZACAO: 'bg-amber-600 text-white',
  };

  const renderBannerIcon = () => {
    switch (status) {
      case 'SEM_CONEXAO':
        return <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'RECONECTANDO':
      case 'SINCRONIZANDO':
        return <RefreshCw className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />;
      case 'RESERVA_RECUPERADA':
        return <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'FALHA_SINCRONIZACAO':
        return <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />;
      default:
        return null;
    }
  };

  return (
    <AnimatePresence>
      {status !== 'CONECTADO' && Boolean(statusMessage) && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ y: -48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -48, opacity: 0 }}
          className={cn(
            'fixed top-0 left-0 right-0 z-[100] py-2 px-4 flex flex-wrap items-center justify-center gap-2.5 shadow-lg text-xs font-semibold',
            bannerTheme[status]
          )}
        >
          {renderBannerIcon()}
          <span>{statusMessage}</span>
          {pendingCheckInsCount > 0 && (
            <span className="px-2 py-0.5 rounded-md bg-white/15 text-[11px] font-mono">
              QR aguardando validação no servidor ({pendingCheckInsCount})
            </span>
          )}
          {status === 'FALHA_SINCRONIZACAO' && user?.id && (
            <button
              type="button"
              onClick={() => {
                void synchronizeAfterReconnect(user.id, 'MANUAL', reconcileServerReservation);
              }}
              className="px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 text-white text-[11px] font-bold transition-colors cursor-pointer"
            >
              Tentar agora
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
