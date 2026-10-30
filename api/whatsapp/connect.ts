import { connectGatewayInstance } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    let body: Record<string, any> = {};
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body || '{}') || {};
      } catch {
        res.status(400).json({ success: false, error: 'Payload JSON inválido.' });
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    const result = await connectGatewayInstance({
      phone: body.phone,
      forceRecreate: Boolean(body.forceRecreate),
      instanceName: typeof body.instanceName === 'string' ? body.instanceName : undefined,
    });
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error('[API] Erro em /api/whatsapp/connect:', err);
    res.status(500).json({
      success: false,
      connected: false,
      state: 'close',
      error: 'Erro interno ao conectar instância do WhatsApp.',
    });
  }
}
