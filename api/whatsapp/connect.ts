import { handleProtectedWhatsAppConnect } from '../../server/whatsappHttpHandlers';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  await handleProtectedWhatsAppConnect(req, res);
}
