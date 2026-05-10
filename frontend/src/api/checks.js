import { planApiBase } from './config'

const API_BASE = planApiBase()

async function httpJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' })
  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await res.json() : await res.text()

  if (!res.ok) {
    const detail =
      (data && typeof data === 'object' && (data.detail || data.message)) ||
      (typeof data === 'string' ? data : null) ||
      `Request failed: ${res.status}`
    throw new Error(detail)
  }
  return data
}

export function getPlanChecks(planId) {
  return httpJson(`/api/plans/${encodeURIComponent(planId)}/checks`)
}

