/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Camera, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export function CameraPermissionGuard({ children }: { children: React.ReactNode }) {
  const [permissionState, setPermissionState] = useState<'prompt' | 'granted' | 'denied' | 'checking'>('checking');
  const [showOverlay, setShowOverlay] = useState(false);

  useEffect(() => {
    checkPermission();
  }, []);

  const checkPermission = async () => {
    try {
      // First check localStorage to see if we've already tried on THIS device
      const hasAsked = localStorage.getItem('camera_permission_asked');

      if (!hasAsked) {
        setShowOverlay(true);
      } else {
        // If already asked, we don't show the GLOBAL guard anymore
        // We let the specific camera-using components handle it
        setShowOverlay(false);
      }

      // Check if the browser supports the Permissions API
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const result = await navigator.permissions.query({ name: 'camera' as any });
          setPermissionState(result.state as any);
          
          // Only force show if NOT asked yet
          if (!hasAsked && (result.state === 'prompt' || result.state === 'denied')) {
            setShowOverlay(true);
          }

          result.onchange = () => {
            setPermissionState(result.state as any);
            if (result.state === 'granted') {
              setShowOverlay(false);
            }
          };
        } catch (e) {
          // Fallback if query({ name: 'camera' }) is not supported
          if (!hasAsked) {
            setPermissionState('prompt');
            setShowOverlay(true);
          }
        }
      }
    } catch (error: any) {
      console.error('Error checking camera permission:', error?.message || String(error));
      const hasAsked = localStorage.getItem('camera_permission_asked');
      if (!hasAsked) {
        setPermissionState('prompt');
        setShowOverlay(true);
      }
    }
  };

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // If we get here, permission was granted
      stream.getTracks().forEach(track => track.stop()); // Stop the stream immediately
      setPermissionState('granted');
      setShowOverlay(false);
      localStorage.setItem('camera_permission_asked', 'true');
    } catch (error) {
      setPermissionState('denied');
      localStorage.setItem('camera_permission_asked', 'true');
    }
  };

  if (permissionState === 'checking' && !showOverlay) {
    return null;
  }

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
                      <p className="text-xs text-red-600">Você bloqueou o acesso à câmera. Por favor, habilite nas configurações do seu navegador para continuar.</p>
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
                    onClick={() => setShowOverlay(false)}
                    className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase tracking-widest transition-all active:scale-95 shadow-xl shadow-slate-200"
                  >
                    Entrar no App
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    onClick={requestPermission}
                    className="w-full bg-fatec-red text-white py-4 rounded-2xl font-black uppercase tracking-widest transition-all active:scale-95 shadow-xl shadow-red-200 flex items-center justify-center gap-3"
                  >
                    <Camera className="h-5 w-5" />
                    Permitir Acesso
                  </button>
                  <button
                    onClick={() => {
                      setPermissionState('denied');
                      localStorage.setItem('camera_permission_asked', 'true');
                    }}
                    className="w-full py-2 text-slate-400 font-bold uppercase tracking-widest text-[10px]"
                  >
                    Negar
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
