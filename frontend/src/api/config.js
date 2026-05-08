/**
 * Lab 3-3：云函数公网 Base URL（不要末尾 /）。
 * 全部留空时走相对路径 `/api/...`，由 Vite 代理到本地 FastAPI（Lab 3-2）。
 */
function trimEndSlash(s) {
  if (s == null || typeof s !== 'string') return ''
  return s.replace(/\/+$/, '')
}

export function planApiBase() {
  return trimEndSlash(import.meta.env.VITE_CLOUD_PLAN_URL || '')
}

export function weatherApiBase() {
  const w = import.meta.env.VITE_CLOUD_WEATHER_URL
  if (w) return trimEndSlash(w)
  return planApiBase()
}

export function chatApiBase() {
  const c = import.meta.env.VITE_CLOUD_CHAT_URL
  if (c) return trimEndSlash(c)
  return planApiBase()
}
