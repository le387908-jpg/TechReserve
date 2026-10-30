import { connectGatewayInstance } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const result = await connectGatewayInstance({
    phone: body.phone,
    forceRecreate: Boolean(body.forceRecreate),
    instanceName: typeof body.instanceName === 'string' ? body.instanceName : undefined,
  });
  res.status(result.success ? 200 : 502).json(result);
}
