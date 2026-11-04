export default function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({ ok: true, serverTime: Date.now() });
}
