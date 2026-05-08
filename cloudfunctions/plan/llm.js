'use strict'

function requireEnv(name) {
  const v = String(process.env[name] || '').trim()
  if (!v) {
    const err = new Error(`${name} is not set`)
    err.code = 'LLM_CONFIG'
    throw err
  }
  return v
}

async function chatComplete(messages, temperature = 0.6) {
  const apiKey = requireEnv('LLM_API_KEY')
  const baseUrl = requireEnv('LLM_BASE_URL')
  const model = requireEnv('LLM_MODEL')

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature }),
  })

  let data
  try {
    data = await res.json()
  } catch {
    data = null
  }

  if (!res.ok) {
    const detail = data != null ? JSON.stringify(data) : await res.text()
    const err = new Error(`LLM HTTP ${res.status} for ${baseUrl}: ${detail}`)
    err.code = 'LLM_UPSTREAM'
    throw err
  }

  const choice0 = (data && data.choices && data.choices[0]) || {}
  let content = (((choice0.message || {}).content || '') + '').trim()
  if (!content) {
    content = (
      (((choice0.delta || {}).content || '') + '').trim() ||
      String(choice0.text || '').trim() ||
      String((data && data.output_text) || '').trim()
    )
  }
  if (!content) {
    const err = new Error(`LLM returned empty content: ${JSON.stringify(data)}`)
    err.code = 'LLM_UPSTREAM'
    throw err
  }
  return content
}

module.exports = { chatComplete }
