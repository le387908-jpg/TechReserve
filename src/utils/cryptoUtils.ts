/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gera um salt aleatório criptograficamente seguro em hexadecimal.
 */
export function generateSaltHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Calcula hash SHA-256 em hexadecimal usando Web Crypto API (`crypto.subtle`).
 */
export async function sha256Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  throw new Error('Ambiente navegador sem suporte a Web Crypto SHA-256.');
}

/**
 * Calcula o hash SHA-256 com salt para o código administrativo (`${salt}:${code}`),
 * idêntico ao algoritmo de verificação server-side em `server/controllers/reservationController.ts`.
 */
export async function hashSaltedAdminCode(code: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${code}`);
}

/**
 * Gera máscara segura exibindo apenas os 2 últimos caracteres.
 */
export function maskSecretCode(code: string): string {
  const clean = String(code || '').trim();
  if (clean.length <= 2) return '******';
  return `${'*'.repeat(Math.max(4, clean.length - 2))}${clean.slice(-2)}`;
}
