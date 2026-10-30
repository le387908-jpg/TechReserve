/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Camera, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

function safeGetLocalFlag(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSetLocalFlag(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignora bloqueios de armazenamento em abas privadas ou iframes restritos
  }
}

export function CameraPermissionGuard({ children }: { children: React.ReactNode }) {
  const [permissionState, setPermissionState] = useState<'prompt' | 'granted' | 'denied' | 'checking'>('checking');
  const [showOverlay, setShowOverlay] = useState(false);

  useEffect(() => {
    void checkPermission();
  }, []);

  const checkPermission = async () => {
    const hasAsked = safeGetLocalFlag('camera_permission_asked');

    try {
      if (!hasAsked) {
        setShowOverlay(true);
      } else {
        setShowOverlay(false);
      }

      if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
        try {
          const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
          setPermissionState(result.state as 'prompt' | 'granted' | 'denied');

          if (result.state === 'granted') {
            setShowOverlay(false);
          } else if (!hasAsked && (result.state === 'prompt' || result.state === 'denied')) {
            setShowOverlay(true);
          }

          result.onchange = () => {
            setPermissionState(result.state as 'prompt' | 'granted' | 'denied');
            if (result.state === 'granted') {
              setShowOverlay(false);
            }
          };
          return;
        } catch {
          setPermissionState(hasAsked ? 'granted' : 'prompt');
          if (!hasAsked) {
            setShowOverlay(true);
          }
          return;
        }
      }

      setPermissionState(hasAsked ? 'granted' : 'prompt');
    } catch (error: unknown) {
      console.error('Error checking camera permission:', error);
      setPermissionState(hasAsked ? 'granted' : 'prompt');
      if (!hasAsked) {
        setShowOverlay(true);
      }
    }
  };

  const requestPermission = async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('Navegador sem suporte direto a getUserMedia.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermissionState('granted');
      setShowOverlay(false);
      safeSetLocalFlag('camera_permission_asked', 'true');
    } catch {
      setPermissionState('denied');
      safeSetLocalFlag('camera_permission_asked', 'true');
    }
  };

  return (
    <>
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              className="bg-white rounded-[2rem] p-8 max-w-md w-full shadow-2xl text-center"
            >
              <div className="w-20 h-20 bg-fatec-red/10 rounded-3xl flex items-center justify-center mx-auto mb-6 text-fatec-red">
                <Camera className="h-10 w-10" />
              </div>

              <h2 className="text-2xl font-black text-slate-900 mb-3 tracking-tight">
                Permissão de Câmera
              </h2>

              <p className="text-slate-500 mb-8 leading-relaxed">
                Para utilizar o sistema de reservas e realizar o check-in via QR Code, precisamos de acesso à câmera do seu dispositivo.
              </p>

              <div className="space-y-4 mb-8">
                <div className="flex items-start gap-3 text-left bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <ShieldCheck className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-slate-800">Segurança Garantida</p>
                    <p className="text-xs text-slate-500">A câmera só será ativada quando você solicitar explicitamente o check-in.</p>
                  </div>
                </div>

                {permissionState === 'denied' && (
                  <div className="flex items-start gap-3 text-left bg-red-50 p-4 rounded-2xl border border-red-100">
                    <AlertCircle className="h-5 w-5 text-fatec-red shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-red-800">Acesso Negado</p>
                      <p className="text-xs text-red-600">Você bloqueou o acesso à câmera. Você pode continuar navegando normalmente e habilitar depois caso precise ler um QR Code.</p>
                    </div>
                  </div>
                )}
              </div>

              {permissionState === 'granted' ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2 text-emerald-600 font-bold mb-4">
                    <CheckCircle2 className="h-5 w-5" />
                    Permissão Concedida!
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowOverlay(false)}
                    className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase tracking-widest transition-all active:scale-95 shadow-xl shadow-slate-200 cursor-pointer"
                  >
                    Entrar no App
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={requestPermission}
                    className="w-full bg-fatec-red text-white py-4 rounded-2xl font-black uppercase tracking-widest transition-all active:scale-95 shadow-xl shadow-red-200 flex items-center justify-center gap-3 cursor-pointer"
                  >
                    <Camera className="h-5 w-5" />
                    Permitir Acesso
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPermissionState('denied');
                      safeSetLocalFlag('camera_permission_asked', 'true');
                      setShowOverlay(false);
                    }}
                    className="w-full py-2 text-slate-500 hover:text-slate-700 font-bold uppercase tracking-widest text-[10px] cursor-pointer"
                  >
                    Continuar sem câmera por agora
                  </button>
                </div>
              )}

              <p className="mt-6 text-[10px] text-slate-400 font-medium uppercase tracking-[0.2em]">
                Ambiente Seguro &middot; TechReserve
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </>
  );
}
