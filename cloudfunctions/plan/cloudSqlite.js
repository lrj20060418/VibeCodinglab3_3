'use strict'

/** 单文档存 sql.js 导出，解决多实例 /tmp 不共享导致的 Plan not found；用整数 version 做乐观锁，避免并发整库覆盖写丢数据 */
const COL = 'lab3_plan_sqlite'
const DOC = 'default'

let tcbApp = null
let tcbInitFailed = false

function isCloudFunctionRuntime() {
  if (String(process.env.LAB3_DISABLE_CLOUD_SQLITE || '').trim() === '1') return false
  return Boolean(
    process.env.SCF_RUNTIME_NAME ||
    process.env.TCB_ENV ||
    process.env.TENCENTCLOUD_SECRETID ||
    process.env.SCF_NAMESPACE
  )
}

function getApp() {
  if (!isCloudFunctionRuntime()) return null
  if (tcbInitFailed) return null
  if (tcbApp) return tcbApp
  try {
    const tcb = require('@cloudbase/node-sdk')
    tcbApp = tcb.init({ env: tcb.SYMBOL_DEFAULT_ENV })
    return tcbApp
  } catch (e) {
    tcbInitFailed = true
    console.error('[cloudSqlite] init failed', e.message)
    return null
  }
}

function parseRowVersion(row) {
  if (!row) return null
  const v = Number(row.version)
  if (Number.isFinite(v) && v >= 0) return v
  return null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @returns {{ buffer: Uint8Array | null, version: number }}
 */
async function loadSqliteFromCloud() {
  const app = getApp()
  if (!app) return { buffer: null, version: 0 }
  const coll = app.database().collection(COL)
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await coll.doc(DOC).get()
      const row = r.data && r.data[0]
      if (!row || !row.blob) return { buffer: null, version: 0 }

      let version = parseRowVersion(row)
      if (version === null) {
        try {
          await coll.doc(DOC).update({ version: 1 })
        } catch (e) {
          console.error('[cloudSqlite] migrate version failed', e.message || e)
        }
        version = 1
      }

      const buf = Buffer.from(String(row.blob), 'base64')
      if (!buf.length) return { buffer: null, version: 0 }
      return { buffer: new Uint8Array(buf), version }
    } catch (e) {
      lastErr = e
      console.error(`[cloudSqlite] load failed attempt ${attempt}`, e.message || e)
      if (attempt < 3) await sleep(80 * attempt)
    }
  }
  if (lastErr) console.error('[cloudSqlite] load failed after retries', lastErr.message || lastErr)
  return { buffer: null, version: 0 }
}

/**
 * CAS：优先 where(version)；若 updated=0（部分环境 _id 条件不命中），再对单文档 doc().update 回退写入。
 * @returns {{ ok: true, newVersion: number } | { ok: true, skipped: true } | { ok: false, code: 'CONFLICT' }}
 */
async function saveSqliteToCloud(sqlDb, loadedVersion) {
  const app = getApp()
  if (!app) return { ok: true, skipped: true }

  const coll = app.database().collection(COL)
  const blob = Buffer.from(sqlDb.export()).toString('base64')
  const nextVer = loadedVersion + 1

  let casRes
  try {
    casRes = await coll.where({ version: loadedVersion }).limit(1).update({
      blob,
      version: nextVer,
      updatedAt: Date.now(),
    })
  } catch (e) {
    console.error('[cloudSqlite] CAS update threw', e.message || e)
    casRes = { updated: 0 }
  }

  if (casRes.code) {
    console.error('[cloudSqlite] CAS response code', casRes.code, casRes.message)
  }

  let updated = Number(casRes.updated) || 0
  if (updated > 0) {
    return { ok: true, newVersion: nextVer }
  }

  const g = await coll.doc(DOC).get()
  const row = g.data && g.data[0]
  const rv = parseRowVersion(row)

  if (loadedVersion === 0 && !row) {
    await coll.doc(DOC).set({
      blob,
      version: 1,
      updatedAt: Date.now(),
    })
    return { ok: true, newVersion: 1 }
  }

  const versionMatch =
    row &&
    (rv === loadedVersion ||
      (rv === null && loadedVersion === 1))

  if (versionMatch) {
    const ures = await coll.doc(DOC).update({
      blob,
      version: nextVer,
      updatedAt: Date.now(),
    })
    if (ures.code) {
      throw new Error(ures.message || String(ures.code))
    }
    const u = Number(ures.updated) || 0
    if (u > 0) {
      if (updated === 0) {
        console.warn('[cloudSqlite] CAS updated 0; used doc().update fallback (singleton collection)')
      }
      return { ok: true, newVersion: nextVer }
    }
  }

  if (row && rv !== null && rv !== loadedVersion) {
    return { ok: false, code: 'CONFLICT' }
  }

  return { ok: false, code: 'CONFLICT' }
}

/**
 * 仅读 version/updatedAt，避免每次比对都拉整份 blob。
 * @returns {Promise<{ version: number, legacy?: boolean } | null>}
 */
async function fetchSqliteRemoteVersion() {
  try {
    const app = getApp()
    if (!app) return null
    const coll = app.database().collection(COL)
    const r = await coll.doc(DOC).field({ version: true, updatedAt: true }).get()
    if (r.code) return null
    const row = r.data && r.data[0]
    if (!row) return { version: 0 }
    const v = parseRowVersion(row)
    if (v === null) return { version: 0, legacy: true }
    return { version: v }
  } catch (e) {
    console.error('[cloudSqlite] meta read failed', e.message || e)
    return null
  }
}

module.exports = {
  loadSqliteFromCloud,
  saveSqliteToCloud,
  isCloudFunctionRuntime,
  fetchSqliteRemoteVersion,
}
