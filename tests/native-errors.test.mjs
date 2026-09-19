import test from 'node:test';
import assert from 'node:assert/strict';
import { translateNativeError } from '../dist/app/native-errors.js';

test('translates exact native messages to English', () => {
  assert.equal(
    translateNativeError('Эта карта устарела. Повторите действие в текущей папке.', 'en'),
    'This map is stale. Repeat the action in the current folder.',
  );
  assert.equal(
    translateNativeError('Исходная папка была заменена или стала ссылкой. Выберите её заново.', 'en'),
    'The source folder was replaced or became a link. Choose it again.',
  );
});

test('translates anchored prefixes while preserving OS details and paths', () => {
  const error = 'Не удалось открыть файл: C:\\Users\\т\\Документы\\отчёт.txt: Access is denied';
  assert.equal(
    translateNativeError(error, 'en'),
    'Could not open the file: C:\\Users\\т\\Документы\\отчёт.txt: Access is denied',
  );
});

test('does not translate unknown or embedded Russian text', () => {
  const message = 'Причина: Не удалось открыть файл: C:\\data\\a.txt';
  assert.equal(translateNativeError(message, 'en'), message);
  assert.equal(translateNativeError('Эта карта устарела.', 'ru'), 'Эта карта устарела.');
});
