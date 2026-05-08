'use strict'

const { getDb } = require('./db')
const { corsHeaders } = require('./corsOrigin')

const CACHE = new Map()
const TTL_MS = 10 * 60 * 1000

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
  return q && typeof q === 'object' ? q : {}
}

function httpJson(event, statusCode, data) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(event),
    },
    body: JSON.stringify(data),
  }
}

function httpError(event, statusCode, message) {
  return httpJson(event, statusCode, { detail: message })
}

async function fetchLiveWeatherByAdcode(adcode) {
  const key = (process.env.AMAP_WEBSERVICE_KEY || '').trim()
  if (!key) {
    const err = new Error('AMAP_WEBSERVICE_KEY is not set')
    err.code = 'WEATHER_KEY'
    throw err
  }
  const city = String(adcode || '').trim()
  if (!city) {
    const err = new Error('Missing adcode')
    err.code = 'BAD_REQUEST'
    throw err
  }

  const now = Date.now()
  const hit = CACHE.get(city)
  if (hit && now - hit.t < TTL_MS) return hit.data

  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${encodeURIComponent(
    city
  )}&key=${encodeURIComponent(key)}&extensions=base`
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    const err = new Error(`Failed to call AMap weather: HTTP ${res.status}`)
    err.code = 'UPSTREAM'
    throw err
  }
  const data = await res.json()
  if (data.status !== '1') {
    const info = String(data.info || 'unknown')
    let hint = ''
    if (info === 'USERKEY_PLAT_NOMATCH' || info.includes('USERKEY_PLAT')) {
      hint =
        ' 请使用高德「Web服务」Key（restapi.amap.com），勿用「Web端(JS API)」Key。'
    }
    const err = new Error(`AMap weather error: ${info}${hint}`)
    err.code = 'UPSTREAM'
    throw err
  }
  const live = (data.lives && data.lives[0]) || null
  if (!live || typeof live !== 'object') {
    const err = new Error('AMap weather missing lives[0]')
    err.code = 'UPSTREAM'
    throw err
  }
  const out = {
    status: live.weather,
    temperature: live.temperature,
    wind_direction: live.winddirection,
    wind_power: live.windpower,
    humidity: live.humidity,
    report_time: live.reporttime,
    adcode: city,
  }
  CACHE.set(city, { t: now, data: out })
  return out
}

exports.main = async (event, _context) => {
  const httpMethod = event.httpMethod || event.method || ''
  if (String(httpMethod).toUpperCase() === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' }
  }

  const method = String(httpMethod || 'GET').toUpperCase()
  const path = normalizePath(event)

  if (path === '/health' && method === 'GET') {
    return httpJson(event,200, { ok: true })
  }

  try {
    if (path === '/api/weather/live' && method === 'GET') {
      const query = getQuery(event)
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

    const m = path.match(/^\/api\/plans\/([^/]+)\/weather\/live$/)
    if (m && method === 'GET') {
      const planId = m[1]
      const db = await getDb()
      const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(planId)
      if (!plan) return httpError(event,404, 'Plan not found')
      const rows = db
        .prepare(
          'SELECT id, adcode FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC'
        )
        .all(planId)
      const weathers = {}
      const errors = {}
      for (const r of rows) {
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

    return httpError(event,404, 'Not found')
  } catch (e) {
    console.error(e)
    return httpError(event,500, e.message || 'Internal error')
  }
}
