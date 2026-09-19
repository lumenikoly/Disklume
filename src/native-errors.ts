type Translation = { ru: string; en: string };

const exact: Translation[] = [
  { ru: 'Некорректный идентификатор каталога. Обновите папку.', en: 'Invalid directory identifier. Refresh the folder.' },
  { ru: 'Неизвестная папка.', en: 'Unknown folder.' },
  { ru: 'Остановлено', en: 'Stopped' },
  { ru: 'Файл изменился до чтения.', en: 'The file changed before it could be read.' },
  { ru: 'Файл вырос во время проверки.', en: 'The file grew while it was being checked.' },
  { ru: 'Размер файла изменился во время проверки.', en: 'The file size changed while it was being checked.' },
  { ru: 'Файл изменился во время проверки.', en: 'The file changed while it was being checked.' },
  { ru: 'Поисковый запрос слишком длинный.', en: 'The search query is too long.' },
  { ru: 'Системная Корзина на этой платформе не поддерживается.', en: 'The system Trash is not supported on this platform.' },
  { ru: 'Состояние приложения недоступно.', en: 'Application state is unavailable.' },
  { ru: 'Не удалось открыть состояние приложения.', en: 'Could not open application state.' },
  { ru: 'Эта карта устарела. Повторите действие в текущей папке.', en: 'This map is stale. Repeat the action in the current folder.' },
  { ru: 'Для запуска этого файла нужно отдельное подтверждение.', en: 'This file requires separate confirmation before it can be launched.' },
  { ru: 'За один раз можно выбрать не более 10 000 файлов.', en: 'You can select no more than 10,000 files at a time.' },
  { ru: 'Слишком много идентификаторов.', en: 'Too many identifiers.' },
  { ru: 'Выберите обычную локальную папку, не Корзину и не облачную ссылку.', en: 'Choose a regular local folder, not Trash or a cloud placeholder.' },
  { ru: 'Сначала выберите папку.', en: 'Choose a folder first.' },
  { ru: 'Сначала очистите или примените список удаления.', en: 'Clear or apply the deletion list first.' },
  { ru: 'В плане уже 10 000 файлов. Сначала завершите текущую уборку.', en: 'The plan already contains 10,000 files. Finish the current cleanup first.' },
  { ru: 'Список изменился. Проверьте его и подтвердите заново.', en: 'The list changed. Review it and confirm again.' },
  { ru: 'Список удаления пуст.', en: 'The deletion list is empty.' },
  { ru: 'Дождитесь завершения текущей операции или остановите её.', en: 'Wait for the current operation to finish or stop it.' },
  { ru: 'Недостаточно надёжных метаданных для операции. Обновите папку.', en: 'There is not enough reliable metadata for this operation. Refresh the folder.' },
  { ru: 'Операция с корневой папкой запрещена.', en: 'Operations on the root folder are forbidden.' },
  { ru: 'Некорректный путь в индексе.', en: 'The index contains an invalid path.' },
  { ru: 'Родительская папка изменилась.', en: 'The parent folder changed.' },
  { ru: 'Исходная папка была заменена или стала ссылкой. Выберите её заново.', en: 'The source folder was replaced or became a link. Choose it again.' },
  { ru: 'Путь содержит ссылку, точку перенаправления или облачный файл. Операция отменена.', en: 'The path contains a link, redirect point, or cloud placeholder. The operation was cancelled.' },
  { ru: 'Системный модуль открытия не поддерживает это имя. Используйте «Показать в папке».', en: 'The system opener does not support this name. Use “Show in folder”.' },
  { ru: 'Сначала остановите текущую операцию.', en: 'Stop the current operation first.' },
  { ru: 'Сначала завершите или остановите перенос в Корзину. Уже выполненные действия останутся в силе.', en: 'Finish or stop moving items to Trash first. Completed actions remain in effect.' },
  { ru: 'Корзина поддерживается только для обычных путей локального диска. Сетевые и специальные пути не удаляются.', en: 'Trash is supported only for regular local-disk paths. Network and special paths are not deleted.' },
  { ru: 'Эта карта устарела.', en: 'This map is stale.' },
  { ru: 'Файл отсутствует.', en: 'The file is missing.' },
  { ru: 'Сначала завершите текущую операцию.', en: 'Finish the current operation first.' },
  { ru: 'В плане не может быть больше 10 000 файлов.', en: 'A plan cannot contain more than 10,000 files.' },
  { ru: 'Список изменился. Подтвердите его заново.', en: 'The list changed. Confirm it again.' },
  { ru: 'Список пуст.', en: 'The list is empty.' },
  { ru: 'Подтвердите запуск программы.', en: 'Confirm that you want to launch the program.' },
  { ru: 'Это пример: настоящие файлы не открываются.', en: 'This is a demo: real files are not opened.' },
  { ru: 'Это пример: системный файловый менеджер не запускается.', en: 'This is a demo: the system file manager is not launched.' },
];

const prefixes: Translation[] = [
  { ru: 'Не удалось переместить в системную Корзину: ', en: 'Could not move item to the system Trash: ' },
  { ru: 'Не удалось подготовить системную Корзину: ', en: 'Could not prepare the system Trash: ' },
  { ru: 'Система не смогла переместить файл в Корзину. Безвозвратное удаление не выполнялось: ', en: 'The system could not move the file to Trash. Permanent deletion was not performed: ' },
  { ru: 'Не удалось записать журнал: ', en: 'Could not write the journal: ' },
  { ru: 'Не удалось сохранить журнал: ', en: 'Could not save the journal: ' },
  { ru: 'Удаление не начато: журнал недоступен. ', en: 'Deletion did not start: the journal is unavailable. ' },
  { ru: 'Не удалось прочитать файл: ', en: 'Could not read the file: ' },
  { ru: 'Не удалось прочитать: ', en: 'Could not read: ' },
  { ru: 'Метаданные недоступны: ', en: 'Metadata is unavailable: ' },
  { ru: 'Не удалось открыть файл: ', en: 'Could not open the file: ' },
  { ru: 'Не удалось показать файл в системном менеджере: ', en: 'Could not show the file in the system file manager: ' },
  { ru: 'Не удалось открыть папку: ', en: 'Could not open the folder: ' },
  { ru: 'Нет доступа к папке: ', en: 'The folder cannot be accessed: ' },
  { ru: 'Исходная папка недоступна: ', en: 'The source folder is unavailable: ' },
  { ru: 'Файл недоступен или был перемещён: ', en: 'The file is unavailable or was moved: ' },
  { ru: 'Не удалось запустить фоновую задачу: ', en: 'Could not start the background task: ' },
  { ru: 'Невозможно безопасно идентифицировать файл ', en: 'Unable to safely identify file ' },
];

/** Translate known native prefixes while leaving OS-provided details untouched. */
export function translateNativeError(message: string, language: 'ru' | 'en'): string {
  if (language === 'ru') return message;
  const known = exact.find((entry) => entry.ru === message);
  if (known) return known.en;
  const prefix = prefixes.find((entry) => message.startsWith(entry.ru));
  return prefix ? prefix.en + message.slice(prefix.ru.length) : message;
}
