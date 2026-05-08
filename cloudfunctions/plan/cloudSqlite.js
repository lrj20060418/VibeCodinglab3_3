'use strict'

/** 单文档存 sql.js 导出，解决多实例 /tmp 不共享导致的 Plan not found */
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

async function loadSqliteFromCloud() {
  try {
    const app = getApp()
    if (!app) return null
    const r = await app.database().collection(COL).doc(DOC).get()
    const row = r.data && r.data[0]
    if (!row || !row.blob) return null
    const buf = Buffer.from(String(row.blob), 'base64')
    if (!buf.length) return null
    return new Uint8Array(buf)
  } catch (e) {
    console.error('[cloudSqlite] load failed', e.message || e)
    return null
  }
}

async function saveSqliteToCloud(sqlDb) {
  try {
    const app = getApp()
    if (!app) return
    const data = sqlDb.export()
    const blob = Buffer.from(data).toString('base64')
    await app
      .database()
      .collection(COL)
      .doc(DOC)
      .set({
        blob,
        updatedAt: Date.now(),
      })
  } catch (e) {
    console.error('[cloudSqlite] save failed', e.message || e)
  }
}

module.exports = { loadSqliteFromCloud, saveSqliteToCloud, isCloudFunctionRuntime }
