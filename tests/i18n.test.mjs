import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, ui } from '../dist/app/i18n.js';
import { formatBytes, fileWord } from '../dist/app/format.js';

test('localized templates preserve interpolated file names and paths exactly', () => {
  globalThis.document = { documentElement: {}, getElementById: () => null };
  setLocale('en');
  const name = 'Отчёт/Открыть Файл.txt';
  assert.equal(ui`Убрать ${name} из списка`, `Remove ${name} from list`);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(fileWord(1), 'file');
  assert.equal(fileWord(2), 'files');
  setLocale('ru');
  assert.equal(ui`Убрать ${name} из списка`, `Убрать ${name} из списка`);
  delete globalThis.document;
});
