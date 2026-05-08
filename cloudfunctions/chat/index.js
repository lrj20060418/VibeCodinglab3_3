'use strict'

const { getDb } = require('./db')
const { chatComplete } = require('./llm')

async function fetchLiveWeatherByAdcode(adcode) {
  const key = (process.env.AMAP_WEBSERVICE_KEY || '').trim()
  if (!key) return null
  const city = String(adcode || '').trim()
  if (!city) return null
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${encodeURIComponent(
    city
  )}&key=${encodeURIComponent(key)}&extensions=base`
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) return null
  const data = await res.json()
  if (data.status !== '1') return null
  const live = (data.lives && data.lives[0]) || null
  if (!live) return null
  return {
    status: live.weather,
    temperature: live.temperature,
    wind_direction: live.winddirection,
    wind_power: live.windpower,
    humidity: live.humidity,
    report_time: live.reporttime,
    adcode: city,
  }
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

/** 阶段一：宽松 CORS；阶段二再收紧 Origin */
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

function parseBody(event) {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
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

  const m = path.match(/^\/api\/plans\/([^/]+)\/ai\/summary$/)
  if (!m || method !== 'POST') {
    return httpError(404, 'Not found')
  }

  const planId = m[1]
  const body = parseBody(event)
  const style = String(body.style || 'normal')
    .trim()
    .toLowerCase()

  try {
    const db = getDb()
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
    if (!plan) return httpError(404, 'Plan not found')

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
      const w = await fetchLiveWeatherByAdcode(adcode)
      if (w) weatherByPlace[p.id] = w
    }

    const placeName = Object.fromEntries(places.map((p) => [p.id, p.name || '地点']))
    const groups = { morning: [], afternoon: [], evening: [] }
    for (const it of itinerary) {
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
        title: plan.title,
        date: plan.date,
        budget: plan.budget,
        people_count: plan.people_count,
        preferences: plan.preferences,
      },
      places: places.map((p) => ({
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

    const summary = await chatComplete(messages)
    return httpJson(200, { summary })
  } catch (e) {
    console.error(e)
    if (e.code === 'LLM_CONFIG') return httpError(500, e.message)
    if (e.code === 'LLM_UPSTREAM') return httpError(502, e.message)
    return httpError(500, e.message || 'Internal error')
  }
}
