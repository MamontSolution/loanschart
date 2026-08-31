'use strict';
/**
 * HTTP-сервер без фреймворков: только стандартная библиотека Node.
 *
 *   GET    /                    лендинг с графиками
 *   GET    /admin               страница ввода данных
 *   GET    /api/entries         список записей
 *   POST   /api/entries         добавить (повтор даты — обновляет запись)
 *   PUT    /api/entries/:id     изменить
 *   DELETE /api/entries/:id     удалить
 *
 * Пароль на страницу ввода выключен. Чтобы включить — задайте переменную
 * окружения ADMIN_PASSWORD; тогда /admin и все изменяющие запросы потребуют вход.
 */

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db   = require('./db');

const PORT      = Number(process.env.PORT || 3000);
const HOST      = process.env.HOST || '0.0.0.0';
const PASSWORD  = process.env.ADMIN_PASSWORD || '';
const PUBLIC    = path.join(__dirname, 'public');
const AUTH_ON   = PASSWORD.length > 0;

/* ------------------------------------------------------------------ */
/* Сессии (в памяти; при перезапуске все выходят — это нормально)       */
/* ------------------------------------------------------------------ */
const sessions = new Set();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function issueSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  setTimeout(() => sessions.delete(token), SESSION_TTL).unref?.();
  return token;
}
function isAuthed(req) {
  if (!AUTH_ON) return true;
  const raw = req.headers.cookie || '';
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(raw);
  return !!(m && sessions.has(m[1]));
}
/** Сравнение, не зависящее от времени выполнения — против подбора по таймингу. */
function passwordMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Вспомогательное                                                     */
/* ------------------------------------------------------------------ */
function sendJson(res, code, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Тело запроса слишком большое')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function serveFile(res, file, cache = 'no-cache') {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
               return res.end('Не найдено'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cache
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Валидация входящей записи                                           */
/* ------------------------------------------------------------------ */
const MAX_MONEY = 1e13;   // 10 трлн рублей — заведомо выше любого разумного значения
const MAX_COUNT = 1e7;

/** "523 454 325,50", "р.523454325", 523454325 → 523454325.5 ; пусто → null */
function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replace(/\p{L}+\.?/gu, '').replace(/[^\d,.\-]/g, '');
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (commas && dots) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (commas > 1) s = s.replace(/,/g, '');
  else if (commas === 1) s = s.replace(',', '.');
  else if (dots > 1) s = s.replace(/\./g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function validate(body) {
  const errors = [];
  const date = String(body.date || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push('Дата должна быть в формате ГГГГ-ММ-ДД');
  } else {
    const d = new Date(date + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date)
      errors.push('Такой даты не существует');
  }

  const out = { date };
  for (const [field, label, max, integer] of [
    ['balance', 'Остаток баланса', MAX_MONEY, false],
    ['amount',  'Сумма выдач',     MAX_MONEY, false],
    ['count',   'Количество выдач', MAX_COUNT, true]
  ]) {
    const n = parseMoney(body[field]);
    if (Number.isNaN(n)) { errors.push(label + ': не число'); continue; }
    if (n === null) { out[field] = null; continue; }
    if (n < 0)   { errors.push(label + ': не может быть отрицательным'); continue; }
    if (n > max) { errors.push(label + ': слишком большое значение'); continue; }
    if (integer && !Number.isInteger(n)) { errors.push(label + ': должно быть целым'); continue; }
    out[field] = n;
  }

  if (out.balance === null && out.amount === null && out.count === null)
    errors.push('Заполните хотя бы один показатель');

  return { errors, value: out };
}

/** То же, что validate, плюс поле «час» (целое 0..23). */
function validateHour(body) {
  const { errors, value } = validate(body);
  const hour = Number(body.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    errors.push('Час должен быть целым числом от 0 до 23');
  else value.hour = hour;
  return { errors, value };
}

/* ------------------------------------------------------------------ */
/* Маршрутизация                                                       */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  try {
    /* --- вход по паролю (только если ADMIN_PASSWORD задан) --- */
    if (pathname === '/api/session' && method === 'GET')
      return sendJson(res, 200, { authRequired: AUTH_ON, authenticated: isAuthed(req) });

    if (pathname === '/api/login' && method === 'POST') {
      if (!AUTH_ON) return sendJson(res, 200, { ok: true });
      const body = await readJsonBody(req);
      if (!passwordMatches(body.password))
        return sendJson(res, 401, { error: 'Неверный пароль' });
      const token = issueSession();
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`
      });
    }

    /* --- чтение данных: открыто всегда, лендинг публичный --- */
    if (pathname === '/api/entries' && method === 'GET')
      return sendJson(res, 200, db.list());

    if (pathname === '/api/hours/recent' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 2;
      return sendJson(res, 200, db.hours.recent(limit));
    }

    if (pathname === '/api/hours' && method === 'GET') {
      const date = String(url.searchParams.get('date') || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return sendJson(res, 400, { error: 'Укажите дату в формате ГГГГ-ММ-ДД' });
      return sendJson(res, 200, db.hours.listByDate(date));
    }

    /* --- изменение данных --- */
    const isMutation =
      (pathname.startsWith('/api/entries') || pathname.startsWith('/api/hours')) &&
      method !== 'GET';
    if (isMutation && !isAuthed(req))
      return sendJson(res, 401, { error: 'Требуется вход' });

    if (pathname === '/api/hours' && method === 'POST') {
      const body = await readJsonBody(req);
      const { errors, value } = validateHour(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join('. ') });
      const existed = !!db.hours.getBySlot(value.date, value.hour);
      return sendJson(res, existed ? 200 : 201, db.hours.upsert(value));
    }

    const hm = /^\/api\/hours\/(\d+)$/.exec(pathname);
    if (hm) {
      const id = Number(hm[1]);
      if (!db.hours.get(id)) return sendJson(res, 404, { error: 'Час не найден' });

      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const { errors, value } = validateHour(body);
        if (errors.length) return sendJson(res, 400, { error: errors.join('. ') });
        const clash = db.hours.getBySlot(value.date, value.hour);
        if (clash && clash.id !== id)
          return sendJson(res, 409, { error: 'Этот час на выбранную дату уже заполнен' });
        return sendJson(res, 200, db.hours.update(id, value));
      }
      if (method === 'DELETE') {
        db.hours.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'Метод не поддерживается' });
    }

    if (pathname === '/api/entries' && method === 'POST') {
      const body = await readJsonBody(req);
      const { errors, value } = validate(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join('. ') });
      const existed = !!db.getByDate(value.date);
      return sendJson(res, existed ? 200 : 201, db.upsert(value));
    }

    const m = /^\/api\/entries\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (!db.get(id)) return sendJson(res, 404, { error: 'Запись не найдена' });

      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const { errors, value } = validate(body);
        if (errors.length) return sendJson(res, 400, { error: errors.join('. ') });
        const clash = db.getByDate(value.date);
        if (clash && clash.id !== id)
          return sendJson(res, 409, { error: 'Запись на эту дату уже есть' });
        return sendJson(res, 200, db.update(id, value));
      }
      if (method === 'DELETE') {
        db.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'Метод не поддерживается' });
    }

    if (pathname.startsWith('/api/'))
      return sendJson(res, 404, { error: 'Неизвестный маршрут' });

    /* --- статика --- */
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Метод не поддерживается');
    }

    // страницы живут под /LoansChart; старые адреса перенаправляем
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(301, { Location: '/LoansChart' });
      return res.end();
    }
    if (pathname === '/admin' || pathname === '/admin/') {
      res.writeHead(301, { Location: '/LoansChart/admin' });
      return res.end();
    }
    if (pathname === '/LoansChart' || pathname === '/LoansChart/')
      return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (pathname === '/LoansChart/admin' || pathname === '/LoansChart/admin/')
      return serveFile(res, path.join(PUBLIC, 'admin.html'));

    // защита от выхода за пределы каталога public
    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Запрещено');
    }
    return serveFile(res, file);

  } catch (err) {
    const client = /JSON|слишком большое/i.test(err.message);
    if (!client) console.error(err);
    return sendJson(res, client ? 400 : 500,
      { error: client ? err.message : 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Сервер запущен: http://${HOST}:${PORT}`);
  console.log(`  лендинг       /LoansChart`);
  console.log(`  ввод данных   /LoansChart/admin`);
  console.log(`  база          ${db.file}  (драйвер: ${db.driver})`);
  console.log(`  пароль        ${AUTH_ON ? 'включён' : 'выключен (ADMIN_PASSWORD не задан)'}`);
});
