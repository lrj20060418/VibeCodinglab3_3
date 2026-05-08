'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const Database = require('better-sqlite3')

let db

function defaultDbPath() {
  const fromEnv = (process.env.LAB3_DB_PATH || '').trim()
  if (fromEnv) return fromEnv
  const dir = path.join(os.tmpdir(), 'lab3-cloudfunctions')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (_) {}
  return path.join(dir, 'app.db')
}

function initDb(database) {
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT NOT NULL,
      budget INTEGER,
      people_count INTEGER,
      preferences TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      adcode TEXT,
      note TEXT,
      sort_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_places_plan_id ON places(plan_id);
    CREATE TABLE IF NOT EXISTS itinerary_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      place_id TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE,
      FOREIGN KEY(place_id) REFERENCES places(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_itinerary_plan_id ON itinerary_items(plan_id);
  `)
}

function getDb() {
  if (!db) {
    const p = defaultDbPath()
    db = new Database(p)
    initDb(db)
  }
  return db
}

module.exports = { getDb, initDb }
