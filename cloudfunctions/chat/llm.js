'use strict'

const tcb = require('@cloudbase/node-sdk')

/**
 * v2.2：与 plan/llm.js 对齐（独立部署 chat 时行为一致）。
 * 未显式指定 external 且未配置 LLM_API_KEY 时，走 CloudBase 内置模型。
 */
function useExternalLlm() {
  const b = String(process.env.LAB3_AI_BACKEND || '').trim().toLowerCase()
  if (b === 'external') return true
  if (b === 'cloudbase') return false
  return Boolean(String(process.env.LLM_API_KEY || '').trim())
}

function requireEnv(name) {
  const v = String(process.env[name] || '').trim()
  if (!v) {
    const hint =
      name === 'LLM_API_KEY' || name === 'LLM_BASE_URL' || name === 'LLM_MODEL'
        ? '（可改走内置：去掉 LLM_API_KEY 或设置 LAB3_AI_BACKEND=cloudbase；若坚持外部模型请配置 LLM_*。）'
        : ''
    const err = new Error(`${name} is not set${hint}`)
    err.code = 'LLM_CONFIG'
    throw err
  }
  return v
}

function resolveCloudModel() {
  const providerHint = String(process.env.LAB3_CLOUD_AI_PROVIDER || '').trim().toLowerCase()
  const modelOverride = String(process.env.LAB3_CLOUD_AI_MODEL || '').trim()
  if (providerHint === 'deepseek' || /deepseek/i.test(modelOverride)) {
    return {
      providerId: 'deepseek',
      model: modelOverride || 'deepseek-v3.2',
    }
  }
  return {
    providerId: 'hunyuan-exp',
    model: modelOverride || 'hunyuan-2.0-instruct-20251111',
  }
}

function initCloudbaseApp() {
  const env =
    String(process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.LAB3_CLOUDBASE_ENV_ID || '').trim() || undefined
  return env ? tcb.init({ env }) : tcb.init()
}

async function chatCompleteExternal(messages, temperature = 0.6) {
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

async function chatCompleteCloudbase(messages, temperature = 0.6) {
  const app = initCloudbaseApp()
  const ai = app.ai()
  const { providerId, model } = resolveCloudModel()
  const chatModel = ai.createModel(providerId)
  const result = await chatModel.generateText({
    model,
    messages,
    temperature,
  })
  const text = String(result.text || '').trim()
  if (!text) {
    const err = new Error('CloudBase built-in model returned empty text')
    err.code = 'LLM_UPSTREAM'
    throw err
  }
  return text
}

async function chatComplete(messages, temperature = 0.6) {
  if (useExternalLlm()) return chatCompleteExternal(messages, temperature)
  return chatCompleteCloudbase(messages, temperature)
}

async function* streamChatComplete(messages, temperature = 0.6) {
  if (useExternalLlm()) {
    const full = await chatCompleteExternal(messages, temperature)
    if (full) yield full
    return
  }
  const app = initCloudbaseApp()
  const ai = app.ai()
  const { providerId, model } = resolveCloudModel()
  const chatModel = ai.createModel(providerId)
  const res = await chatModel.streamText({
    model,
    messages,
    temperature,
  })
  for await (const chunk of res.textStream) {
    if (chunk) yield chunk
  }
}

module.exports = { chatComplete, streamChatComplete, useExternalLlm }
