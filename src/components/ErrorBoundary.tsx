/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { getFriendlyErrorMessage } from '../services/firebase/utils';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Título opcional exibido no cabeçalho do card de recuperação */
  title?: string;
  /** Chave opcional (ex: location.pathname) para resetar o estado de erro automaticamente ao navegar */
  resetKey?: string;
  /** Define se o fallback ocupa a tela inteira (global) ou apenas a área de conteúdo da rota */
  variant?: 'fullscreen' | 'inline';
  onReset?: () => void;
  onGoHome?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary global e de rotas para o TechReserve.
 * Evita travamentos de "tela branca" quando ocorrem exceções inesperadas em tempo de execução,
 * exibindo um alerta amigável com ações de recuperação imediata.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  declare props: Readonly<ErrorBoundaryProps>;
  declare setState: (
    updater:
      | Partial<ErrorBoundaryState>
      | ((prevState: ErrorBoundaryState) => Partial<ErrorBoundaryState>)
  ) => void;
  state: ErrorBoundaryState;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error: error instanceof Error ? error : new Error(String(error ?? 'Erro desconhecido')),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[TechReserve ErrorBoundary] Erro capturado em tempo de execução:', {
      message: error?.message,
      stack: error?.stack,
      componentStack: errorInfo?.componentStack,
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      try {
        this.props.onReset();
      } catch (err) {
        console.error('[TechReserve ErrorBoundary] Erro ao executar onReset:', err);
      }
    }
  };

  private handleGoHome = (): void => {
    this.setState({ hasError: false, error: null });
    if (this.props.onGoHome) {
      try {
        this.props.onGoHome();
        return;
      } catch (err) {
        console.error('[TechReserve ErrorBoundary] Erro ao navegar via onGoHome:', err);
      }
    }
    try {
      window.location.assign('/');
    } catch {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const isFullscreen = this.props.variant !== 'inline';
    const headingTitle =
      this.props.title || 'Algo inesperado aconteceu nesta visualização';
    const friendlyDetail = getFriendlyErrorMessage(
      this.state.error,
      'Não foi possível exibir esta tela no momento. Seus dados continuam seguros.'
    );

    return (
      <div
        role="alert"
        aria-live="assertive"
        className={
          isFullscreen
            ? 'min-h-screen w-full bg-slate-50 flex items-center justify-center p-6 font-sans'
            : 'min-h-[60vh] w-full flex items-center justify-center p-6 font-sans'
        }
      >
        <div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center text-fatec-red shrink-0">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="space-y-1.5 min-w-0">
              <h2 className="text-lg font-bold text-slate-900 leading-snug">
                {headingTitle}
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                O sistema interrompeu a renderização desta seção para evitar inconsistências. Você pode tentar carregar novamente ou voltar para a página inicial.
              </p>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600 leading-relaxed break-words">
            <span className="font-semibold text-slate-800">Detalhe: </span>
            {friendlyDetail}
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-1">
            <button
              type="button"
              onClick={this.handleRetry}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fatec-red hover:bg-red-700 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-4 w-4 shrink-0" />
              Tentar Novamente
            </button>

            <button
              type="button"
              onClick={this.handleGoHome}
              className="flex-1 px-4 py-2.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Home className="h-4 w-4 shrink-0" />
              Voltar ao Início
            </button>
          </div>
        </div>
      </div>
    );
  }
}
