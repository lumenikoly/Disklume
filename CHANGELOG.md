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
