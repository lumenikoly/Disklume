import { messages } from './messages.js';
export type Locale = 'ru' | 'en';
let current: Locale = (() => { try { return localStorage.getItem('clearmap.locale') === 'en' ? 'en' : 'ru'; } catch { return 'ru'; } })();
export const locale = (): Locale => current;
export const intlLocale = (): string => current === 'ru' ? 'ru-RU' : 'en-US';
const pattern = new RegExp(Object.keys(messages).sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
function literal(value: string): string { return current === 'ru' ? value : value.replace(pattern, key => messages[key]!); }
/** Translate authored literals only; interpolated filenames/paths remain untouched. */
export function ui(value: string | TemplateStringsArray, ...values: unknown[]): string {
  if (typeof value === 'string') return literal(value);
  return value.reduce((result, part, index) => result + literal(part) + (index < values.length ? String(values[index]) : ''), '');
}
// Capture initial markup before any file data is rendered, once per page.
const texts: { node: Text; original: string }[] = [];
const attributes: { node: Element; attribute: string; original: string }[] = [];
let initialized = false;
export function initLocale(): void {
  if (!initialized) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.parentElement?.closest('script,style') && /[А-Яа-яЁё]/.test(node.nodeValue || '')) texts.push({ node: node as Text, original: node.nodeValue! });
    }
    document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(node => {
      for (const attribute of ['title', 'aria-label', 'placeholder']) {
        const original = node.getAttribute(attribute);
        if (original) attributes.push({ node, attribute, original });
      }
    });
    initialized = true;
  }
  setLocale(current);
}
export function setLocale(next: Locale): void {
  current = next;
  try { localStorage.setItem('clearmap.locale', next); } catch { /* Optional preference. */ }
  document.documentElement.lang = next;
  document.title = 'ClearMap';
  for (const entry of texts) if (entry.node.isConnected) entry.node.nodeValue = literal(entry.original);
  for (const entry of attributes) if (entry.node.isConnected) entry.node.setAttribute(entry.attribute, literal(entry.original));
  const button = document.getElementById('language');
  if (button) button.textContent = next === 'ru' ? 'EN' : 'RU';
}
export const categoryNames: Record<Locale, string[]> = { ru: ['Видео', 'Изображения', 'Аудио', 'Документы', 'Архивы и образы', 'Исходный код', 'Программы', 'Прочее'], en: ['Video', 'Images', 'Audio', 'Documents', 'Archives and disk images', 'Source code', 'Applications', 'Other'] };
export const ageNames: Record<Locale, string[]> = { ru: ['До 7 дней', '7–30 дней', '1–3 месяца', '3–12 месяцев', 'Больше года', 'Дата неизвестна'], en: ['Under 7 days', '7–30 days', '1–3 months', '3–12 months', 'Over a year', 'Unknown date'] };
