/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { processServerReservationExpiration } from '../_server/expireHandler.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  const result = await processServerReservationExpiration(req);
  res.setHeader?.('Cache-Control', 'no-store');
  res.status(result.httpStatus).json(result.body);
}
