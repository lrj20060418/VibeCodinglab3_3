'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

let wrappedDb = null
let opening = null
let inTx = false

function defaultDbPath() {
  const fromEnv = (process.env.LAB3_DB_PATH || '').trim()
  if (fromEnv) return fromEnv
  const dir = path.join(os.tmpdir(), 'lab3-cloudfunctions')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (_) {}
  return path.join(dir, 'app.db')
}

function initSchema(sqlDb) {
  sqlDb.run('PRAGMA foreign_keys = ON;')
  sqlDb.exec(`
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

function saveToDisk(dbPath, sqlDb) {
  const data = sqlDb.export()
  fs.writeFileSync(dbPath, Buffer.from(data))
}

function createWrapper(sqlDb, dbPath) {
  function persist() {
    if (!inTx) saveToDisk(dbPath, sqlDb)
  }

  function prepare(sql) {
    return {
      get(...args) {
        const stmt = sqlDb.prepare(sql)
        try {
          if (args.length) stmt.bind(args)
          if (!stmt.step()) return undefined
          return stmt.getAsObject()
        } finally {
          stmt.free()
        }
      },
      all(...args) {
        const stmt = sqlDb.prepare(sql)
        const rows = []
        try {
          if (args.length) stmt.bind(args)
          while (stmt.step()) rows.push(stmt.getAsObject())
          return rows
        } finally {
          stmt.free()
        }
      },
      run(...args) {
        const stmt = sqlDb.prepare(sql)
        try {
          if (args.length) stmt.bind(args)
          stmt.step()
          const changes = sqlDb.getRowsModified()
          return { changes }
        } finally {
          stmt.free()
          persist()
        }
      },
    }
  }

  function transaction(fn) {
    return () => {
      inTx = true
      sqlDb.run('BEGIN;')
      try {
        fn()
        sqlDb.run('COMMIT;')
      } catch (e) {
        try {
          sqlDb.run('ROLLBACK;')
        } catch (_) {}
        throw e
      } finally {
        inTx = false
        saveToDisk(dbPath, sqlDb)
      }
    }
  }

  return { prepare, transaction }
}

async function getDb() {
  if (wrappedDb) return wrappedDb
  if (!opening) {
    opening = (async () => {
      const initSqlJs = require('sql.js')
      const wasmDir = path.dirname(require.resolve('sql.js'))
      const SQL = await initSqlJs({
        locateFile: (file) => path.join(wasmDir, file),
      })
      const dbPath = defaultDbPath()
      let sqlDb
      if (fs.existsSync(dbPath)) {
        sqlDb = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
      } else {
        sqlDb = new SQL.Database()
      }
      initSchema(sqlDb)
      saveToDisk(dbPath, sqlDb)
      wrappedDb = createWrapper(sqlDb, dbPath)
      return wrappedDb
    })()
  }
  return opening
}

module.exports = { getDb }
