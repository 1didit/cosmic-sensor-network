# Cosmic Sensor Network — Roadmap

## ✅ Реалізовано (v1.0)

### Глобус (Globe.gl)
- [x] 3D Земля — нічна текстура, зоряний фон
- [x] Атмосферний ореол — колір за Kp (teal / amber / red)
- [x] Кільця землетрусів — пульсуючі, колір за глибиною, розмір за магнітудою
- [x] CME арки — анімовані дуги сонячний вітер → Земля
- [x] Авто-обертання, зупинка при взаємодії

### Сайдбар — блоки даних
| Блок | Дані | API | Оновлення |
|------|------|-----|-----------|
| Solar Wind | Швидкість (км/с), щільність (p/cm³), sparkline 24h | NOAA ACE | 60 с |
| Kp Index | Значення 0–9, gauge, статус QUIET/UNSETTLED/ACTIVE/STORM | NOAA | 60 с |
| EM Field / BOU | Variance (nT), стан CALM/ACTIVE/SPIKE, waveform 60 хв | USGS Geomag BOU | 60 с |
| Earthquakes | Топ-5 список, лічильник 24h, глибина, час | USGS FDSNWS | 5 хв |
| Space Events | Останні 3 спалахи (клас X/M/C), 2 CME (швидкість) | NASA DONKI | 5 хв |

### Технічне
- [x] Всі API — client-side, без бекенду
- [x] Graceful error handling — `—` при помилці, status dots
- [x] XSS-захист (escHtml) для всіх API-рядків
- [x] Стабільні позиції арок/кілець (hashFloat, не Math.random)
- [x] In-flight guard — немає дублікатів запитів
- [x] Responsive — мобільний layout
- [x] prefers-reduced-motion

---

## 🔲 Не реалізовано — Черга

### Пріоритет HIGH (прості API, високий impact)
- [ ] **X-Ray Flux (GOES)** — рівень рентгенівського випромінювання, клас спалаху в реальному часі
  - API: `https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json`
  - Відображення: лінійний графік + поточний клас (A/B/C/M/X)

- [ ] **Протонні події (GOES Proton Flux)** — радіаційна небезпека
  - API: `https://services.swpc.noaa.gov/json/goes/primary/integral-protons-7-day.json`
  - Відображення: sparkline, alert якщо >10 pfu

- [ ] **ISS положення** — реальний час
  - API: `https://api.wheretheiss.at/v1/satellites/25544`
  - Відображення: точка на глобусі + траєкторія орбіти

### Пріоритет MEDIUM

- [ ] **Aurora Forecast (овал полярного сяйва)**
  - API: `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`
  - Відображення: накладення GeoJSON полігону на глобус

- [ ] **D-Region Absorption (GOES/NOAA)** — поглинання радіохвиль іоносферою
  - API: `https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json` (похідне)

- [ ] **Galactic Cosmic Rays** — інтенсивність ГКВ (Neutron Monitor)
  - API: `https://www.nmdb.eu/nest/draw_graph.php` (складний парсинг)

- [ ] **NASA DONKI — Геомагнітні бурі (GST)**
  - API: `https://api.nasa.gov/DONKI/GST?api_key=DEMO_KEY`
  - Відображення: блок поряд зі Space Events

- [ ] **Швидкість обертання Землі (LOD)** — IERS
  - Показник аномальних варіацій довжини доби

### Пріоритет LOW / Складні

- [ ] **Schumann Resonance пряма** — немає безкоштовного реального API. Варіант: власний WebSocket сервер з даними ELFRAD або Tomsk university
- [ ] **Van Allen Radiation Belts** — NASA VAP, немає простого REST API
- [ ] **Heliospheric Current Sheet tilt** — GONG/NOAA, складний FITS-формат
- [ ] **Voyager 1/2 відстань** — NASA Eyes / Horizons API (JPL)
  - API: `https://ssd.jpl.nasa.gov/horizons_batch.cgi`

---

## 🔧 Технічні покращення в черзі

- [ ] Замінити NASA `DEMO_KEY` на власний ключ (30 req/hr ліміт)
  - Реєстрація: `https://api.nasa.gov/`
- [ ] Кешування останніх даних у `localStorage` — показувати stale data при офлайн
- [ ] WebWorker для fetch-логіки — не блокувати main thread
- [ ] Service Worker / PWA — offline fallback
- [ ] Unit тести для парсерів API (fetchSolarWind, fetchKpIndex, etc.)

---

## Поточна версія
**v1.0** — 3 файли: `index.html` / `style.css` / `app.js` (~1300 рядків)
