/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { pingEvolutionKeepAlive } from './server/whatsappGateway.ts';
import {
  handleProtectedWhatsAppConnect,
  handleProtectedWhatsAppDisconnect,
  handleProtectedWhatsAppSend,
  handleProtectedWhatsAppStatus,
} from './server/whatsappHttpHandlers.ts';
import { processServerQrCheckIn } from './server/checkInHandler.ts';
import { processAdminRegistration } from './server/adminAuthHandler.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEEP_ALIVE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutos para evitar hibernação da API externa em execução contínua

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Cabeçalhos básicos de proteção HTTP
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

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

  // Healthcheck de conectividade real e sincronização de relógio oficial do servidor
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({ ok: true, serverTime: Date.now() });
  });

  // Endpoint seguro de validação presencial de check-in via QR Code
  app.post('/api/checkin', async (req, res) => {
    const result = await processServerQrCheckIn(req);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.httpStatus).json(result.body);
  });

  // Endpoint seguro de validação de credencial administrativa (code-auth) no cadastro
  app.post('/api/admin/register', async (req, res) => {
    const result = await processAdminRegistration(req);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.httpStatus).json(result.body);
  });

  // Rotas WhatsApp autenticadas com Firebase ID Token, RBAC e Rate Limiting
  app.get('/api/whatsapp/status', async (req, res) => {
    await handleProtectedWhatsAppStatus(req, res);
  });

  app.post('/api/whatsapp/connect', async (req, res) => {
    await handleProtectedWhatsAppConnect(req, res);
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    await handleProtectedWhatsAppDisconnect(req, res);
  });

  app.post('/api/whatsapp/send', async (req, res) => {
    await handleProtectedWhatsAppSend(req, res);
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
