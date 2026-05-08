import { planApiBase } from './config'

const API_BASE = planApiBase()

async function http(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
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

/** 非流式：与 v2.1 兼容，仍返回完整 `{ summary }`。 */
export function generatePlanSummary(planId, style = 'normal') {
  return http('POST', `/api/plans/${encodeURIComponent(planId)}/ai/summary`, { style })
}

/**
 * 流式 AI 总结：优先 `GET .../ai/summary/stream` + EventSource（增量 `onDelta`）。
 * 未配置 `VITE_CLOUD_PLAN_URL` 时回退为 POST 非流式（与本地 Vite 代理行为一致）。
 */
export function streamPlanSummary(planId, style = 'normal', handlers = {}) {
  const { onDelta, onDone, onError } = handlers
  const base = planApiBase()

  return new Promise((resolve, reject) => {
    if (!base) {
      generatePlanSummary(planId, style)
        .then((res) => {
          const text = res.summary || ''
          if (text) onDelta?.(text)
          onDone?.()
          resolve()
        })
        .catch((e) => {
          onError?.(e)
          reject(e)
        })
      return
    }

    const url = `${base}/api/plans/${encodeURIComponent(planId)}/ai/summary/stream?style=${encodeURIComponent(style)}`
    const es = new EventSource(url)
    let finished = false

    const fail = (err) => {
      if (finished) return
      finished = true
      try {
        es.close()
      } catch (_) {
        /* ignore */
      }
      onError?.(err)
      reject(err)
    }

    es.addEventListener('summaryerror', (ev) => {
      try {
        const p = JSON.parse(ev.data || '{}')
        fail(new Error(p.detail || 'AI 总结失败'))
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })

    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data || '{}')
        if (p.delta) onDelta?.(p.delta)
        if (p.done) {
          finished = true
          try {
            es.close()
          } catch (_) {
            /* ignore */
          }
          onDone?.()
          resolve()
        }
      } catch (_) {
        /* ignore malformed chunk */
      }
    }

    es.onerror = () => {
      if (finished) return
      fail(new Error('SSE 连接中断（请检查云函数网关与 CORS）'))
    }
  })
}
