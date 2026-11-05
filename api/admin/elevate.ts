import { processAdminRegistration } from '../_server/adminAuthHandler.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method Not Allowed' });
    return;
  }

  const result = await processAdminRegistration(req);
  res.setHeader?.('Cache-Control', 'no-store');
  res.status(result.httpStatus).json(result.body);
}
