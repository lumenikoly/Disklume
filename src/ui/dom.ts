import { ui } from '../i18n.js';
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(ui`Не найден элемент интерфейса: ${id}`);
  return element as T;
}
export function show(id: string, visible: boolean): void { el(id).hidden = !visible; }
export function text(id: string, value: string): void { el(id).textContent = value; }
export function disable(id: string, disabled: boolean): void { el<HTMLButtonElement>(id).disabled = disabled; }
export function on(id: string, callback: () => void): void { el(id).addEventListener('click', callback); }
