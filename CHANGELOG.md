# 0.0.2

## Русский

- Режим «Папки» теперь открывается по умолчанию после запуска и выбора папки.
- Исправлено раскрытие больших групп на карте: сотни тысяч однотипных файлов делятся на ограниченные диапазоны, поэтому до отдельных файлов можно добраться за несколько переходов, без потерь и повторов.
- Сохранены ограничения сцены: до 480 отдельных файлов и 96 групп на одном уровне.
- Обход каталогов выполняется ограниченным пулом до восьми потоков; публикация результатов в индекс остаётся сериализованной, а ссылки и точки перенаправления отсекаются до постановки каталога в очередь.
- Добавлено контекстное меню файлов и папок: файл можно открыть или показать в Проводнике Windows, Finder либо файловом менеджере Linux; папку можно показать после повторной проверки её ID и пути в ядре.

## English

- Folder view now opens by default after startup and folder selection.
- Fixed drill-down for large map groups: hundreds of thousands of similarly classified files are split into bounded ranges, making individual files reachable in a few steps without omissions or duplicates.
- Preserved scene bounds of up to 480 individual files and 96 groups per level.
- Directory traversal now uses a bounded pool of up to eight workers; index publication remains serialized, and links or reparse points are rejected before a directory is queued.
- Added file and folder context menus with platform-specific File Explorer, Finder, or Linux file-manager labels; folders are revealed only after their ID and path are revalidated by the core.

See [verification / проверки](docs/VERIFICATION.md) for tested platforms and remaining release checks.

# 0.0.1

## Русский

- Добавлен режим папок: суммарные размеры, доли, переходы внутрь и путь для возврата. Возрастные кольца карты заменены компактной раскладкой по размеру.
- Интерфейс и README на русском и английском; язык сохраняется.
- Убраны лишние подсказки и постоянная пустая панель удаления.
- Отмена выбора папки и неудачное пересканирование сохраняют план.
- Исправлены просмотр плана, отметки после частичного выполнения и подтверждение во время загрузки.
- Скрипты Windows требуют подтверждения перед запуском.
- Корень сканирования и его предки проверяются на ссылки и точки перенаправления.
- Зафиксированы зависимости, обновлён Playwright, подготовлены проверки и сборка пакетов.

Действия: открыть, показать в системном файловом менеджере, перенести в Корзину после подтверждения.

## English

- Added folder browsing with recursive sizes, shares, drill-down and breadcrumbs. Replaced age rings with compact size-based circle packing.
- Russian and English interface and README, with a saved language preference.
- Removed redundant copy and the empty removal bar.
- Cancelling folder selection or failing a rescan preserves the plan.
- Fixed plan review, partial completion markers, and confirmation while loading.
- Windows scripts require confirmation before launch.
- Scan roots and ancestors are checked for links and reparse points.
- Locked dependencies, updated Playwright, and prepared checks and package builds.

Actions: open, reveal in the system file manager, and move to Trash after confirmation.

See [verification / проверки](docs/VERIFICATION.md) for tested platforms and remaining release checks.
