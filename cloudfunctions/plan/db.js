'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  loadSqliteFromCloud,
  saveSqliteToCloud,
  isCloudFunctionRuntime,
  fetchSqliteRemoteVersion,
} = require('./cloudSqlite')

let wrappedDb = null
let opening = null
/** 每次 invalidate 递增，防止「已作废的 opening」完成后把旧库写回 wrappedDb */
let dbOpenGeneration = 0
let inTx = false
/** 本请求内若有写库，结束时上传到文档库 */
let pendingCloudSqlDb = null
/** 与文档库 lab3_plan_sqlite 中 version 对齐，供 CAS 保存 */
let cloudCasVersion = 0

/** 上次 flush 冲突后，下一次请求强制从云端重拉 */
let forceReloadNext = false

/**
 * 轻量读 version 的节流。默认 2s：多数请求跳过二次网络，明显缩短首屏/列表耗时；
 * 跨浏览器刚保存仍可由 plan-miss heal 或下一轮 TTL 后比对拉新。需要更激进一致可设 LAB3_CLOUD_META_TTL_MS=0。
 */
let lastMetaCheckAt = 0
let lastRemoteVersion = -1
const _ttlRaw = process.env.LAB3_CLOUD_META_TTL_MS
const META_TTL_MS =
  _ttlRaw === undefined || _ttlRaw === ''
    ? 2000
    : Math.max(0, Number(_ttlRaw)) || 0

/** sql.js WASM 引擎只初始化一次 */
let sqlJsEnginePromise = null
function getSqlJsEngine() {
  if (!sqlJsEnginePromise) {
    sqlJsEnginePromise = (async () => {
      const initSqlJs = require('sql.js')
      const wasmDir = path.dirname(require.resolve('sql.js'))
      return initSqlJs({
        locateFile: (file) => path.join(wasmDir, file),
      })
    })()
  }
  return sqlJsEnginePromise
}

function invalidateMemoryDb() {
  dbOpenGeneration++
  wrappedDb = null
  opening = null
  pendingCloudSqlDb = null
  inTx = false
  cloudCasVersion = 0
  lastMetaCheckAt = 0
  lastRemoteVersion = -1
}

/**
 * 在 getDb() 前调用：同容器内复用内存库；仅当云端 version 变新或强制标记时重拉整库。
 * @param {{ forceReloadBlob?: boolean }} [opts] forceReloadBlob：丢弃本实例缓存并从云端整包重拉（用于 GET/PUT 单条规划，避免换浏览器打到另一实例时仍用旧内存快照）。
 */
async function preparePlanDbForRequest(opts = {}) {
  if (opts.forceReloadBlob) {
    invalidateMemoryDb()
  }
  if (opening) {
    try {
      await opening
    } catch (_) {
      /* opening 失败由后续 getDb 重试 */
    }
  }

  if (forceReloadNext) {
    invalidateMemoryDb()
    forceReloadNext = false
    return
  }

  if (!isCloudFunctionRuntime()) return
  if (!wrappedDb) return

  const now = Date.now()
  if (
    META_TTL_MS > 0 &&
    lastMetaCheckAt > 0 &&
    now - lastMetaCheckAt < META_TTL_MS &&
    lastRemoteVersion <= cloudCasVersion
  ) {
    return
  }

  const meta = await fetchSqliteRemoteVersion()
  lastMetaCheckAt = Date.now()
  if (!meta) return
  if (meta.legacy) return

  const remote = Number(meta.version)
  if (!Number.isFinite(remote)) return
  lastRemoteVersion = remote

  if (remote > cloudCasVersion) {
    console.warn(
      '[db] remote sqlite version',
      remote,
      '> local cloudCasVersion',
      cloudCasVersion,
      '— invalidate and reload on this instance'
    )
    invalidateMemoryDb()
  }
}

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

function markCloudDirty(sqlDb) {
  pendingCloudSqlDb = sqlDb
}

function createWrapper(sqlDb, dbPath) {
  function persist() {
    if (!inTx) {
      saveToDisk(dbPath, sqlDb)
      markCloudDirty(sqlDb)
    }
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
        markCloudDirty(sqlDb)
      }
    }
  }

  return { prepare, transaction }
}

async function getDb() {
  for (let attempt = 0; attempt < 16; attempt++) {
    if (wrappedDb) return wrappedDb
    if (!opening) {
      const genAtStart = dbOpenGeneration
      opening = (async () => {
        const SQL = await getSqlJsEngine()
        const dbPath = defaultDbPath()
        let sqlDb
        let loadedLocalFile = false
        const { buffer: cloudBuf, version: loadedCloudVersion } = await loadSqliteFromCloud()
        if (genAtStart !== dbOpenGeneration) {
          console.warn('[db] discard cloud load: generation changed during fetch')
          return null
        }
        cloudCasVersion = loadedCloudVersion
        const tmpFallback =
          String(process.env.LAB3_TMP_SQLITE_FALLBACK || '').trim() === '1'
        const useLocalTmpFile =
          fs.existsSync(dbPath) &&
          (!isCloudFunctionRuntime() || tmpFallback)
        if (cloudBuf && cloudBuf.length) {
          sqlDb = new SQL.Database(cloudBuf)
        } else if (useLocalTmpFile) {
          sqlDb = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
          loadedLocalFile = true
        } else {
          sqlDb = new SQL.Database()
        }
        initSchema(sqlDb)
        if (loadedLocalFile && isCloudFunctionRuntime() && !(cloudBuf && cloudBuf.length)) {
          try {
            const row = sqlDb.prepare('SELECT COUNT(*) AS c FROM plans').get()
            if (row && Number(row.c) > 0) markCloudDirty(sqlDb)
          } catch (_) {}
        }
        saveToDisk(dbPath, sqlDb)
        if (genAtStart !== dbOpenGeneration) {
          console.warn('[db] discard cloud load: generation changed before wrap')
          return null
        }
        wrappedDb = createWrapper(sqlDb, dbPath)
        return wrappedDb
      })()
    }
    let w
    try {
      w = await opening
    } catch (e) {
      opening = null
      throw e
    }
    opening = null
    if (w) return w
    if (wrappedDb) return wrappedDb
  }
  throw new Error('getDb: too many stale-load retries')
}

/**
 * @returns {{ ok: true, skipped?: boolean, newVersion?: number } | { ok: false, code: string, message?: string }}
 */
async function flushPendingCloud() {
  const sqlDb = pendingCloudSqlDb
  if (!sqlDb) {
    return { ok: true, skipped: true }
  }
  pendingCloudSqlDb = null
  try {
    const r = await saveSqliteToCloud(sqlDb, cloudCasVersion)
    if (r && r.skipped) {
      return { ok: true, skipped: true }
    }
    const nv =
      r && r.ok && r.newVersion != null && r.newVersion !== ''
        ? Number(r.newVersion)
        : NaN
    if (r && r.ok && Number.isFinite(nv)) {
      cloudCasVersion = nv
      lastRemoteVersion = nv
      return { ok: true, newVersion: nv }
    }
    if (r && r.code === 'CONFLICT') {
      forceReloadNext = true
      pendingCloudSqlDb = sqlDb
      console.error(
        '[db] cloud sqlite CONFLICT — 云端版本已变，本次未写入文档库；已重新排队待同步'
      )
      return { ok: false, code: 'CONFLICT' }
    }
    pendingCloudSqlDb = sqlDb
    console.error('[db] flush cloud: unexpected save result', r)
    return { ok: false, code: 'SYNC_FAILED' }
  } catch (e) {
    console.error('[db] flush cloud failed', e.message || e)
    pendingCloudSqlDb = sqlDb
    return { ok: false, code: 'ERROR', message: String(e.message || e) }
  }
}

/**
 * 本地 SQLite 中找不到规划等数据时调用：丢弃内存库并从云端整包重拉一次（自愈他实例刚写入 / 读延迟）。
 */
async function reloadDbFromCloudOnceAfterMiss() {
  console.warn('[db] plan-miss heal: reload full sqlite snapshot from cloud')
  invalidateMemoryDb()
  await getDb()
}

/** @deprecated 保留兼容；缓存策略已改为 preparePlanDbForRequest + 云端 version */
function setDbRequestScope(_scopeId) {}

module.exports = {
  getDb,
  flushPendingCloud,
  preparePlanDbForRequest,
  reloadDbFromCloudOnceAfterMiss,
  setDbRequestScope,
}
