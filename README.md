# audio-viz web

Браузерная версия audio-viz: абстрактный аудиовизуализатор, который целиком работает у посетителя. Рендер идёт на его GPU через WebGPU, анализ трека — в WebAssembly. Сервер только отдаёт статические файлы.

**Сайт:** https://lexbogos.github.io/audio-viz-web/

```
трек ─ Web Audio (decodeAudioData) ─▶ wasm: FFT-анализ ─▶ wasm + WebGPU: шейдер-пресет ─▶ bloom ─▶ canvas
         └─▶ воспроизведение (AudioContext) ── позиция каждый кадр ──┘
```

## Что умеет
- открыть трек выбором файла или перетаскиванием;
- воспроизведение, пауза, перемотка;
- 13 пресетов, ползунки цвета, движения и эффектов на бит;
- клавиши: `Space` — пауза, `←`/`→` — перемотка на 5 с, `N`/`P` — следующий/предыдущий пресет.

Нужен браузер с WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+ (Windows).

## Сборка
Нужны Rust с целью wasm и `wasm-bindgen-cli` той же версии, что в `Cargo.toml`:
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
```
```bash
./build.sh
python3 -m http.server 8173 --directory www
```
Затем откройте http://localhost:8173.

При пуше в `main` GitHub Actions собирает модуль и публикует `www/` на GitHub Pages.

## Устройство
- `src/lib.rs` — API для страницы: создание WebGPU на canvas, загрузка трека, пресеты, ползунки, отрисовка кадра.
- `src/gpu.rs`, `src/analysis.rs`, `src/presets.rs`, `shaders/` — рендер, анализ и пресеты.
- `www/` — страница: декодирование и воспроизведение через Web Audio, интерфейс.

## Свои пресеты
Пресет — WGSL-файл в `shaders/presets/` с одной функцией, его нужно добавить в список в `src/presets.rs`:
```wgsl
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> { ... }  // линейный HDR-цвет
```
Доступные данные: `U.bass`, `U.mid`, `U.high`, `U.level`, `U.beat` (0..1), `U.energy`, `spec(x)` (спектр из 64 полос). Описание полей — в [shaders/prelude.wgsl](shaders/prelude.wgsl).
