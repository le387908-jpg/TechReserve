/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
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
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '256kb' }));

  // Endpoint de diagnóstico e status da instância WhatsApp (não expõe chaves nem tokens)
  app.get('/api/whatsapp/status', async (req, res) => {
    const instanceName = typeof req.query.instance === 'string' ? req.query.instance : undefined;
    const status = await getGatewayStatus(instanceName);
    res.status(200).json(status);
  });

  // Endpoint administrativo para criar/conectar instância WhatsApp e obter QR Code / Código de Pareamento
  app.post('/api/whatsapp/connect', async (req, res) => {
    const { phone, forceRecreate, instanceName } = (req.body || {}) as {
      phone?: string;
      forceRecreate?: boolean;
      instanceName?: string;
    };
    const result = await connectGatewayInstance({ phone, forceRecreate, instanceName });
    res.status(result.success ? 200 : 502).json(result);
  });

  // Endpoint administrativo para desconectar sessão atual do WhatsApp institucional
  app.post('/api/whatsapp/disconnect', async (req, res) => {
    const { instanceName } = (req.body || {}) as { instanceName?: string };
    const result = await disconnectGatewayInstance(instanceName);
    res.status(result.success ? 200 : 502).json(result);
  });

  // Rota proxy server-side para envio de mensagens via Evolution API / Meta Cloud / Webhook
  app.post('/api/whatsapp/send', async (req, res) => {
    const body = (req.body || {}) as WhatsAppProxyBody;
    const { httpStatus, payload } = await dispatchWhatsAppMessage(body);
    res.status(httpStatus).json(payload);
  });

  // Integração Vite em desenvolvimento vs arquivos estáticos em produção
  const distPath = path.join(__dirname, 'dist');
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TechReserve server running on http://0.0.0.0:${PORT}`);
    // Aquece imediatamente o gateway externo e mantém keep-alive periódico
    void pingEvolutionKeepAlive();
    setInterval(() => {
      void pingEvolutionKeepAlive();
    }, KEEP_ALIVE_INTERVAL_MS);
  });
}

startServer();
