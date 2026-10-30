import { getGatewayStatus } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const instanceName =
      typeof req.query?.instance === 'string' ? req.query.instance : undefined;
    const status = await getGatewayStatus(instanceName);
    res.status(200).json(status);
  } catch (err) {
    console.error('[API] Erro em /api/whatsapp/status:', err);
    res.status(500).json({
      configured: false,
      provider: 'EVOLUTION',
      connected: false,
      state: 'close',
      message: 'Erro interno ao consultar status do WhatsApp.',
    });
  }
}
