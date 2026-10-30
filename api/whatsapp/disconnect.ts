import { disconnectGatewayInstance } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const result = await disconnectGatewayInstance();
  res.status(result.success ? 200 : 502).json(result);
}
