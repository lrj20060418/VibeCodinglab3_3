import { planApiBase } from './config'

const API_BASE = planApiBase()

async function http(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

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

export function listPlaces(planId) {
  return http('GET', `/api/plans/${encodeURIComponent(planId)}/places`)
}

export function addPlace(planId, payload) {
  return http('POST', `/api/plans/${encodeURIComponent(planId)}/places`, payload)
}

export function deletePlace(planId, placeId) {
  return http(
    'DELETE',
    `/api/plans/${encodeURIComponent(planId)}/places/${encodeURIComponent(placeId)}`
  )
}

