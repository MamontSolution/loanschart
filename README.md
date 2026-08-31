# Панель выдач

Лендинг с графиками и страница ввода данных. Node.js + SQLite, **без единой внешней
зависимости** — ни npm-пакетов, ни CDN.

```
server.js              HTTP-сервер и API
db.js                  схема базы и запросы
package.json
public/
  index.html           лендинг с графиками
  admin.html           страница ввода данных
  assets/style.css     общие стили
  assets/charts.js     отрисовка графиков
data/app.db            база (создаётся сама при первом запуске)
```

## Запуск

Нужен **Node.js 22.5 или новее** — в нём есть встроенный модуль `node:sqlite`.

```bash
node -v          # должно быть v22.5.0+
npm start        # или: node server.js
```

Откроется на `http://localhost:3000`:

- `/LoansChart` — лендинг (`/` перенаправляет сюда)
- `/LoansChart/admin` — ввод данных (`/admin` перенаправляет сюда)

Если Node старее и обновить его нельзя — поставьте драйвер отдельно,
код подхватит его автоматически:

```bash
npm install better-sqlite3
```

### Запуск из VS Code

1. **File → Open Folder** и выберите папку `app` (именно её, а не папку-обёртку —
   иначе VS Code не найдёт `package.json`).
2. Нажмите **F5**. Готовый конфиг лежит в `.vscode/launch.json`: он поднимет сервер
   во встроенном терминале и сам откроет браузер на нужном адресе.
3. Останов — **Shift+F5** или красный квадрат на панели отладки.

Точки останова ставятся кликом слева от номера строки в `server.js` или `db.js` —
отладчик остановится на них при следующем запросе.

Без отладчика то же самое делает встроенный терминал
(**Terminal → New Terminal**, затем `npm start`), останов — `Ctrl+C`.

### Переменные окружения

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `3000` | порт |
| `HOST` | `0.0.0.0` | адрес прослушивания |
| `DB_FILE` | `./data/app.db` | путь к файлу базы |
| `ADMIN_PASSWORD` | не задана | **если задать — страница ввода закроется паролем** |

## Пароль на страницу ввода

Сейчас `/admin` открыт всем, кто знает адрес. Чтобы закрыть — задайте пароль:

```bash
ADMIN_PASSWORD='ваш-пароль' npm start
```

Появится форма входа; чтение данных (`GET /api/entries`) останется открытым, чтобы
лендинг работал для всех, а добавление, правка и удаление потребуют входа.
Сессии живут 12 часов и хранятся в памяти — после перезапуска нужно войти заново.

## Развёртывание на VPS

### 1. Автозапуск через systemd

`/etc/systemd/system/panel.service`:

```ini
[Unit]
Description=Панель выдач
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/panel
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Environment=PORT=3000
# Environment=ADMIN_PASSWORD=ваш-пароль
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now panel
sudo systemctl status panel
```

### 2. nginx перед приложением

```nginx
server {
    listen 80;
    server_name example.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Дальше `certbot --nginx -d example.ru` для HTTPS.

Если пароль на `/LoansChart/admin` не включён, разумно закрыть страницу ввода на уровне
nginx — например, по IP (закрываем и сам адрес, и старый редирект):

```nginx
location /LoansChart/admin { allow 203.0.113.7; deny all; proxy_pass http://127.0.0.1:3000; }
location = /admin        { allow 203.0.113.7; deny all; proxy_pass http://127.0.0.1:3000; }
```

## Установка как приложение (PWA)

Сайт можно «установить» на телефон или в браузер — он откроется в отдельном окне
без адресной строки и будет работать даже без сети (кэшируется оболочка; данные
подгружаются при наличии подключения).

- **Android / Chrome:** открыть `/LoansChart` → меню → «Установить приложение».
- **iOS / Safari:** «Поделиться» → «На экран „Домой“».
- **Desktop / Chrome, Edge:** значок установки в адресной строке.

Файлы: [`public/manifest.webmanifest`](public/manifest.webmanifest),
[`public/sw.js`](public/sw.js) (service worker),
[`public/assets/pwa.js`](public/assets/pwa.js) (регистрация). Иконка —
знак ₽ на фиолетовом (`public/assets/icon-*.png`, `apple-touch-icon-180.png`),
фавикон сайта — `public/favicon.ico` + `public/assets/favicon-{16,32}.png`.
Все иконки генерируются скриптом на Pillow; чтобы обновить закэшированную версию
после правок — поднимите `VERSION` в `sw.js`.

> **Важно:** установка и офлайн-режим работают только в защищённом контексте —
> по `https://` или на `http://localhost`. На «голом» IP по `http://` браузер
> не зарегистрирует service worker. На VPS это даёт `certbot` (см. выше).

## Данные

Одна строка — один день. Даты хранятся в формате `ГГГГ-ММ-ДД` и потому корректно
сортируются. **Деньги хранятся в копейках целыми числами** — так не бывает ошибок
округления, свойственных дробным числам. API отдаёт и принимает рубли.

```sql
CREATE TABLE entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL UNIQUE,   -- ГГГГ-ММ-ДД
  balance    INTEGER,                   -- остаток баланса, копейки
  amount     INTEGER,                   -- сумма выдач, копейки
  count      INTEGER,                   -- количество выдач, штуки
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Пустое поле сохраняется как `NULL` («нет данных») — на графике линия в этом месте
прервётся, а не упадёт в ноль.

### Резервная копия

Вся база — один файл. Копировать нужно правильно, иначе можно поймать
незавершённую транзакцию:

```bash
sqlite3 data/app.db ".backup '/backup/app-$(date +%F).db'"
```

Или просто останавливать сервис на секунду и копировать `data/`.

## API

| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/entries` | все записи, отсортированы по дате |
| `POST` | `/api/entries` | добавить; если дата уже есть — обновит запись |
| `PUT` | `/api/entries/:id` | изменить запись |
| `DELETE` | `/api/entries/:id` | удалить запись |
| `GET` | `/api/session` | нужен ли вход и выполнен ли он |
| `POST` | `/api/login` | вход, если задан `ADMIN_PASSWORD` |

Числа принимаются в свободном виде — `"523 454 325"`, `"523454325,50"`, `523454325`
разбираются одинаково. Проверяется: корректность даты, неотрицательность,
целочисленность количества, разумный потолок значений.

```bash
curl -X POST http://localhost:3000/api/entries \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-27","balance":"1 234 567","amount":"20 000 000","count":"410"}'
```
# loanschart
