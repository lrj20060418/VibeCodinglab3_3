'use strict'

const { randomUUID } = require('crypto')
const { getDb, flushPendingCloud } = require('./db')
const { fetchLiveWeatherByAdcode } = require('./amapWeather')
const { chatComplete } = require('./llm')
const { buildChecks } = require('./checks')
const { buildPlanExportJson, buildPlanExportMd } = require('./exportBuild')

const ALLOWED_SLOTS = new Set(['morning', 'afternoon', 'evening'])

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
  return raw
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

/** 阶段一：宽松 CORS；阶段二再收紧 Access-Control-Allow-Origin 到静态托管域名 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  }
}

function httpJson(statusCode, data) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
    body: JSON.stringify(data),
  }
}

function httpError(statusCode, message) {
  return httpJson(statusCode, { detail: message })
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

exports.main = async (event, _context) => {
  const httpMethod = event.httpMethod || event.method || ''
  if (String(httpMethod).toUpperCase() === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' }
  }

  const method = String(httpMethod || 'GET').toUpperCase()
  const path = normalizePath(event)

  if (path === '/health' && method === 'GET') {
    return httpJson(200, { ok: true })
  }

  const db = await getDb()
  const body = parseBody(event)
  const query = getQuery(event)

  try {
    /* ---- Plans ---- */
    if (path === '/api/plans' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM plans ORDER BY datetime(updated_at) DESC').all()
      return httpJson(200, rows)
    }

    if (path === '/api/plans' && method === 'POST') {
      if (!body.date) return httpError(400, 'date required')
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
      return httpJson(200, row)
    }

    let m = path.match(/^\/api\/plans\/([^/]+)$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      if (!row) return httpError(404, 'Plan not found')
      return httpJson(200, row)
    }

    if (m && method === 'PUT') {
      const planId = m[1]
      const cur = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      if (!cur) return httpError(404, 'Plan not found')
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
      return httpJson(200, row)
    }

    /* ---- Places ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/places$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(404, 'Plan not found')
      const rows = db
        .prepare(
          'SELECT * FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      return httpJson(200, rows)
    }

    if (m && method === 'POST') {
      const planId = m[1]
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(404, 'Plan not found')
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
      return httpJson(200, row)
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/places\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const planId = m[1]
      const placeId = m[2]
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(404, 'Plan not found')
      const info = db.prepare('DELETE FROM places WHERE id = ? AND plan_id = ?').run(placeId, planId)
      if (info.changes === 0) return httpError(404, 'Place not found')
      return httpJson(200, { ok: true })
    }

    /* ---- Itinerary ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/itinerary$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(404, 'Plan not found')
      const rows = db
        .prepare(
          'SELECT * FROM itinerary_items WHERE plan_id = ? ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      return httpJson(200, rows)
    }

    if (m && method === 'PUT') {
      const planId = m[1]
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(404, 'Plan not found')
      const placeRows = db.prepare('SELECT id FROM places WHERE plan_id = ?').all(planId)
      const placeIds = new Set(placeRows.map((r) => r.id))
      const items = Array.isArray(body.items) ? body.items : []
      for (const it of items) {
        if (!ALLOWED_SLOTS.has(it.time_slot)) return httpError(400, `Invalid time_slot: ${it.time_slot}`)
        if (!placeIds.has(it.place_id)) return httpError(400, `Invalid place_id: ${it.place_id}`)
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
      return httpJson(200, rows)
    }

    /* ---- Export / checks ---- */
    m = path.match(/^\/api\/plans\/([^/]+)\/export$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const bundle = await loadPlanBundle(planId)
      if (!bundle) return httpError(404, 'Plan not found')
      const fmt = String(query.format || 'md').toLowerCase().trim()
      if (fmt !== 'md' && fmt !== 'json') return httpError(400, 'format must be md or json')
      if (fmt === 'json') {
        return httpJson(200, {
          format: 'json',
          content: buildPlanExportJson(bundle),
        })
      }
      return httpJson(200, {
        format: 'md',
        content: buildPlanExportMd(bundle),
      })
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/checks$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const bundle = await loadPlanBundle(planId)
      if (!bundle) return httpError(404, 'Plan not found')
      return httpJson(200, {
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
        return httpJson(200, { weather })
      } catch (e) {
        if (e.code === 'WEATHER_KEY') return httpError(500, e.message)
        if (e.code === 'BAD_REQUEST') return httpError(400, e.message)
        return httpError(502, e.message)
      }
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/weather\/live$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const planRow = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!planRow) return httpError(404, 'Plan not found')
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
      return httpJson(200, { weathers, errors })
    }

    m = path.match(/^\/api\/plans\/([^/]+)\/ai\/summary$/)
    if (m && method === 'POST') {
      const planId = m[1]
      const style = String(body.style || 'normal')
        .trim()
        .toLowerCase()
      const planRow = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
      if (!planRow) return httpError(404, 'Plan not found')
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
      const messages = [
        { role: 'system', content: system },
        { role: 'system', content: `输出要求：${styleHint}` },
        { role: 'system', content: `规划上下文（JSON）：\n${JSON.stringify(context)}` },
        { role: 'user', content: '请给出本次规划的 AI 辅助总结。' },
      ]
      try {
        const summary = await chatComplete(messages)
        return httpJson(200, { summary })
      } catch (e) {
        console.error(e)
        if (e.code === 'LLM_CONFIG') return httpError(500, e.message)
        if (e.code === 'LLM_UPSTREAM') return httpError(502, e.message)
        return httpError(500, e.message || 'Internal error')
      }
    }

    return httpError(404, 'Not found')
  } catch (e) {
    console.error(e)
    return httpError(500, e.message || 'Internal error')
  } finally {
    await flushPendingCloud()
  }
}
