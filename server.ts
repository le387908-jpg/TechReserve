/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WhatsAppProxyBody {
  to?: string;
  message?: string;
  eventType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Remove caracteres não numéricos e garante o DDI 55 (Brasil) quando aplicável.
 */
function sanitizePhoneForProvider(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    return `55${digits}`;
  }
  return digits;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '256kb' }));

  // Endpoint de diagnóstico de integração (não expõe chaves nem tokens)
  app.get('/api/whatsapp/status', (_req, res) => {
    const apiUrl = (process.env.WHATSAPP_API_URL || process.env.VITE_WHATSAPP_API_URL || '').trim();
    const provider = (
      process.env.WHATSAPP_PROVIDER ||
      process.env.VITE_WHATSAPP_PROVIDER ||
      'WEBHOOK'
    )
      .trim()
      .toUpperCase();
    res.json({
      configured: Boolean(apiUrl),
      provider,
    });
  });

  // Rota proxy server-side para envio de mensagens via API HTTP / Webhook do WhatsApp
  app.post('/api/whatsapp/send', async (req, res) => {
    const body = (req.body || {}) as WhatsAppProxyBody;
    const sanitizedTo = sanitizePhoneForProvider(body.to || '');
    const message = String(body.message || '').trim();
    const eventType = String(body.eventType || 'GENERIC_NOTIFICATION').trim();

    if (!sanitizedTo || sanitizedTo.length < 12 || sanitizedTo.length > 15) {
      res.status(400).json({
        success: false,
        error: 'Número de telefone inválido para envio via WhatsApp.',
      });
      return;
    }

    if (!message || message.length > 4096) {
      res.status(400).json({
        success: false,
        error: 'Conteúdo da mensagem ausente ou acima do limite permitido.',
      });
      return;
    }

    const apiUrl = (process.env.WHATSAPP_API_URL || process.env.VITE_WHATSAPP_API_URL || '').trim();
    const apiToken = (process.env.WHATSAPP_API_TOKEN || '').trim();
    const provider = (
      process.env.WHATSAPP_PROVIDER ||
      process.env.VITE_WHATSAPP_PROVIDER ||
      'WEBHOOK'
    )
      .trim()
      .toUpperCase();
    const timestamp = Date.now();

    // Caso a URL do provedor externo ainda não esteja configurada no ambiente,
    // opera em modo homologação/auditoria sem quebrar o fluxo de reservas.
    if (!apiUrl) {
      res.status(200).json({
        success: true,
        delivered: false,
        mode: 'SIMULATED_NO_WEBHOOK_URL',
        provider,
        to: sanitizedTo,
        eventType,
        timestamp,
      });
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
        headers.apikey = apiToken;
      }

      let outboundPayload: Record<string, unknown>;

      if (provider === 'META_CLOUD') {
        outboundPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: sanitizedTo,
          type: 'text',
          text: {
            preview_url: false,
            body: message,
          },
        };
      } else if (provider === 'EVOLUTION') {
        outboundPayload = {
          number: sanitizedTo,
          text: message,
        };
      } else {
        outboundPayload = {
          to: sanitizedTo,
          message,
          eventType,
          source: 'TechReserve',
          timestamp,
          metadata: body.metadata || {},
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let upstreamResponse = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(outboundPayload),
        signal: controller.signal,
      });

      let responseText = await upstreamResponse.text();

      // Compatibilidade automática com Evolution API v1 caso a instância exija `textMessage.text`
      if (
        !upstreamResponse.ok &&
        upstreamResponse.status === 400 &&
        provider === 'EVOLUTION' &&
        responseText.includes('textMessage')
      ) {
        upstreamResponse = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            number: sanitizedTo,
            options: { delay: 500, presence: 'composing' },
            textMessage: { text: message },
          }),
          signal: controller.signal,
        });
        responseText = await upstreamResponse.text();
      }

      clearTimeout(timeout);

      if (!upstreamResponse.ok) {
        res.status(502).json({
          success: false,
          delivered: false,
          provider,
          status: upstreamResponse.status,
          error: `Falha no provedor WhatsApp (${upstreamResponse.status})`,
          details: responseText.slice(0, 300),
        });
        return;
      }

      res.status(200).json({
        success: true,
        delivered: true,
        mode: 'LIVE_WEBHOOK',
        provider,
        to: sanitizedTo,
        eventType,
        timestamp,
      });
    } catch (err) {
      res.status(502).json({
        success: false,
        delivered: false,
        provider,
        error: err instanceof Error ? err.message : 'Erro de comunicação com o provedor WhatsApp.',
      });
    }
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
  });
}

startServer();
