/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { auth, ensureTabIsolationReady } from './firebase/config';

/**
 * Obtém o Firebase ID Token atualizado da aba atual e monta os cabeçalhos HTTP autenticados.
 */
export async function buildAuthenticatedJsonHeaders(): Promise<Record<string, string>> {
  await ensureTabIsolationReady();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      const idToken = await currentUser.getIdToken();
      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }
    } catch (err) {
      console.warn('[ApiClient] Falha ao obter ID token da sessão atual:', err);
    }
  }

  return headers;
}

/**
 * Calcula o hash SHA-256 determinístico para o `code-auth` no navegador (Web Crypto API)
 * usando o mesmo domínio de separação do servidor (`TECHRESERVE_ADMIN_CODE_V2:`),
 * impedindo armazenamento do código em texto puro no Firestore.
 */
export async function computeAdminCodeHashClient(rawCode: string): Promise<string> {
  const normalized = `TECHRESERVE_ADMIN_CODE_V2:${String(rawCode || '').trim()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const digestBuffer = await crypto.subtle.digest('SHA-256', data);
  const byteArray = Array.from(new Uint8Array(digestBuffer));
  return byteArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
