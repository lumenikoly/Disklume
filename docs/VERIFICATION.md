# Проверки 0.0.1

Дата: 19 сентября 2026. Среда: Windows x64, Node.js 22.18.0, Rust/Cargo 1.98.1, TypeScript 5.8.3, Playwright 1.55.1 / Chromium 140.

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | Пройдена |
| `npm test` | 32 теста пройдены |
| `npm run test:e2e` | 11 сценариев пройдены |
| `cargo fmt --all`, затем `cargo fmt --all -- --check` | Пройдены |
| `cargo clippy -p clearmap-core --all-targets --locked -- -D warnings` | Без предупреждений |
| `cargo test -p clearmap-core --locked` | 31 тест пройдены на Windows |
| `npm run tauri -- build --no-bundle` | Windows x64 `.exe` собран |
| Запуск Windows `.exe` в системном WebView2 | Окно открылось; переход внутрь папки на искусственных данных и RU/EN работают; `get_current_status` отвечает через настоящий Tauri IPC; окно штатно закрывается |
| `npm audit --omit=optional` | 0 известных уязвимостей в проверенном наборе npm-зависимостей |

Файловые тесты используют временные каталоги и TestTrash, настоящая Корзина не затрагивается. Проверены сохранение плана при неудачной смене папки и пересканировании, устаревшие ревизии, изменённые и отсутствующие файлы, ошибки журнала и Корзины, отмена, junction и жёсткие ссылки, дубликаты и ограничение размера карты.

UI-сценарии покрывают размеры окна, поиск, выбор, просмотр и отмену плана, подтверждённую операцию над искусственными данными, дубликаты, справку, RU/EN без потери плана и отсутствие нативных вызовов в DemoBackend. Имена и пути не переводятся. Дополнительно проверены вложенные папки, пустые каталоги, размеры жёстких ссылок, пагинация и выбор только показанных файлов. Снимки: [карта RU](interface.png), [карта EN](interface-en.png), [папки RU](folders.png), [папки EN](folders-en.png).

## Границы проверки

- macOS и Linux здесь не собирались и не запускались. Для них подготовлена матрица CI; её наличие не означает успешный запуск.
- Ручные испытания системного диалога выбора папки, открытия файлов внешними программами, показа в файловом менеджере, переноса и восстановления через настоящую Корзину не выполнялись. Сценарии — в [MANUAL-CHECK.md](MANUAL-CHECK.md).
- Подпись Windows и notarization macOS не настроены; исполняемые файлы публикуются как unsigned portable artifacts.
- Не измерялись производительность и память на 100 тысячах / миллионе файлов. Аудит Rust-зависимостей по базе RustSec не запускался.
- GitHub Actions не запускались из этой рабочей папки. Публикации релиза не было.

`Cargo.lock` и `package-lock.json` включены в исходники; CI использует `npm ci` и `--locked`.

## English

Windows x64 build and startup were verified, including language switching and native Tauri IPC. All 32 frontend unit tests, 11 UI scenarios, and 31 Windows Rust tests passed. Rust formatting and Clippy passed. File-operation tests use temporary folders and TestTrash only. macOS/Linux builds, real system Trash integration, clean-machine installation, signing and large-directory benchmarks remain unverified.

Локальный Windows-бинарник: `target/release/clearmap.exe`. Публикация кроссплатформенного релиза выполняется workflow `Release executables`; запуск GitHub Actions из этой рабочей папки не выполнялся.
