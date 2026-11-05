import { processServerQrCheckIn } from '../_server/checkInHandler.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  const result = await processServerQrCheckIn(req);
  res.setHeader?.('Cache-Control', 'no-store');
  res.status(result.httpStatus).json(result.body);
}
