import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, fileWord, escapeHtml, basename, hash } from '../dist/app/format.js';

test('binary sizes use accurate units', () => {
  assert.match(formatBytes(1024 ** 3), /1.*ГиБ/);
  assert.match(formatBytes(0), /0/);
  assert.match(formatBytes(1024), /КиБ/);
});
test('Russian plurals cover the teens and hundreds', () => {
  for (const [n, expected] of [[0,'файлов'],[1,'файл'],[2,'файла'],[5,'файлов'],[11,'файлов'],[21,'файл'],[112,'файлов']]) assert.equal(fileWord(n), expected);
});
test('names are escaped before template insertion', () => {
  const result = escapeHtml('<img src=x onerror="alert(1)"> & \'');
  assert.ok(!result.includes('<')); assert.ok(!result.includes('"'));
  assert.match(result, /&amp;/);
});
test('path names handle both OS separators', () => {
  assert.equal(basename('/home/user/Downloads'), 'Downloads');
  assert.equal(basename('C:\\Users\\User\\Downloads'), 'Downloads');
});
test('layout hash is stable and unsigned', () => {
  assert.equal(hash('Снимок экрана'), hash('Снимок экрана'));
  assert.ok(hash('a') >= 0); assert.notEqual(hash('a'), hash('b'));
});
