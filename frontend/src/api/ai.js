import { planApiBase } from './config'

const API_BASE = planApiBase()

/** 每帧最多追加字符数（云函数整包返回时仍能看出「打字」效果） */
const STREAM_CHARS_PER_FRAME = 28

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
 * 将上游可能「整包到达」的文本，按帧拆成多次 onDelta，避免 Vue 合并成一次渲染。
 */
function createSmoothStream(onDelta) {
  let buf = ''
  let raf = null
  let drainResolve = null

  function pump() {
    raf = null
    if (buf.length === 0) {
      if (drainResolve) {
        const r = drainResolve
        drainResolve = null
        r()
      }
      return
    }
    const take = Math.min(STREAM_CHARS_PER_FRAME, buf.length)
    onDelta?.(buf.slice(0, take))
    buf = buf.slice(take)
    if (buf.length === 0) {
      if (drainResolve) {
        const r = drainResolve
        drainResolve = null
        r()
      }
      return
    }
    raf = requestAnimationFrame(pump)
  }

  function push(s) {
    if (!s) return
    buf += s
    if (raf == null) raf = requestAnimationFrame(pump)
  }

  /** 等待缓冲区全部显示完（用于 done 前收尾） */
  function waitDrained() {
    if (buf.length === 0 && raf == null) return Promise.resolve()
    return new Promise((resolve) => {
      drainResolve = resolve
      if (raf == null) pump()
    })
  }

  function cancel() {
    if (raf != null) {
      cancelAnimationFrame(raf)
      raf = null
    }
    buf = ''
    if (drainResolve) {
      const r = drainResolve
      drainResolve = null
      r()
    }
  }

  return { push, waitDrained, cancel }
}

/**
 * 流式 AI 总结：优先 `GET .../ai/summary/stream` + EventSource（增量 `onDelta`）。
 * 未配置 `VITE_CLOUD_PLAN_URL` 时回退为 POST 非流式（与本地 Vite 代理行为一致）。
 *
 * 网关/云函数常一次性返回整段 SSE，浏览器会在同一轮里连续触发 onmessage；此处用 rAF
 * 分帧刷字，避免界面「一整块出现」。
 */
export function streamPlanSummary(planId, style = 'normal', handlers = {}) {
  const { onDelta, onDone, onError } = handlers
  const base = planApiBase()

  return new Promise((resolve, reject) => {
    if (!base) {
      const smooth = createSmoothStream(onDelta)
      generatePlanSummary(planId, style)
        .then(async (res) => {
          const text = res.summary || ''
          if (text) smooth.push(text)
          await smooth.waitDrained()
          smooth.cancel()
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
    const smooth = createSmoothStream(onDelta)

    const fail = (err) => {
      if (finished) return
      finished = true
      smooth.cancel()
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

    es.onmessage = async (ev) => {
      try {
        const p = JSON.parse(ev.data || '{}')
        if (p.delta) smooth.push(p.delta)
        if (p.done) {
          await smooth.waitDrained()
          smooth.cancel()
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
      smooth.cancel()
      fail(new Error('SSE 连接中断（请检查云函数网关与 CORS）'))
    }
  })
}
