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

/** 天气与规划同库，须走 plan 云函数；独立 weather 云函数无法共享 /tmp 内 SQLite */
export function weatherApiBase() {
  return planApiBase()
}

/** AI 摘要与规划同库，须走 plan 云函数 */
export function chatApiBase() {
  return planApiBase()
}
