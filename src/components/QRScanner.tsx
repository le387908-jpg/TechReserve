/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { X, CameraOff, AlertCircle, Camera, Loader2, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { useCheckInStore } from '../store/useCheckInStore';

interface QRScannerProps {
  onScan?: (data: string) => void;
  onClose: () => void;
}

type ScannerStatus = 'CONSENT' | 'SCANNING' | 'DENIED' | 'LOADING' | 'EVALUATING' | 'SUCCESS' | 'ERROR';

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [status, setStatus] = useState<ScannerStatus>('LOADING');
  const [error, setError] = useState<string | null>(null);
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const containerId = "qr-reader-strict";
  const currentScanIdRef = useRef<string | null>(null);
  
  const { processCheckIn, message, isProcessing, clearMessage } = useCheckInStore();

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    
    const checkInitialPermission = async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const result = await navigator.permissions.query({ name: 'camera' as any });
          if (!isMountedRef.current) return;
          if (result.state === 'granted') {
            startScanning();
          } else {
            setStatus('CONSENT');
          }
        } else {
          if (!isMountedRef.current) return;
          setStatus('CONSENT');
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setStatus('CONSENT');
      }
    };
    
    checkInitialPermission();
    return () => {
      isMountedRef.current = false;
      clearMessage();
    };
  }, []);

  const handleScan = async (decodedText: string) => {
    if (processingRef.current) return;

    processingRef.current = true;
    setStatus('EVALUATING');

    await stopScanner();

    try {
      const success = await processCheckIn(decodedText);

      if (!isMountedRef.current) return;

      if (success) {
        setStatus('SUCCESS');
        if (onScan) onScan(decodedText);
        setTimeout(() => {
          if (isMountedRef.current) {
            onClose();
          }
        }, 2500);
      } else {
        const errorMsg = useCheckInStore.getState()?.message?.text || 'Código inválido para check-in.';
        setError(errorMsg);
        setStatus('ERROR');
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      const errMsg = err instanceof Error ? err.message : 'Erro ao processar o check-in.';
      setError(errMsg);
      setStatus('ERROR');
    }
  };

  const startScanning = async () => {
    const scanId = Math.random().toString();
    currentScanIdRef.current = scanId;

    setStatus('LOADING');
    setError(null);
    clearMessage();
    processingRef.current = false;

    // Ensure previous instance is cleaned up
    await stopScanner(false); // don't clear currentScanIdRef inside nested stop

    // Extra guard: clean up inner HTML of the container to clear any lingering duplicate videos
    const container = document.getElementById(containerId);
    if (container) {
      container.innerHTML = "";
    }

    try {
      if (!isMountedRef.current || currentScanIdRef.current !== scanId) return;
      const cameras = await Html5Qrcode.getCameras();
      
      if (!isMountedRef.current || currentScanIdRef.current !== scanId) return;

      if (!cameras || cameras.length === 0) {
        throw new Error("Nenhuma câmera encontrada no dispositivo.");
      }

      const html5QrCode = new Html5Qrcode(containerId);
      
      if (!isMountedRef.current || currentScanIdRef.current !== scanId) {
        html5QrCode.clear();
        return;
      }

      qrScannerRef.current = html5QrCode;

      await html5QrCode.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        handleScan,
        () => {}
      );
      
      if (!isMountedRef.current || currentScanIdRef.current !== scanId) {
        await stopScanner(false);
        return;
      }

      try {
        localStorage.setItem('camera_permission_asked', 'true');
      } catch {
        // Ignora bloqueios de armazenamento
      }
      setStatus('SCANNING');
    } catch (err: unknown) {
      if (!isMountedRef.current || currentScanIdRef.current !== scanId) return;
      const errMessage = err instanceof Error ? err.message : String(err ?? '');
      console.error('Erro ao iniciar scanner:', errMessage);
      const lowerErr = errMessage.toLowerCase();
      if (lowerErr.includes('denied') || lowerErr.includes('not allowed')) {
        setStatus('DENIED');
        setError('O acesso à câmera é obrigatório para validar sua presença.');
      } else {
        setError(errMessage || 'Erro desconhecido ao acessar a câmera.');
        setStatus('DENIED');
      }
    }
  };

  const stopScanner = async (resetScanId = true) => {
    if (resetScanId) {
      currentScanIdRef.current = null;
    }
    if (qrScannerRef.current) {
      try {
        if (qrScannerRef.current.isScanning) {
          await qrScannerRef.current.stop();
        }
        qrScannerRef.current.clear();
      } catch (err: any) {
        console.error("Erro ao parar scanner:", err?.message || String(err));
      } finally {
        qrScannerRef.current = null;
      }
    }
    // Also clean up inner HTML to guarantee no duplicate DOM camera feeds are left
    const container = document.getElementById(containerId);
    if (container) {
      container.innerHTML = "";
    }
  };

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md">
      <div className="relative w-full max-w-md bg-white rounded-[2.5rem] overflow-hidden shadow-2xl border border-white/20">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-fatec-red/10 rounded-xl flex items-center justify-center text-fatec-red">
              <Camera className="h-5 w-5" />
            </div>
            <h3 className="font-black text-slate-900 uppercase italic tracking-tighter">Check-in Presencial</h3>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 transition-colors">
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-8">
          {status === 'CONSENT' && (
            <div className="text-center space-y-6">
              <div className="p-6 bg-blue-50 rounded-3xl border border-blue-100">
                <Camera className="h-12 w-12 text-blue-500 mx-auto mb-4" />
                <p className="text-slate-700 font-bold leading-relaxed">
                  Precisamos acessar sua câmera para realizar o check-in das reservas.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={startScanning}
                  className="w-full py-4 bg-fatec-red text-white rounded-2xl font-black uppercase tracking-widest text-sm shadow-lg shadow-red-100 hover:scale-[1.02] active:scale-95 transition-all"
                >
                  Permitir Acesso
                </button>
                <button
                  onClick={() => {
                    setStatus('DENIED');
                    setError("O acesso à câmera é obrigatório para validar sua presença.");
                  }}
                  className="w-full py-2 text-slate-400 font-bold uppercase tracking-widest text-[10px]"
                >
                  Negar
                </button>
              </div>
            </div>
          )}

          {/* Persistent Scanner Container Area */}
          {(status === 'LOADING' || status === 'SCANNING' || status === 'EVALUATING' || status === 'ERROR') && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div className="relative">
                <div
                  className={`overflow-hidden rounded-3xl border-4 border-slate-900 shadow-inner bg-black min-h-[250px] transition-opacity duration-300 ${
                    status === 'LOADING' || status === 'ERROR'
                      ? 'opacity-20'
                      : status === 'EVALUATING'
                      ? 'opacity-50'
                      : 'opacity-100'
                  }`}
                >
                  <div id={containerId} />
                </div>
                
                {status === 'LOADING' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
                    <Loader2 className="h-12 w-12 text-fatec-red animate-spin" />
                    <p className="text-slate-500 font-black uppercase italic tracking-widest text-xs">
                      Iniciando câmera...
                    </p>
                  </div>
                )}

                {status === 'EVALUATING' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/20 backdrop-blur-[2px] rounded-2xl">
                    <div className="bg-white/90 p-4 rounded-2xl shadow-xl flex items-center gap-3">
                      <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                      <span className="text-xs font-black uppercase tracking-widest text-slate-700">Validando...</span>
                    </div>
                  </div>
                )}

                {status === 'ERROR' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-500/10 backdrop-blur-[2px] rounded-2xl">
                    <div className="bg-white p-6 rounded-3xl shadow-2xl border-2 border-fatec-red max-w-[80%] text-center animate-in zoom-in duration-300">
                      <AlertCircle className="h-12 w-12 text-fatec-red mx-auto mb-3" />
                      <p className="text-slate-900 font-black uppercase italic text-sm mb-2">Erro no Check-in</p>
                      <p className="text-slate-600 text-xs font-bold leading-tight">
                        {error || "Código inválido"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              
              <div className="flex flex-col gap-4">
                {status !== 'ERROR' ? (
                  <>
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-3">
                      <AlertCircle className="h-5 w-5 text-fatec-red shrink-0" />
                      <p className="text-[10px] text-slate-500 font-bold leading-tight uppercase tracking-tight">
                        Posicione o código institucional da sala (ex: SALA-006) dentro do visor para confirmar sua presença.
                      </p>
                    </div>

                    <button
                      onClick={onClose}
                      className="w-full py-4 bg-slate-100 text-slate-500 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-slate-200 transition-all flex items-center justify-center gap-2 group"
                    >
                      <X className="h-4 w-4 group-hover:scale-110 transition-transform" />
                      Sair da Câmera
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={startScanning}
                      className="w-full py-4 bg-fatec-red text-white rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-lg shadow-red-100 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                      <Camera className="h-4 w-4" />
                      Tentar Novamente
                    </button>
                    <button
                      onClick={onClose}
                      className="w-full py-3 bg-slate-100 text-slate-500 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-slate-200 transition-all"
                    >
                      Sair do Check-in
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'SUCCESS' && (
            <div className="text-center space-y-6 animate-in fade-in zoom-in duration-300">
              <div className="p-8 bg-emerald-50 rounded-3xl border border-emerald-100">
                <CheckCircle2 className="h-16 w-16 text-emerald-500 mx-auto mb-4" />
                <p className="text-emerald-900 font-black uppercase italic text-lg mb-2">Sucesso!</p>
                <p className="text-emerald-700 font-bold">
                  {message?.text || 'Check-in realizado com sucesso'}
                </p>
              </div>
              <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                Fechando em breve...
              </p>
            </div>
          )}

          {status === 'DENIED' && (
            <div className="text-center space-y-6">
              <div className="p-6 bg-red-50 rounded-3xl border border-red-100">
                <ShieldAlert className="h-12 w-12 text-fatec-red mx-auto mb-4" />
                <p className="text-red-900 font-black uppercase italic text-sm mb-2">Acesso Negado</p>
                <p className="text-red-700 text-sm font-bold">
                  {error || "O acesso à câmera é obrigatório para validar sua presença."}
                </p>
              </div>
              <button
                onClick={startScanning}
                className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-sm shadow-xl hover:bg-slate-800 transition-all"
              >
                Permitir câmera novamente
              </button>
              <button
                onClick={onClose}
                className="w-full py-2 text-slate-400 font-bold uppercase tracking-widest text-[10px]"
              >
                Voltar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
