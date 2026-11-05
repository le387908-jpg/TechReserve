import { handleProtectedWhatsAppStatus } from '../_server/whatsappHttpHandlers.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  await handleProtectedWhatsAppStatus(req, res);
}
