import { getGatewayStatus } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const instanceName =
    typeof req.query?.instance === 'string' ? req.query.instance : undefined;
  const status = await getGatewayStatus(instanceName);
  res.status(200).json(status);
}
