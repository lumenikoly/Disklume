import { translateNativeError } from './native-errors.js';
import type { Category } from './types.js';
import { ageNames, categoryNames, locale } from './i18n.js';
export const categories: Category[] = ['video', 'image', 'audio', 'document', 'archive', 'code', 'executable', 'other'];
export const labels: Record<Category, string> = { video: 'Видео', image: 'Изображения', audio: 'Аудио', document: 'Документы', archive: 'Архивы и образы', code: 'Исходный код', executable: 'Программы', other: 'Прочее' };
export function categoryLabel(category: Category): string { return categoryNames[locale()][categories.indexOf(category)] || labels[category]; }
export const colors: Record<Category, string> = { video: '#b5c98b', image: '#85beb5', audio: '#c2a4c7', document: '#93b5d0', archive: '#d5b37c', code: '#aab9a9', executable: '#d29483', other: '#999d96' };
export const ages = ['До 7 дней', '7–30 дней', '1–3 месяца', '3–12 месяцев', 'Больше года', 'Дата неизвестна'];
export function ageLabel(index: number): string { return ageNames[locale()][index] || ages[index] || ''; }
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return locale() === 'ru' ? '0 Б' : '0 B';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ', 'ПиБ'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const number = value / 1024 ** exponent;
  return `${number.toLocaleString(locale() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: exponent === 0 || number >= 100 ? 0 : 1 })} ${locale() === 'ru' ? units[exponent] : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][exponent]}`;
}
export const number = (n: number): string => n.toLocaleString(locale() === 'ru' ? 'ru-RU' : 'en-US');
export function fileWord(n: number): string {
  if (locale() === 'en') return n === 1 ? 'file' : 'files';
  const last = n % 100;
  if (last >= 11 && last <= 14) return 'файлов';
  switch (n % 10) { case 1: return 'файл'; case 2: case 3: case 4: return 'файла'; default: return 'файлов'; }
}
export function date(ms: number | null): string {
  return ms === null ? (locale() === 'ru' ? 'Неизвестно' : 'Unknown') : new Date(ms).toLocaleDateString(locale() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
export function errorMessage(error: unknown): string { return translateNativeError(error instanceof Error ? error.message : String(error), locale()); }
export function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
