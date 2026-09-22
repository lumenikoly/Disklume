import { ui } from './i18n.js';

export function revealLabel(target: 'file' | 'folder', userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return target === 'file' ? ui('Показать файл в Finder') : ui('Показать папку в Finder');
  }
  if (/Windows/i.test(userAgent)) {
    return target === 'file' ? ui('Показать файл в Проводнике') : ui('Показать папку в Проводнике');
  }
  return target === 'file' ? ui('Показать файл в файловом менеджере') : ui('Показать папку в файловом менеджере');
}
