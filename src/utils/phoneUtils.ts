/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyPhoneMask,
  extractPhoneDigits,
  formatPhone,
  getPhoneValidationMessage,
  isValidPhone,
  sanitizePhone,
  validatePhone,
} from './formatters';

export {
  applyPhoneMask,
  extractPhoneDigits,
  formatPhone,
  getPhoneValidationMessage,
  isValidPhone,
  sanitizePhone,
  validatePhone,
};

export interface PhoneValidationResult {
  isValid: boolean;
  sanitized: string; // Ex: "11912345678"
  formatted: string; // Ex: "(11) 91234-5678"
  apiNumber: string; // Ex: "5511912345678"
  error?: string;
}

/**
 * Remove todos os caracteres não numéricos de uma string de telefone,
 * limitando aos 11 dígitos nacionais (DDD + 9 dígitos).
 */
export function stripPhoneMask(rawValue: string | undefined | null): string {
  return sanitizePhone(rawValue);
}

/**
 * Aplica a máscara '(00) 00000-0000' em números de telefone / WhatsApp.
 */
export function formatPhoneMask(rawValue: string | undefined | null): string {
  return formatPhone(rawValue);
}

/**
 * Formata o número sanitizado para envio em APIs HTTP / Webhooks do WhatsApp (padrão DDI + DDD + 9 dígitos).
 * Exemplo: "(11) 91234-5678" -> "5511912345678"
 */
export function toWhatsAppApiPhone(
  rawValue: string | undefined | null,
  defaultCountryCode = '55'
): string {
  const nationalDigits = sanitizePhone(rawValue);
  if (nationalDigits.length !== 11) return '';
  return `${defaultCountryCode}${nationalDigits}`;
}

/**
 * Valida detalhadamente um número de telefone/WhatsApp utilizando a função booleana de 11 dígitos (`isValidPhone`).
 */
export function validatePhoneNumber(rawValue: string | undefined | null): PhoneValidationResult {
  const isValid = isValidPhone(rawValue);
  const sanitized = sanitizePhone(rawValue);
  const formatted = formatPhone(sanitized);

  if (!isValid) {
    return {
      isValid: false,
      sanitized,
      formatted,
      apiNumber: '',
      error: getPhoneValidationMessage(rawValue),
    };
  }

  return {
    isValid: true,
    sanitized,
    formatted,
    apiNumber: toWhatsAppApiPhone(sanitized),
  };
}
