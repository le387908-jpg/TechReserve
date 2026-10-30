/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilitários puros e determinísticos para manipulação e formatação de datas.
 * Evita bugs de fuso horário UTC (ex: ECMAScript interpretando 'YYYY-MM-DD' como UTC meia-noite,
 * o que em fusos brasileiros como UTC-3 subtrai 3 horas e recua a data em 1 dia).
 */

/**
 * Converte qualquer data para o formato ISO 'YYYY-MM-DD'.
 * Aceita:
 * - 'YYYY-MM-DD'
 * - 'DD/MM/YYYY' ou 'DD-MM-YYYY'
 * - Date object
 * - Timestamp numérico
 */
export function normalizeDateToISO(input?: string | number | Date | null): string {
  if (!input) return '';

  if (typeof input === 'number') {
    const d = new Date(input);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  if (input instanceof Date) {
    if (isNaN(input.getTime())) return '';
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const day = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const str = String(input).trim();
  if (!str) return '';

  // Já no formato YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Formato ISO com horário (ex: YYYY-MM-DDTHH:mm:ss...)
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    return str.split('T')[0];
  }

  // Formato brasileiro DD/MM/YYYY ou DD-MM-YYYY
  const brMatch = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (brMatch) {
    const day = brMatch[1].padStart(2, '0');
    const month = brMatch[2].padStart(2, '0');
    const year = brMatch[3];
    return `${year}-${month}-${day}`;
  }

  return str;
}

/**
 * Converte data em formato 'YYYY-MM-DD' ou 'YYYY-MM-DDTHH:mm' para o padrão brasileiro 'DD/MM/YYYY'.
 * Opera por decomposição de string pura, SEM envolver o fuso UTC do navegador.
 */
export function formatDataBR(dataStr?: string | number | Date | null): string {
  if (!dataStr) return 'Não informado';

  if (typeof dataStr === 'number' || dataStr instanceof Date) {
    const iso = normalizeDateToISO(dataStr);
    return formatDataBR(iso);
  }

  const str = String(dataStr).trim();
  if (!str) return 'Não informado';

  // Se já tiver no formato DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    return str;
  }

  // Se for YYYY-MM-DD ou YYYY-MM-DD...
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${d}/${m}/${y}`;
  }

  return str;
}

/**
 * Retorna o dia de hoje no formato 'YYYY-MM-DD' no horário local.
 */
export function getTodayLocalISO(referenceDate = new Date()): string {
  const y = referenceDate.getFullYear();
  const m = String(referenceDate.getMonth() + 1).padStart(2, '0');
  const d = String(referenceDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Retorna o dia de amanhã no formato 'YYYY-MM-DD' no horário local.
 */
export function getTomorrowLocalISO(referenceDate = new Date()): string {
  const tomorrow = new Date(referenceDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getTodayLocalISO(tomorrow);
}

/**
 * Cria um objeto Date seguro para comparações locais a partir de date 'YYYY-MM-DD' e time 'HH:mm'.
 */
export function createSafeLocalDateTime(
  dateStr?: string | null,
  timeStr?: string | null
): Date {
  const safeDate = normalizeDateToISO(dateStr) || getTodayLocalISO();
  const safeTime = typeof timeStr === 'string' && timeStr.includes(':') ? timeStr.trim() : '00:00';
  const [year, month, day] = safeDate.split('-').map(Number);
  const [hours, minutes] = safeTime.split(':').map(Number);
  return new Date(
    Number.isFinite(year) && year > 0 ? year : new Date().getFullYear(),
    (Number.isFinite(month) && month > 0 ? month : 1) - 1,
    Number.isFinite(day) && day > 0 ? day : 1,
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    0,
    0
  );
}
