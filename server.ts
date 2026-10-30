/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  WhatsAppProxyBody,
  connectGatewayInstance,
  disconnectGatewayInstance,
  dispatchWhatsAppMessage,
  getGatewayStatus,
  pingEvolutionKeepAlive,
} from './server/whatsappGateway.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEEP_ALIVE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutos para evitar hibernação da API WhatsApp

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '256kb' }));

  // Intercepta JSON malformado antes de retornar página HTML de erro do Express
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({ success: false, error: 'Payload JSON inválido.' });
        return;
      }
      next(err);
    }
  );

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Endpoint de diagnóstico e status da instância WhatsApp (não expõe chaves nem tokens)
  app.get('/api/whatsapp/status', async (req, res) => {
    try {
      const instanceName = typeof req.query?.instance === 'string' ? req.query.instance : undefined;
      const status = await getGatewayStatus(instanceName);
      res.status(200).json(status);
    } catch (err) {
      console.error('[Server] Erro em GET /api/whatsapp/status:', err);
      res.status(500).json({
        configured: false,
        provider: 'EVOLUTION',
        connected: false,
        state: 'close',
        message: 'Erro interno ao consultar status do WhatsApp.',
      });
    }
  });

  // Endpoint administrativo para criar/conectar instância WhatsApp e obter QR Code / Código de Pareamento
  app.post('/api/whatsapp/connect', async (req, res) => {
    try {
      const { phone, forceRecreate, instanceName } = (req.body || {}) as {
        phone?: string;
        forceRecreate?: boolean;
        instanceName?: string;
      };
      const result = await connectGatewayInstance({ phone, forceRecreate, instanceName });
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      console.error('[Server] Erro em POST /api/whatsapp/connect:', err);
      res.status(500).json({
        success: false,
        connected: false,
        state: 'close',
        error: 'Erro interno ao processar conexão do WhatsApp.',
      });
    }
  });

  // Endpoint administrativo para desconectar sessão atual do WhatsApp institucional
  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      const { instanceName } = (req.body || {}) as { instanceName?: string };
      const result = await disconnectGatewayInstance(instanceName);
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      console.error('[Server] Erro em POST /api/whatsapp/disconnect:', err);
      res.status(500).json({
        success: false,
        message: 'Erro interno ao desconectar sessão do WhatsApp.',
      });
    }
  });

  // Rota proxy server-side para envio de mensagens via Evolution API / Meta Cloud / Webhook
  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const body = (req.body || {}) as WhatsAppProxyBody;
      const { httpStatus, payload } = await dispatchWhatsAppMessage(body);
      res.status(httpStatus).json(payload);
    } catch (err) {
      console.error('[Server] Erro em POST /api/whatsapp/send:', err);
      res.status(500).json({
        success: false,
        delivered: false,
        error: 'Erro interno no serviço de envio do WhatsApp.',
      });
    }
  });

  // Integração Vite em desenvolvimento vs arquivos estáticos em produção
  const distPath = path.join(__dirname, 'dist');
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start';

  if (isProduction) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Faz o bind da porta 3000 imediatamente e aguarda a inicialização do Vite nas primeiras requisições,
    // evitando timeout de inicialização em cold-start do container.
    let viteMiddleware: express.RequestHandler | null = null;
    const viteReady = (async () => {
      const { createServer: createViteServer } = await import('vite');
      const hmrEnabled = process.env.DISABLE_HMR !== 'true';
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: hmrEnabled ? { server: httpServer } : false,
        },
        appType: 'spa',
      });
      viteMiddleware = vite.middlewares;
    })();

    viteReady.catch((err) => {
      console.error('Failed to initialize Vite middleware:', err);
    });

    app.use(async (req, res, next) => {
      try {
        if (!viteMiddleware) {
          await viteReady;
        }
        if (viteMiddleware) {
          return viteMiddleware(req, res, next);
        }
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TechReserve server running on http://0.0.0.0:${PORT}`);
    setTimeout(() => {
      void pingEvolutionKeepAlive();
    }, 3000);
    setInterval(() => {
      void pingEvolutionKeepAlive();
    }, KEEP_ALIVE_INTERVAL_MS);
  });
}

startServer();
