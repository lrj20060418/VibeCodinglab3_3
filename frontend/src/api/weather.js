import { planApiBase } from './config'

const API_BASE = planApiBase()

async function http(method, path) {
  const res = await fetch(`${API_BASE}${path}`, { method })
  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await res.json() : await res.text()

  if (!res.ok) {
    const detail =
      (data && typeof data === 'object' && (data.detail || data.message)) ||
      (typeof data === 'string' ? data : null) ||
      `Request failed: ${res.status}`
    const err = new Error(detail)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function getPlanLiveWeathers(planId) {
  return http('GET', `/api/plans/${encodeURIComponent(planId)}/weather/live`)
}

export function getLiveWeatherByAdcode(adcode) {
  return http('GET', `/api/weather/live?adcode=${encodeURIComponent(adcode)}`)
}