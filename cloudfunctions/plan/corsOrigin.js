'use strict'

/** v2.1：与静态托管域名一致；本地 Vite 开发仍允许 localhost */
const DEFAULT_HOSTING_ORIGIN =
  'https://vibe-lab3-3-d4gw0nadh7234883b-1429528420.tcloudbaseapp.com'

function headerGet(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === lower) {
      const v = headers[k]
      return typeof v === 'string' ? v : ''
    }
  }
  return ''
}

function resolveAllowOrigin(event) {
  const allowed = String(process.env.LAB3_HOSTING_ORIGIN || '').trim() || DEFAULT_HOSTING_ORIGIN
  const h = event.headers || event.requestContext?.http?.headers || {}
  const req = String(headerGet(h, 'Origin') || '').trim()
  if (req && req === allowed) return req
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req)) return req
  // 静态托管域名随环境/发布会变；EventSource 跨域必须回显浏览器真实 Origin，不能只写默认域名
  if (req && /^https:\/\/[\w.-]+\.tcloudbaseapp\.com$/i.test(req)) return req
  return allowed
}

function corsHeaders(event) {
  return {
    'Access-Control-Allow-Origin': resolveAllowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    Vary: 'Origin',
  }
}

module.exports = { corsHeaders }
