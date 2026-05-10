import { planApiBase } from './config'

const API_BASE = planApiBase()

/** 打字机：每步字符数 / 间隔（毫秒）——略放慢以便肉眼看出「流式」 */
const STREAM_CHUNK_SIZE = 4
const STREAM_INTERVAL_MS = 26

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
 * 将整段或大块文本拆成多次 onDelta，用定时器拉开间隔（云函数常整包返回 SSE）。
 */
function createSmoothStream(onDelta) {
  let buf = ''
  let timer = null
  let drainResolve = null

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function tick() {
    timer = null
    if (buf.length === 0) {
      if (drainResolve) {
        const r = drainResolve
        drainResolve = null
        r()
      }
      return
    }
    const take = Math.min(STREAM_CHUNK_SIZE, buf.length)
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
    timer = setTimeout(tick, STREAM_INTERVAL_MS)
  }

  function push(s) {
    if (!s) return
    buf += s
    if (timer == null) timer = setTimeout(tick, STREAM_INTERVAL_MS)
  }

  function waitDrained() {
    if (buf.length === 0 && timer == null) return Promise.resolve()
    return new Promise((resolve) => {
      drainResolve = resolve
      if (timer == null) tick()
    })
  }

  function cancel() {
    clearTimer()
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
 * 解析一段 SSE（以 \\n\\n 分隔的 block）
 * @returns {'done'|'error'|false}
 */
function handleSseBlock(block, smooth, onError) {
  const lines = block.split('\n')
  let eventName = 'message'
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trimStart()
      try {
        const p = JSON.parse(payload)
        if (eventName === 'summaryerror') {
          onError(new Error(String(p.detail || 'AI 总结失败')))
          return 'error'
        }
        if (p.delta) smooth.push(p.delta)
        if (p.done) return 'done'
      } catch {
        /* ignore */
      }
    }
  }
  return false
}

/**
 * fetch + ReadableStream 读取 SSE（比 EventSource 更易按 TCP 分块处理 body）
 * @returns {Promise<boolean>} true = 已正常结束（含 done）
 */
/** @returns {Promise<boolean>} true = 收到 done 并已 drain */
async function readSseStreamWithFetch(url, smooth, onError) {
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      credentials: 'omit',
      mode: 'cors',
    })
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)))
    return false
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const t = await res.text()
      const j = JSON.parse(t)
      if (j.detail) msg = j.detail
    } catch {
      /* keep */
    }
    onError(new Error(msg))
    return false
  }

  const reader = res.body?.getReader()
  if (!reader) {
    onError(new Error('响应无 body'))
    return false
  }

  const dec = new TextDecoder()
  let carry = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    carry += dec.decode(value, { stream: true })
    let sep
    while ((sep = carry.indexOf('\n\n')) >= 0) {
      const block = carry.slice(0, sep)
      carry = carry.slice(sep + 2)
      const r = handleSseBlock(block, smooth, onError)
      if (r === 'error') return false
      if (r === 'done') {
        await smooth.waitDrained()
        return true
      }
    }
  }

  if (carry.trim()) {
    const r = handleSseBlock(carry, smooth, onError)
    if (r === 'error') return false
    if (r === 'done') {
      await smooth.waitDrained()
      return true
    }
  }

  return false
}

/**
 * 流式 AI 总结：优先 fetch 读 SSE + 打字机；未收到 done 或失败则 POST。
 */
export function streamPlanSummary(planId, style = 'normal', handlers = {}) {
  const { onDelta, onDone, onError } = handlers
  const base = planApiBase()

  return new Promise((resolve, reject) => {
    let settled = false

    const settleOk = () => {
      if (settled) return
      settled = true
      onDone?.()
      resolve()
    }

    const settleErr = (err) => {
      if (settled) return
      settled = true
      onError?.(err)
      reject(err)
    }

    async function postFallback() {
      const smooth = createSmoothStream(onDelta)
      try {
        const res = await generatePlanSummary(planId, style)
        const text = res.summary || ''
        if (text) smooth.push(text)
        await smooth.waitDrained()
        smooth.cancel()
        settleOk()
      } catch (e) {
        settleErr(e instanceof Error ? e : new Error(String(e)))
      }
    }

    if (!base) {
      void postFallback()
      return
    }

    const url = `${base}/api/plans/${encodeURIComponent(planId)}/ai/summary/stream?style=${encodeURIComponent(style)}`
    const smooth = createSmoothStream(onDelta)

    void (async () => {
      try {
        const ok = await readSseStreamWithFetch(url, smooth, settleErr)
        if (settled) return
        if (ok) {
          smooth.cancel()
          settleOk()
          return
        }
        smooth.cancel()
        await postFallback()
      } catch (e) {
        smooth.cancel()
        if (!settled) await postFallback()
        if (!settled) settleErr(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}
