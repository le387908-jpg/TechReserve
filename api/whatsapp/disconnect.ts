import { disconnectGatewayInstance } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    let body: Record<string, any> = {};
    if (typeof req.body === 'string' && req.body.trim()) {
      try {
        body = JSON.parse(req.body) || {};
      } catch {
        body = {};
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    const instanceName = typeof body.instanceName === 'string' ? body.instanceName : undefined;
    const result = await disconnectGatewayInstance(instanceName);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error('[API] Erro em /api/whatsapp/disconnect:', err);
    res.status(500).json({
      success: false,
      message: 'Erro interno ao desconectar sessão do WhatsApp.',
    });
  }
}
