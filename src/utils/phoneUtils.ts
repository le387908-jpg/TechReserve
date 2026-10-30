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
 * Formata o número sanitizado para envio na Evolution API / WhatsApp (padrão DDI + DDD + número, apenas dígitos).
 * Remove parênteses, traços, espaços e sinais '+' garantindo o formato exato `55119XXXXXXXX`.
 */
export function toWhatsAppApiPhone(
  rawValue: string | undefined | null,
  defaultCountryCode = '55'
): string {
  let digits = String(rawValue ?? '').replace(/\D/g, '');
  if (!digits) return '';

  // Remove prefixo nacional '0' eventual antes do DDD (ex.: 011999999999 -> 11999999999)
  if ((digits.length === 11 || digits.length === 12) && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Já possui DDI 55 + DDD + 8 ou 9 dígitos (12 ou 13 dígitos)
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith(defaultCountryCode)) {
    return digits;
  }

  // Possui DDD + 8 ou 9 dígitos nacionais (10 ou 11 dígitos) -> prefixa DDI 55
  if (digits.length === 10 || digits.length === 11) {
    return `${defaultCountryCode}${digits}`;
  }

  return '';
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
