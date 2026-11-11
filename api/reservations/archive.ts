/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { processServerReservationArchive } from '../_server/archiveHandler.ts';

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Allow', 'POST');
    res.end(JSON.stringify({ success: false, message: 'Método não permitido. Utilize POST.' }));
    return;
  }

  let body = req.body;
  if (typeof body === 'undefined') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
  }

  const result = await processServerReservationArchive({
    headers: req.headers as Record<string, string | string[] | undefined>,
    body,
    socket: req.socket,
  });

  res.statusCode = result.httpStatus;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(result.body));
}
