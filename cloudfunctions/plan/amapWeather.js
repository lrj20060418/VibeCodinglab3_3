'use strict'

const CACHE = new Map()
const TTL_MS = 10 * 60 * 1000

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
    const err = new Error(`AMap weather error: ${data.info || 'unknown'}`)
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

module.exports = { fetchLiveWeatherByAdcode }
