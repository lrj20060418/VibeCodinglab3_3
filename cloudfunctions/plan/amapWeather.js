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
    const info = String(data.info || 'unknown')
    let hint = ''
    if (info === 'USERKEY_PLAT_NOMATCH' || info.includes('USERKEY_PLAT')) {
      hint =
        ' 请在云开发控制台为云函数配置高德「Web服务」类型的 Key（restapi.amap.com），不要用「Web端(JS API)」Key。'
    } else if (info === 'INVALID_USER_KEY' || info.includes('USER_KEY')) {
      hint = ' 请检查 AMAP_WEBSERVICE_KEY 是否正确、是否已启用 Web服务 API。'
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

module.exports = { fetchLiveWeatherByAdcode }
