# Проверки 0.0.2

Дата: 20 сентября 2026. Среда: Windows x64, Node.js 22.18.0, Rust/Cargo 1.98.1, TypeScript 5.8.3, Playwright 1.55.1 / Chromium 140.

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | Пройдена |
| `npm test` | 33 теста пройдены, включая названия системного файлового менеджера для Windows, macOS и Linux |
| `npm run test:e2e` | 12 сценариев пройдены, включая контекстное меню файлов и папок |
| `cargo fmt --all`, затем `cargo fmt --all -- --check` | Пройдены |
| `cargo clippy -p clearmap-core --all-targets --locked -- -D warnings` | Без предупреждений |
| `cargo test -p clearmap-core --locked` | 33 теста пройдены на Windows, включая широкое дерево и проверку пути каталога по ID |
| `npm run tauri -- build --no-bundle` | Windows x64 `.exe` собран |
| Проверка запуска Windows `.exe` | Метаданные файла содержат версию 0.0.2; процесс успешно запустился и оставался активным до завершения smoke-проверки |
| `npm audit --omit=optional` | 0 известных уязвимостей в проверенном наборе npm-зависимостей |

Файловые тесты используют временные каталоги и TestTrash, настоящая Корзина не затрагивается. Проверены сохранение плана при неудачной смене папки и пересканировании, устаревшие ревизии, изменённые и отсутствующие файлы, ошибки журнала и Корзины, отмена, junction и жёсткие ссылки, дубликаты, ограничение размера карты и полное непересекающееся покрытие диапазонов при раскрытии групп.

UI-сценарии покрывают старт в режиме папок, размеры окна, поиск, выбор, просмотр и отмену плана, подтверждённую операцию над искусственными данными, дубликаты, справку, RU/EN без потери плана и отсутствие нативных вызовов в DemoBackend. Имена и пути не переводятся. Дополнительно проверены вложенные папки, пустые каталоги, размеры жёстких ссылок, пагинация и выбор только показанных файлов. Снимки: [карта RU](interface.png), [карта EN](interface-en.png), [папки RU](folders.png), [папки EN](folders-en.png).

## Границы проверки

- macOS и Linux здесь не собирались и не запускались. Для них подготовлена матрица CI; её наличие не означает успешный запуск.
- Ручные испытания системного диалога выбора папки, открытия файлов внешними программами, показа в файловом менеджере, переноса и восстановления через настоящую Корзину не выполнялись. Сценарии — в [MANUAL-CHECK.md](MANUAL-CHECK.md).
- Подпись Windows и notarization macOS не настроены; исполняемые файлы публикуются как unsigned portable artifacts.
- Не измерялись производительность и память на 100 тысячах / миллионе файлов. Аудит Rust-зависимостей по базе RustSec не запускался.
- GitHub Actions не запускались из этой рабочей папки. Публикации релиза не было.

`Cargo.lock` и `package-lock.json` включены в исходники; CI использует `npm ci` и `--locked`.

## English

Windows x64 build and startup smoke test were verified. All 33 frontend unit tests, 12 UI scenarios, and 33 Windows Rust tests passed. Rust formatting and Clippy passed. File-operation tests use temporary folders and TestTrash only. macOS/Linux builds, real system Trash integration, clean-machine installation, signing and large-directory benchmarks remain unverified.

Локальный Windows-бинарник: `target/release/clearmap.exe`. Публикация кроссплатформенного релиза выполняется workflow `Release executables`; запуск GitHub Actions из этой рабочей папки не выполнялся.
