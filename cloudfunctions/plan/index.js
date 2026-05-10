'use strict'

const { randomUUID } = require('crypto')
const {
  getDb,
  flushPendingCloud,
  preparePlanDbForRequest,
  reloadDbFromCloudOnceAfterMiss,
} = require('./db')
const { isCloudFunctionRuntime } = require('./cloudSqlite')
const { fetchLiveWeatherByAdcode } = require('./amapWeather')
const { chatComplete, streamChatComplete } = require('./llm')
const { buildChecks } = require('./checks')
const { buildPlanExportJson, buildPlanExportMd } = require('./exportBuild')
const { corsHeaders } = require('./corsOrigin')

const ALLOWED_SLOTS = new Set(['morning', 'afternoon', 'evening'])

/** 云 SQLite 与多实例读延迟：单次 miss 后只拉一次库仍可能空，允许少量重试 */
const PLAN_MISS_MAX_HEAL = 7
const PLAN_MISS_HEAL_BACKOFF_MS = 220

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 规划写入后同步文档库；失败时带一次退避重试（减轻偶发网络抖动）。 */
async function flushPlanDbOrError(event) {
  let r = await flushPendingCloud()
  if (r && r.ok === false && r.code !== 'CONFLICT') {
    await sleep(300)
    r = await flushPendingCloud()
  }
  if (r && r.ok === false) {
    let msg =
      r.code === 'CONFLICT'
        ? '云端数据已在别处更新，请先刷新列表再保存'
        : '写入云端失败，请稍后重试'
    if (r.code === 'ERROR' && r.message) {
      msg = `写入云端失败：${r.message}`
    } else if (r.code === 'SYNC_FAILED') {
      msg =
        '写入云端失败：云数据库返回异常（常见为网络抖动、文档过大超限、或集合权限）。请稍后重试；若持续出现请查看云函数日志中的 [db] flush cloud / [cloudSqlite]。'
    }
    return httpError(event, 409, msg)
  }
  return null
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function normalizePath(event) {
  let raw =
    event.path ||
    event.url ||
    event.requestContext?.http?.path ||
    event.requestContext?.path ||
    '/'
  if (typeof raw !== 'string') raw = '/'
  const q = raw.indexOf('?')
  if (q >= 0) raw = raw.slice(0, q)
  const idx = raw.indexOf('/api/')
  if (idx >= 0) raw = raw.slice(idx)
  if (!raw.startsWith('/')) raw = '/' + raw
  // 部分网关只保留 /plans/:id，与路由统一为 /api/plans/:id
  const plansOnly = raw.match(/^\/plans\/([^/]+)$/)
  if (plansOnly) raw = `/api/plans/${plansOnly[1]}`
  return raw
}

function safeDecodePathSegment(seg) {
  if (seg == null || typeof seg !== 'string') return seg
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

function getQuery(event) {
  const q = event.queryStringParameters || event.query || {}
  if (q && typeof q === 'object') return q
  return {}
}

function parseBody(event) {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function httpJson(event, statusCode, data) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      ...corsHeaders(event),
    },
    body: JSON.stringify(data),
  }
}

function httpError(event, statusCode, message) {
  return httpJson(event, statusCode, { detail: message })
}

function buildSummaryMessages(planRow, placeRows, itineraryRows, weatherByPlace, style) {
  const placeName = Object.fromEntries(placeRows.map((p) => [p.id, p.name || '地点']))
  const groups = { morning: [], afternoon: [], evening: [] }
  for (const it of itineraryRows) {
    if (groups[it.time_slot]) groups[it.time_slot].push(it.place_id)
  }
  const fmtSlot = (key, label) => {
    const ids = groups[key] || []
    if (!ids.length) return `${label}：未安排`
    return `${label}：` + ids.map((i) => placeName[i] || i).join('、')
  }
  const itineraryText = [fmtSlot('morning', '上午'), fmtSlot('afternoon', '下午'), fmtSlot('evening', '晚上')].join(
    '\n'
  )
  const styleHint = {
    short: '输出 6-10 行以内，直给重点。',
    normal: '输出 10-18 行左右，分点说明。',
    detailed: '输出更详细一些，分点+小标题。',
  }[style] || '输出 10-18 行左右，分点说明。'
  const system =
    '你是一个出行规划助手。你的任务是对用户的出行规划做总结和改进建议。' +
    '你必须基于提供的规划信息回答，不要编造不存在的地点或天气。' +
    '输出中文，结构清晰，给出：优点、风险/不合理点、可改进建议。'
  const context = {
    plan: {
      title: planRow.title,
      date: planRow.date,
      budget: planRow.budget,
      people_count: planRow.people_count,
      preferences: planRow.preferences,
    },
    places: placeRows.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      adcode: p.adcode,
    })),
    itinerary_text: itineraryText,
    weather_by_place: weatherByPlace,
  }
  return [
    { role: 'system', content: system },
    { role: 'system', content: `输出要求：${styleHint}` },
    { role: 'system', content: `规划上下文（JSON）：\n${JSON.stringify(context)}` },
    { role: 'user', content: '请给出本次规划的 AI 辅助总结。' },
  ]
}

function httpSse(event, statusCode, bodyText) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(event),
    },
    body: bodyText,
  }
}

async function loadPlanBundle(planId) {
  const db = await getDb()
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) return null
  const places = db
    .prepare(
      'SELECT * FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
    )
    .all(planId)
  const itinerary = db
    .prepare(
      'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
    )
    .all(planId)

  const weatherByPlace = {}
  for (const p of places) {
    const adcode = String(p.adcode || '').trim()
    if (!adcode) continue
    try {
      weatherByPlace[p.id] = await fetchLiveWeatherByAdcode(adcode)
    } catch (_) {
      /* skip */
    }
  }
  return { plan, places, itinerary, weatherByPlace }
}

exports.main = async (event, context) => {
  const httpMethod = event.httpMethod || event.method || ''
  if (String(httpMethod).toUpperCase() === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' }
  }

  const method = String(httpMethod || 'GET').toUpperCase()
  const path = normalizePath(event)

  if (path === '/health' && method === 'GET') {
    return httpJson(event,200, { ok: true })
  }

  /**
   * 仅「打开单条规划 GET」强制整包重拉：换浏览器/换实例时与列表对齐。
   * 不在 PUT / 列表 GET 上强拉：否则每次保存 = 先整包下载再整包上传，极慢且易在 refresh 时读到空列表。
   */
  const forceReloadPlanBlob = method === 'GET' && /^\/api\/plans\/[^/]+$/.test(path)

  await preparePlanDbForRequest({ forceReloadBlob: forceReloadPlanBlob })

  let db = await getDb()
  const body = parseBody(event)
  const query = getQuery(event)

  try {
    async function withDbAfterPlanMissRetry(planId, readFn) {
      for (let attempt = 0; attempt < PLAN_MISS_MAX_HEAL; attempt++) {
        const row = readFn(db)
        if (row) return row
        if (attempt < PLAN_MISS_MAX_HEAL - 1) {
          await reloadDbFromCloudOnceAfterMiss()
          if (PLAN_MISS_HEAL_BACKOFF_MS > 0) await sleep(PLAN_MISS_HEAL_BACKOFF_MS)
          db = await getDb()
        }
      }
      return null
    }

    async function loadPlanBundleWithHeal(planId) {
      for (let attempt = 0; attempt < PLAN_MISS_MAX_HEAL; attempt++) {
        const b = await loadPlanBundle(planId)
        if (b) {
          db = await getDb()
          return b
        }
        if (attempt < PLAN_MISS_MAX_HEAL - 1) {
          await reloadDbFromCloudOnceAfterMiss()
          if (PLAN_MISS_HEAL_BACKOFF_MS > 0) await sleep(PLAN_MISS_HEAL_BACKOFF_MS)
          db = await getDb()
        }
      }
      return null
    }

    /* ---- Plans ---- */
    if (path === '/api/plans' && method === 'GET') {
      let rows = db.prepare('SELECT * FROM plans ORDER BY datetime(updated_at) DESC').all()
      if (rows.length === 0 && isCloudFunctionRuntime()) {
        for (let attempt = 0; attempt < PLAN_MISS_MAX_HEAL - 1 && rows.length === 0; attempt++) {
          await reloadDbFromCloudOnceAfterMiss()
          if (PLAN_MISS_HEAL_BACKOFF_MS > 0) await sleep(PLAN_MISS_HEAL_BACKOFF_MS)
          db = await getDb()
          rows = db.prepare('SELECT * FROM plans ORDER BY datetime(updated_at) DESC').all()
        }
      }
      return httpJson(event,200, rows)
    }

    if (path === '/api/plans' && method === 'POST') {
      if (!body.date) return httpError(event,400, 'date required')
      const id = randomUUID()
      const t = nowIso()
      db.prepare(
        `INSERT INTO plans (id, title, date, budget, people_count, preferences, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.title ?? null,
        body.date,
        body.budget ?? null,
        body.people_count ?? null,
        body.preferences ?? null,
        t,
        t
      )
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id)
      const flushErr = await flushPlanDbOrError(event)
      if (flushErr) return flushErr
      return httpJson(event,200, row)
    }

    let m = path.match(/^\/api\/plans\/([^/]+)$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const row = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      )
      if (!row) return httpError(event,404, 'Plan not found')
      return httpJson(event,200, row)
    }

    if (m && method === 'PUT') {
      const planId = safeDecodePathSegment(m[1])
      const cur = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      )
      if (!cur) return httpError(event,404, 'Plan not found')
      const merged = {
        ...cur,
        ...('title' in body ? { title: body.title } : {}),
        ...('date' in body ? { date: body.date } : {}),
        ...('budget' in body ? { budget: body.budget } : {}),
        ...('people_count' in body ? { people_count: body.people_count } : {}),
        ...('preferences' in body ? { preferences: body.preferences } : {}),
        updated_at: nowIso(),
      }
      db.prepare(
        `UPDATE plans SET title=?, date=?, budget=?, people_count=?, preferences=?, updated_at=? WHERE id=?`
      ).run(
        merged.title,
        merged.date,
        merged.budget,
        merged.people_count,
        merged.preferences,
        merged.updated_at,
        planId
      )
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      const flushErr = await flushPlanDbOrError(event)
      if (flushErr) return flushErr
      return httpJson(event,200, row)
    }

    /* ---- Places ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/places$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const plan = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!plan) return httpError(event,404, 'Plan not found')
      const rows = db
        .prepare(
          'SELECT * FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      return httpJson(event,200, rows)
    }

    if (m && method === 'POST') {
      const planId = safeDecodePathSegment(m[1])
      const plan = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!plan) return httpError(event,404, 'Plan not found')
      const placeId = randomUUID()
      const t = nowIso()
      db.prepare(
        `INSERT INTO places (id, plan_id, name, address, lng, lat, adcode, note, sort_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        placeId,
        planId,
        body.name,
        body.address ?? null,
        body.lng,
        body.lat,
        body.adcode ?? null,
        body.note ?? null,
        body.sort_index ?? 0,
        t
      )
      const row = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId)
      await flushPendingCloud()
      return httpJson(event,200, row)
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/places\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const planId = safeDecodePathSegment(m[1])
      const placeId = safeDecodePathSegment(m[2])
      const plan = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!plan) return httpError(event,404, 'Plan not found')
      const info = db.prepare('DELETE FROM places WHERE id = ? AND plan_id = ?').run(placeId, planId)
      if (info.changes === 0) return httpError(event,404, 'Place not found')
      await flushPendingCloud()
      return httpJson(event,200, { ok: true })
    }

    /* ---- Itinerary ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/itinerary$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const plan = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!plan) return httpError(event,404, 'Plan not found')
      const rows = db
        .prepare(
          'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      return httpJson(event,200, rows)
    }

    if (m && method === 'PUT') {
      const planId = safeDecodePathSegment(m[1])
      const plan = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!plan) return httpError(event,404, 'Plan not found')
      const placeRows = db.prepare('SELECT id FROM places WHERE plan_id = ?').all(planId)
      const placeIds = new Set(placeRows.map((r) => r.id))
      const items = Array.isArray(body.items) ? body.items : []
      for (const it of items) {
        if (!ALLOWED_SLOTS.has(it.time_slot)) return httpError(event,400, `Invalid time_slot: ${it.time_slot}`)
        if (!placeIds.has(it.place_id)) return httpError(event,400, `Invalid place_id: ${it.place_id}`)
      }
      const t = nowIso()
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM itinerary_items WHERE plan_id = ?').run(planId)
        const ins = db.prepare(
          `INSERT INTO itinerary_items (id, plan_id, place_id, time_slot, sort_index, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        for (const it of items) {
          ins.run(randomUUID(), planId, it.place_id, it.time_slot, it.sort_index ?? 0, t)
        }
      })
      tx()
      const rows = db
        .prepare(
          'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      await flushPendingCloud()
      return httpJson(event,200, rows)
    }

    /* ---- Export / checks ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/export$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const bundle = await loadPlanBundleWithHeal(planId)
      if (!bundle) return httpError(event,404, 'Plan not found')
      const fmt = String(query.format || 'md').toLowerCase().trim()
      if (fmt !== 'md' && fmt !== 'json') return httpError(event,400, 'format must be md or json')
      if (fmt === 'json') {
        return httpJson(event,200, {
          format: 'json',
          content: buildPlanExportJson(bundle),
        })
      }
      return httpJson(event,200, {
        format: 'md',
        content: buildPlanExportMd(bundle),
      })
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/checks$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const bundle = await loadPlanBundleWithHeal(planId)
      if (!bundle) return httpError(event,404, 'Plan not found')
      return httpJson(event,200, {
        issues: buildChecks({
          plan: bundle.plan,
          places: bundle.places,
          itinerary: bundle.itinerary,
          weatherByPlace: bundle.weatherByPlace,
        }),
      })
    }

    /* 天气 / AI：与 CRUD 同进程、同 SQLite，避免独立 weather/chat 云函数各自 /tmp 读空库 */
    if (path === '/api/weather/live' && method === 'GET') {
      const adcode = query.adcode
      try {
        const weather = await fetchLiveWeatherByAdcode(adcode)
        return httpJson(event,200, { weather })
      } catch (e) {
        if (e.code === 'WEATHER_KEY') return httpError(event,500, e.message)
        if (e.code === 'BAD_REQUEST') return httpError(event,400, e.message)
        return httpError(event,502, e.message)
      }
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/weather\/live$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const planRow = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      )
      if (!planRow) return httpError(event,404, 'Plan not found')
      const placeRows = db
        .prepare(
          'SELECT id, adcode FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const weathers = {}
      const errors = {}
      for (const r of placeRows) {
        const placeId = r.id
        const ac = String(r.adcode || '').trim()
        if (!ac) {
          errors[placeId] = 'Missing adcode'
          continue
        }
        try {
          weathers[placeId] = await fetchLiveWeatherByAdcode(ac)
        } catch (e) {
          errors[placeId] = e.message || String(e)
        }
      }
      return httpJson(event,200, { weathers, errors })
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/ai\/summary\/stream$/)
    if (m && method === 'GET') {
      const planId = safeDecodePathSegment(m[1])
      const q = getQuery(event)
      const style = String(q.style || 'normal')
        .trim()
        .toLowerCase()
      const planRow = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      )
      if (!planRow) {
        return httpSse(
          event,
          200,
          `event: summaryerror\ndata: ${JSON.stringify({ detail: 'Plan not found' })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`
        )
      }
      const placeRows = db
        .prepare(
          'SELECT * FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const itineraryRows = db
        .prepare(
          'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const weatherByPlace = {}
      for (const p of placeRows) {
        const adcode = String(p.adcode || '').trim()
        if (!adcode) continue
        try {
          weatherByPlace[p.id] = await fetchLiveWeatherByAdcode(adcode)
        } catch (_) {
          /* skip */
        }
      }
      const messages = buildSummaryMessages(planRow, placeRows, itineraryRows, weatherByPlace, style)
      try {
        let sse = ''
        for await (const delta of streamChatComplete(messages)) {
          sse += `data: ${JSON.stringify({ delta })}\n\n`
        }
        sse += `data: ${JSON.stringify({ done: true })}\n\n`
        return httpSse(event, 200, sse)
      } catch (e) {
        console.error(e)
        const detail =
          e.code === 'LLM_CONFIG' ? e.message : e.code === 'LLM_UPSTREAM' ? e.message : e.message || 'Internal error'
        const payload = JSON.stringify({ detail, code: e.code || 'ERROR' })
        return httpSse(
          event,
          200,
          `event: summaryerror\ndata: ${payload}\n\ndata: ${JSON.stringify({ done: true })}\n\n`
        )
      }
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/ai\/summary$/)
    if (m && method === 'POST') {
      const planId = safeDecodePathSegment(m[1])
      const style = String(body.style || 'normal')
        .trim()
        .toLowerCase()
      const planRow = await withDbAfterPlanMissRetry(planId, (d) =>
        d.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      )
      if (!planRow) return httpError(event,404, 'Plan not found')
      const placeRows = db
        .prepare(
          'SELECT * FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const itineraryRows = db
        .prepare(
          'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const weatherByPlace = {}
      for (const p of placeRows) {
        const adcode = String(p.adcode || '').trim()
        if (!adcode) continue
        try {
          weatherByPlace[p.id] = await fetchLiveWeatherByAdcode(adcode)
        } catch (_) {
          /* skip */
        }
      }
      const messages = buildSummaryMessages(planRow, placeRows, itineraryRows, weatherByPlace, style)
      try {
        const summary = await chatComplete(messages)
        return httpJson(event,200, { summary })
      } catch (e) {
        console.error(e)
        if (e.code === 'LLM_CONFIG') return httpError(event,500, e.message)
        if (e.code === 'LLM_UPSTREAM') return httpError(event,502, e.message)
        return httpError(event,500, e.message || 'Internal error')
      }
    }

    return httpError(event,404, 'Not found')
  } catch (e) {
    console.error(e)
    return httpError(event,500, e.message || 'Internal error')
  } finally {
    await flushPendingCloud()
  }
}

