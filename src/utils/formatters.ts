/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extrai os dígitos numéricos do telefone sem truncar comprimentos excedentes.
 * Caso o número possua código de país do Brasil (+55) seguido dos 11 dígitos móveis
 * (total de 13 dígitos iniciando com "55"), normaliza para os 11 dígitos nacionais.
 */
export function extractPhoneDigits(value: string | null | undefined): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  if (digits.length === 12 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Remove caracteres não numéricos e limita a entrada a no máximo 11 dígitos nacionais (DDD + 9 dígitos),
 * ideal para uso em campos de formulário e persistência limpa no Firestore.
 */
export function sanitizePhone(value: string | null | undefined): string {
  return extractPhoneDigits(value).slice(0, 11);
}

/**
 * Aplica progressivamente a máscara '(00) 00000-0000' em números de telefone / WhatsApp de 11 dígitos.
 *
 * Exemplos:
 * - "11"          -> "(11"
 * - "1191234"     -> "(11) 91234"
 * - "11912345678" -> "(11) 91234-5678"
 */
export function formatPhone(value: string | null | undefined): string {
  const digits = sanitizePhone(value);
  if (!digits) return '';

  if (digits.length <= 2) {
    return `(${digits}`;
  }

  const ddd = digits.slice(0, 2);
  const subscriber = digits.slice(2);

  if (subscriber.length <= 5) {
    return `(${ddd}) ${subscriber}`;
  }

  return `(${ddd}) ${subscriber.slice(0, 5)}-${subscriber.slice(5, 9)}`;
}

/** Alias semântico para aplicação da máscara '(00) 00000-0000'. */
export const applyPhoneMask = formatPhone;

/**
 * Valida se o número de telefone informado possui o formato correto de 11 dígitos
 * ao cadastrar ou atualizar um telefone/WhatsApp (DDD válido de 2 dígitos + 9 dígitos móveis).
 *
 * Aceita tanto o valor já mascarado '(00) 00000-0000' quanto os 11 dígitos puros '00000000000'
 * (ou com DDI '+55'), retornando estritamente um booleano (`true` ou `false`).
 */
export function isValidPhone(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;

  const trimmed = String(value).trim();
  if (!trimmed) return false;

  // Rejeita letras ou símbolos estranhos além de dígitos, espaços, parênteses, hífen e sinal '+'
  if (/[^\d\s()+-]/.test(trimmed)) {
    return false;
  }

  const digits = extractPhoneDigits(trimmed);

  // Deve possuir exatamente 11 dígitos nacionais (2 do DDD + 9 do celular)
  if (digits.length !== 11) {
    return false;
  }

  // Se o texto contém caracteres de máscara, verifica aderência à estrutura '(00) 00000-0000'
  const withoutCountryPrefix = trimmed.replace(/^\+?55\s*/, '');
  if (/[()-]/.test(withoutCountryPrefix)) {
    const maskedPattern = /^\(\d{2}\)\s?\d{5}-\d{4}$/;
    if (!maskedPattern.test(withoutCountryPrefix)) {
      return false;
    }
  }

  // Valida DDD brasileiro (11 a 99, sem zero nos dígitos do DDD) e nono dígito inicial '9'
  const brazilianMobile11DigitsPattern = /^[1-9][1-9]9\d{8}$/;
  return brazilianMobile11DigitsPattern.test(digits);
}

/** Alias semântico que retorna booleano verificando o formato de 11 dígitos do telefone. */
export const validatePhone = isValidPhone;

/**
 * Retorna mensagem explicativa de validação quando `isValidPhone(value)` é `false`,
 * ou `undefined` quando o número possui formato válido de 11 dígitos.
 */
export function getPhoneValidationMessage(value: string | null | undefined): string | undefined {
  if (isValidPhone(value)) {
    return undefined;
  }

  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return 'Informe seu número de telefone / WhatsApp com DDD.';
  }

  if (/[^\d\s()+-]/.test(trimmed)) {
    return 'O telefone deve conter apenas números no formato (00) 00000-0000.';
  }

  const digits = extractPhoneDigits(trimmed);
  if (digits.length !== 11) {
    return 'O número deve possuir exatamente 11 dígitos no formato (00) 00000-0000.';
  }

  const ddd = Number(digits.slice(0, 2));
  if (Number.isNaN(ddd) || ddd < 11 || ddd > 99 || ddd % 10 === 0) {
    return 'Informe um código DDD brasileiro válido (ex: 11, 16, 19, 21).';
  }

  if (digits[2] !== '9') {
    return 'Celulares com 11 dígitos devem iniciar com o dígito 9 após o DDD. Ex: (11) 91234-5678.';
  }

  return 'Use o formato válido de 11 dígitos: (00) 00000-0000.';
}
