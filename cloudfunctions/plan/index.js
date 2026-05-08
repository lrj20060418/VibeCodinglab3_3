'use strict'

const { randomUUID } = require('crypto')
const { getDb } = require('./db')
const { fetchLiveWeatherByAdcode } = require('./amapWeather')
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
  const db = getDb()
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

  const db = getDb()
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
         VALUES (@id, @title, @date, @budget, @people_count, @preferences, @c, @u)`
      ).run({
        id,
        title: body.title ?? null,
        date: body.date,
        budget: body.budget ?? null,
        people_count: body.people_count ?? null,
        preferences: body.preferences ?? null,
        c: t,
        u: t,
      })
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

    return httpError(404, 'Not found')
  } catch (e) {
    console.error(e)
    return httpError(500, e.message || 'Internal error')
  }
}
