'use strict';
/**
 * Слой доступа к базе.
 *
 * Драйвер выбирается автоматически:
 *   1) node:sqlite — встроен в Node 22.5+, ставить ничего не нужно;
 *   2) better-sqlite3 — если Node старее, поставьте `npm i better-sqlite3`.
 * API у них совпадает в той части, которую мы используем (prepare/run/get/all),
 * поэтому остальной код о драйвере не знает.
 *
 * ДЕНЬГИ ХРАНЯТСЯ В КОПЕЙКАХ (целые числа). Так не бывает ошибок округления,
 * характерных для дробных чисел. Наружу, в API, отдаются рубли.
 */

const path = require('node:path');
const fs = require('node:fs');

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    return { db, driver: 'node:sqlite' };
  } catch (e) {
    try {
      const Database = require('better-sqlite3');
      return { db: new Database(file), driver: 'better-sqlite3' };
    } catch (e2) {
      throw new Error(
        'Нет драйвера SQLite. Нужен Node.js 22.5+ (встроенный node:sqlite) ' +
        'или установите пакет: npm i better-sqlite3'
      );
    }
  }
}

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db');
const { db, driver } = openDatabase(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL UNIQUE,   -- ISO, ГГГГ-ММ-ДД: сортируется как строка
    balance    INTEGER,                   -- остаток баланса, КОПЕЙКИ
    amount     INTEGER,                   -- сумма выдач,     КОПЕЙКИ
    count      INTEGER,                   -- количество выдач, штуки
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

  -- почасовая разбивка внутри дня: одна строка — один час одного дня
  CREATE TABLE IF NOT EXISTS hour_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,          -- ISO, ГГГГ-ММ-ДД
    hour       INTEGER NOT NULL,          -- 0..23
    balance    INTEGER,                   -- остаток баланса, КОПЕЙКИ
    amount     INTEGER,                   -- сумма выдач,     КОПЕЙКИ
    count      INTEGER,                   -- количество выдач, штуки
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, hour)
  );

  CREATE INDEX IF NOT EXISTS idx_hour_entries_date ON hour_entries(date);
`);

/* ------------------------------------------------------------------ */
/* Преобразование рубли <-> копейки                                     */
/* ------------------------------------------------------------------ */
const toKopecks = r => (r === null || r === undefined ? null : Math.round(r * 100));
const toRubles  = k => (k === null || k === undefined ? null : k / 100);

const rowToApi = row => row && ({
  id:      row.id,
  date:    row.date,
  balance: toRubles(row.balance),
  amount:  toRubles(row.amount),
  count:   row.count === null || row.count === undefined ? null : Number(row.count),
  updatedAt: row.updated_at
});

const hourRowToApi = row => row && ({
  id:      row.id,
  date:    row.date,
  hour:    Number(row.hour),
  balance: toRubles(row.balance),
  amount:  toRubles(row.amount),
  count:   row.count === null || row.count === undefined ? null : Number(row.count),
  updatedAt: row.updated_at
});

/* ------------------------------------------------------------------ */
/* Запросы                                                             */
/* ------------------------------------------------------------------ */
const q = {
  list:      db.prepare('SELECT * FROM entries ORDER BY date ASC'),
  byId:      db.prepare('SELECT * FROM entries WHERE id = ?'),
  byDate:    db.prepare('SELECT * FROM entries WHERE date = ?'),
  insert:    db.prepare(
    'INSERT INTO entries (date, balance, amount, count) VALUES (?, ?, ?, ?)'
  ),
  updateById: db.prepare(
    `UPDATE entries SET date = ?, balance = ?, amount = ?, count = ?,
            updated_at = datetime('now') WHERE id = ?`
  ),
  remove:    db.prepare('DELETE FROM entries WHERE id = ?'),

  hoursByDate:  db.prepare('SELECT * FROM hour_entries WHERE date = ? ORDER BY hour ASC'),
  hoursRecent:  db.prepare(
    'SELECT * FROM hour_entries ORDER BY date DESC, hour DESC LIMIT ?'
  ),
  hourById:     db.prepare('SELECT * FROM hour_entries WHERE id = ?'),
  hourBySlot:   db.prepare('SELECT * FROM hour_entries WHERE date = ? AND hour = ?'),
  hourInsert:   db.prepare(
    'INSERT INTO hour_entries (date, hour, balance, amount, count) VALUES (?, ?, ?, ?, ?)'
  ),
  hourUpdateById: db.prepare(
    `UPDATE hour_entries SET date = ?, hour = ?, balance = ?, amount = ?, count = ?,
            updated_at = datetime('now') WHERE id = ?`
  ),
  hourRemove:   db.prepare('DELETE FROM hour_entries WHERE id = ?')
};

const api = {
  driver,
  file: DB_FILE,

  list() {
    return q.list.all().map(rowToApi);
  },

  get(id) {
    return rowToApi(q.byId.get(id));
  },

  getByDate(date) {
    return rowToApi(q.byDate.get(date));
  },

  /** Создаёт запись; если запись на эту дату уже есть — обновляет её. */
  upsert({ date, balance, amount, count }) {
    const existing = q.byDate.get(date);
    if (existing) {
      q.updateById.run(date, toKopecks(balance), toKopecks(amount), count, existing.id);
      return rowToApi(q.byId.get(existing.id));
    }
    const res = q.insert.run(date, toKopecks(balance), toKopecks(amount), count);
    const id = Number(res.lastInsertRowid);
    return rowToApi(q.byId.get(id));
  },

  update(id, { date, balance, amount, count }) {
    q.updateById.run(date, toKopecks(balance), toKopecks(amount), count, id);
    return rowToApi(q.byId.get(id));
  },

  remove(id) {
    const res = q.remove.run(id);
    return Number(res.changes) > 0;
  },

  /* --------------------------------------------------------------- */
  /* Почасовая разбивка внутри дня                                    */
  /* --------------------------------------------------------------- */
  hours: {
    /** Все заполненные часы указанной даты, отсортированы по часу. */
    listByDate(date) {
      return q.hoursByDate.all(date).map(hourRowToApi);
    },

    /** Последние n внесённых часов: новые сверху (по дате, затем по часу). */
    recent(n = 2) {
      return q.hoursRecent.all(Math.max(1, Math.min(50, n | 0))).map(hourRowToApi);
    },

    get(id) {
      return hourRowToApi(q.hourById.get(id));
    },

    getBySlot(date, hour) {
      return hourRowToApi(q.hourBySlot.get(date, hour));
    },

    /** Создаёт строку часа; если строка на этот час уже есть — обновляет её. */
    upsert({ date, hour, balance, amount, count }) {
      const existing = q.hourBySlot.get(date, hour);
      if (existing) {
        q.hourUpdateById.run(
          date, hour, toKopecks(balance), toKopecks(amount), count, existing.id
        );
        return hourRowToApi(q.hourById.get(existing.id));
      }
      const res = q.hourInsert.run(
        date, hour, toKopecks(balance), toKopecks(amount), count
      );
      return hourRowToApi(q.hourById.get(Number(res.lastInsertRowid)));
    },

    update(id, { date, hour, balance, amount, count }) {
      q.hourUpdateById.run(
        date, hour, toKopecks(balance), toKopecks(amount), count, id
      );
      return hourRowToApi(q.hourById.get(id));
    },

    remove(id) {
      const res = q.hourRemove.run(id);
      return Number(res.changes) > 0;
    }
  }
};

module.exports = api;
