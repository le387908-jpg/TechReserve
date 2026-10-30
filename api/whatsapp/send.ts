import { WhatsAppProxyBody, dispatchWhatsAppMessage } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    let body: WhatsAppProxyBody = {};
    if (typeof req.body === 'string') {
      try {
        body = (JSON.parse(req.body || '{}') || {}) as WhatsAppProxyBody;
      } catch {
        res.status(400).json({ success: false, delivered: false, error: 'Payload JSON inválido.' });
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body as WhatsAppProxyBody;
    }

    const { httpStatus, payload } = await dispatchWhatsAppMessage(body);
    res.status(httpStatus).json(payload);
  } catch (err) {
    console.error('[API] Erro em /api/whatsapp/send:', err);
    res.status(500).json({
      success: false,
      delivered: false,
      error: 'Erro interno no serviço de envio do WhatsApp.',
    });
  }
}
