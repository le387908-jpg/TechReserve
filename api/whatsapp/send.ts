import { WhatsAppProxyBody, dispatchWhatsAppMessage } from '../../server/whatsappGateway';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const body = (
    typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
  ) as WhatsAppProxyBody;
  const { httpStatus, payload } = await dispatchWhatsAppMessage(body);
  res.status(httpStatus).json(payload);
}
