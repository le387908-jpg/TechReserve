/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  LogOut,
  QrCode,
  RefreshCw,
  Save,
  Server,
  Smartphone,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  connectWhatsAppGateway,
  disconnectWhatsAppGateway,
  getWhatsAppGatewayStatus,
} from '../../services/whatsappService';
import { useAdminSettingsStore } from '../../store/useAdminSettingsStore';
import { WhatsAppGatewayStatus } from '../../types';
import { formatPhone, sanitizePhone, validatePhone } from '../../utils/formatters';
import { cn } from '../../lib/utils';

interface WhatsAppGatewayCardProps {
  compact?: boolean;
}

/**
 * Painel administrativo de status da integração WhatsApp (Evolution API).
 *
 * Regras de estado:
 * - Lê e sincroniza `settings/whatsapp_integration` (`whatsappConnected`, `isConfigured`, `instanceName`) no Firestore.
 * - Se a flag no Firestore já estiver `true` OU se os parâmetros de servidor (`configured` / `hasApiToken`) já estiverem preenchidos,
 *   OMITE qualquer banner de sugestão de integração e exibe apenas o status "Integrado / Ativo".
 */
export function WhatsAppGatewayCard({ compact = false }: WhatsAppGatewayCardProps) {
  const {
    whatsappIntegration,
    whatsappExistsInFirestore,
    whatsappInitialized,
    saveWhatsAppIntegration,
  } = useAdminSettingsStore();

  const [status, setStatus] = useState<WhatsAppGatewayStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [instanceInput, setInstanceInput] = useState(
    whatsappIntegration.instanceName || 'techreserve'
  );
  const [showQrPanel, setShowQrPanel] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrCodeBase64, setQrCodeBase64] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [showPhonePairing, setShowPhonePairing] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('');

  const autoPersistedRef = useRef(false);

  useEffect(() => {
    if (whatsappIntegration.instanceName) {
      setInstanceInput(whatsappIntegration.instanceName);
    }
  }, [whatsappIntegration.instanceName]);

  const refreshStatus = useCallback(
    async (silent = false, overrideInstance?: string) => {
      if (!silent) setLoadingStatus(true);
      try {
        const next = await getWhatsAppGatewayStatus(overrideInstance);
        setStatus((prev) => {
          if (prev && !prev.connected && next.connected) {
            toast.success(
              'WhatsApp institucional sincronizado! O envio automático via Evolution API está ativo.'
            );
            setQrCodeBase64(null);
            setPairingCode(null);
            setShowQrPanel(false);
          }
          return next;
        });
      } finally {
        if (!silent) setLoadingStatus(false);
      }
    },
    []
  );

  useEffect(() => {
    void refreshStatus(false);
  }, [refreshStatus]);

  // Persiste automaticamente `whatsappConnected: true` e `isConfigured: true` no Firestore
  // assim que os parâmetros da Evolution API são detectados no servidor (sem exigir nova configuração manual).
  useEffect(() => {
    if (autoPersistedRef.current) return;
    if (!whatsappInitialized || loadingStatus || !status) return;

    const serverHasParams = Boolean(
      status.configured || status.hasApiToken || status.connected
    );
    const firestoreAlreadyActive = Boolean(
      whatsappExistsInFirestore &&
        (whatsappIntegration.whatsappConnected || whatsappIntegration.isConfigured)
    );

    if (serverHasParams && !firestoreAlreadyActive) {
      autoPersistedRef.current = true;
      const detectedInstance =
        status.instanceName || whatsappIntegration.instanceName || 'techreserve';
      void saveWhatsAppIntegration({
        instanceName: detectedInstance,
        provider: status.provider || 'EVOLUTION',
        whatsappConnected: true,
        isConfigured: true,
        silentLog: true,
      });
    }
  }, [
    whatsappInitialized,
    whatsappExistsInFirestore,
    whatsappIntegration.whatsappConnected,
    whatsappIntegration.isConfigured,
    whatsappIntegration.instanceName,
    loadingStatus,
    status,
    saveWhatsAppIntegration,
  ]);

  // Enquanto o administrador abrir voluntariamente o QR Code, verifica leitura a cada 4 segundos
  useEffect(() => {
    if (!qrCodeBase64 && !pairingCode) return;
    if (status?.connected) return;

    const timer = setInterval(() => {
      void refreshStatus(true, instanceInput);
    }, 4000);

    return () => clearInterval(timer);
  }, [qrCodeBase64, pairingCode, status?.connected, refreshStatus, instanceInput]);

  const hasFirestoreFlag = Boolean(
    whatsappIntegration.whatsappConnected || whatsappIntegration.isConfigured
  );
  const hasServerParams = Boolean(
    status?.configured || status?.hasApiToken || status?.connected
  );
  const isIntegrated = hasFirestoreFlag || hasServerParams;

  const effectiveInstanceName =
    (instanceInput || '').trim() ||
    status?.instanceName ||
    whatsappIntegration.instanceName ||
    'techreserve';

  const handleSaveIntegrationSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanInstance =
      instanceInput.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'techreserve';
    setInstanceInput(cleanInstance);
    setSavingSettings(true);

    try {
      await saveWhatsAppIntegration({
        instanceName: cleanInstance,
        provider: status?.provider || whatsappIntegration.provider || 'EVOLUTION',
        whatsappConnected: true,
        isConfigured: true,
      });
      await refreshStatus(true, cleanInstance);
      toast.success(
        `Integração WhatsApp salva como Ativa no Firestore (instância: ${cleanInstance}).`
      );
    } catch {
      toast.error('Não foi possível salvar os parâmetros da integração no Firestore.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleGenerateQr = async (forceRecreate = false) => {
    if (showPhonePairing && pairingPhone && !validatePhone(pairingPhone)) {
      toast.error('Informe um número de WhatsApp válido de 11 dígitos para gerar o código.');
      return;
    }

    setConnecting(true);
    try {
      const cleanInstance =
        instanceInput.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'techreserve';
      const res = await connectWhatsAppGateway({
        phone: showPhonePairing && pairingPhone ? sanitizePhone(pairingPhone) : undefined,
        forceRecreate,
        instanceName: cleanInstance,
      });

      if (res.connected) {
        setQrCodeBase64(null);
        setPairingCode(null);
        setShowQrPanel(false);
        await saveWhatsAppIntegration({
          instanceName: res.instanceName || cleanInstance,
          provider: status?.provider || 'EVOLUTION',
          whatsappConnected: true,
          isConfigured: true,
          silentLog: true,
        });
        await refreshStatus(true, res.instanceName || cleanInstance);
        toast.success('O WhatsApp institucional está conectado e ativo.');
        return;
      }

      if (!res.success) {
        toast.error(res.error || 'Não foi possível gerar o QR Code no momento.');
        return;
      }

      if (res.qrCodeBase64) {
        const normalizedImg = res.qrCodeBase64.startsWith('data:image')
          ? res.qrCodeBase64
          : `data:image/png;base64,${res.qrCodeBase64}`;
        setQrCodeBase64(normalizedImg);
      }
      if (res.pairingCode) {
        setPairingCode(res.pairingCode);
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await disconnectWhatsAppGateway(effectiveInstanceName);
      if (res.success) {
        setQrCodeBase64(null);
        setPairingCode(null);
        toast.success('Sessão do aparelho desconectada.');
        await refreshStatus(false, effectiveInstanceName);
      } else {
        toast.error(res.message);
      }
    } finally {
      setDisconnecting(false);
    }
  };

  // MODO COMPACTO (Painel ADM):
  // Quando já integrado (via Firestore ou variáveis Evolution API), omite qualquer banner de sugestão
  // e mostra apenas a barra discreta com status "Integrado / Ativo".
  if (compact) {
    if (loadingStatus && !isIntegrated) {
      return (
        <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400 shrink-0" />
            <span>Verificando integração WhatsApp (Evolution API)...</span>
          </div>
        </div>
      );
    }

    if (isIntegrated) {
      return (
        <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-700">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="font-semibold text-slate-900">WhatsApp Evolution API</span>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800">
              Integrado / Ativo
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-mono text-slate-600">
              Instância: {status?.instanceName || effectiveInstanceName}
            </span>
            {status?.ownerNumber && (
              <>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span className="font-mono tabular-nums text-slate-600">
                  +{status.ownerNumber}
                </span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => void refreshStatus(false, effectiveInstanceName)}
            disabled={loadingStatus}
            className="text-xs font-semibold text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loadingStatus && 'animate-spin')} />
            Atualizar
          </button>
        </div>
      );
    }
  }

  // MODO COMPLETO (Tela de Configurações ADM):
  // Se integrado, omite o banner de sugestão e exibe status "Integrado / Ativo" + controle da instância.
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="p-5 sm:p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'h-10 w-10 rounded-xl border flex items-center justify-center shrink-0',
              isIntegrated
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-slate-100 border-slate-200 text-slate-600'
            )}
          >
            {loadingStatus && !isIntegrated ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : isIntegrated ? (
              <Wifi className="h-5 w-5" />
            ) : (
              <WifiOff className="h-5 w-5" />
            )}
          </div>

          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-bold text-slate-900 text-sm sm:text-base">
                Integração WhatsApp — Evolution API
              </h3>
              <span
                className={cn(
                  'text-[11px] font-semibold px-2 py-0.5 rounded-md border',
                  loadingStatus && !isIntegrated
                    ? 'bg-slate-50 border-slate-200 text-slate-600'
                    : isIntegrated
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-700'
                )}
              >
                {loadingStatus && !isIntegrated
                  ? 'Verificando...'
                  : isIntegrated
                  ? 'Integrado / Ativo'
                  : 'Não Configurado'}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {isIntegrated
                ? `Integração ativa para confirmações, lembretes, cancelamentos e avisos de No-Show via /message/sendText/${
                    status?.instanceName || effectiveInstanceName
                  }${status?.ownerNumber ? ` (+${status.ownerNumber})` : ''}.`
                : 'Salve o identificador da instância da Evolution API para fixar o estado da integração.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void refreshStatus(false, effectiveInstanceName)}
            disabled={loadingStatus}
            className="px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loadingStatus && 'animate-spin')} />
            Verificar Status
          </button>

          {hasServerParams && (
            <button
              type="button"
              onClick={() => setShowQrPanel((prev) => !prev)}
              className="px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <QrCode className="h-3.5 w-3.5 text-slate-600" />
              {showQrPanel ? 'Ocultar Pareamento QR' : 'Parear / Reconectar QR'}
            </button>
          )}

          {status?.connected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-3.5 py-2 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-fatec-red text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {disconnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              Desconectar Sessão
            </button>
          )}
        </div>
      </div>

      {/* PARÂMETROS DA INSTÂNCIA SINCRONIZADOS NO FIRESTORE (`settings/whatsapp_integration`) */}
      <form
        onSubmit={handleSaveIntegrationSettings}
        className="px-5 sm:px-6 py-4 bg-slate-50/50 flex flex-col sm:flex-row sm:items-end justify-between gap-4"
      >
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5 text-slate-500" />
              Instância Evolution API
            </label>
            <input
              type="text"
              maxLength={80}
              value={instanceInput}
              onChange={(e) => setInstanceInput(e.target.value)}
              placeholder="techreserve"
              className="w-full px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-800 outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>

          <div className="space-y-1">
            <span className="text-xs font-semibold text-slate-700 block">
              Credenciais Server-Side (URL / API Key)
            </span>
            <div className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs flex items-center justify-between text-slate-700">
              <span>
                {hasServerParams ? 'Configuradas no Servidor' : 'Variáveis de ambiente pendentes'}
              </span>
              {isIntegrated && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Integrado / Ativo
                </span>
              )}
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={savingSettings}
          className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 self-start sm:self-auto"
        >
          {savingSettings ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Salvar Integração
        </button>
      </form>

      {/* PAINEL OPCIONAL DE PAREAMENTO QR CODE (EXIBIDO APENAS SE SOLICITADO PELO ADM) */}
      {showQrPanel && hasServerParams && (
        <div className="p-5 sm:p-6 border-t border-slate-200 bg-slate-50/70 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-800">
                Pareamento / Reconexão de Aparelho WhatsApp
              </p>
              <p className="text-xs text-slate-500">
                Utilize apenas caso deseje trocar o aparelho institucional conectado à instância{' '}
                <span className="font-mono font-semibold text-slate-700">
                  {effectiveInstanceName}
                </span>
                .
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowPhonePairing((prev) => !prev)}
                className="text-xs font-semibold text-slate-700 hover:text-slate-900 underline underline-offset-2 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Smartphone className="h-3.5 w-3.5 text-slate-500" />
                {showPhonePairing
                  ? 'Ocultar código por telefone'
                  : 'Usar código numérico por telefone'}
              </button>

              <button
                type="button"
                onClick={() => void handleGenerateQr(Boolean(qrCodeBase64))}
                disabled={connecting}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {connecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <QrCode className="h-3.5 w-3.5" />
                )}
                {qrCodeBase64 ? 'Gerar Novo QR Code' : 'Gerar QR Code'}
              </button>
            </div>
          </div>

          {showPhonePairing && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 max-w-md">
              <input
                type="tel"
                inputMode="numeric"
                maxLength={15}
                value={pairingPhone}
                onChange={(e) => setPairingPhone(formatPhone(e.target.value))}
                placeholder="(16) 99999-9999"
                className="flex-1 px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono tabular-nums outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <button
                type="button"
                onClick={() => void handleGenerateQr(true)}
                disabled={connecting}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                {connecting ? 'Gerando...' : 'Gerar Código / QR'}
              </button>
            </div>
          )}

          {(qrCodeBase64 || pairingCode) && (
            <div className="pt-2 flex flex-col sm:flex-row items-center gap-6 bg-white p-5 rounded-2xl border border-slate-200">
              {qrCodeBase64 && (
                <div className="p-3 bg-white border border-slate-200 rounded-2xl shrink-0">
                  <img
                    src={qrCodeBase64}
                    alt="QR Code de conexão do WhatsApp Institucional"
                    className="h-52 w-52 object-contain"
                  />
                </div>
              )}

              <div className="space-y-2.5 text-center sm:text-left">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Aguardando leitura no aplicativo WhatsApp...
                </div>

                {pairingCode && (
                  <div className="space-y-1">
                    <p className="text-xs text-slate-500">Código de pareamento por número:</p>
                    <p className="text-xl font-bold font-mono tracking-widest text-slate-900 bg-slate-100 border border-slate-200 px-4 py-2 rounded-xl inline-block">
                      {pairingCode}
                    </p>
                  </div>
                )}

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => void handleGenerateQr(true)}
                    disabled={connecting}
                    className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', connecting && 'animate-spin')} />
                    Gerar novo código
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
