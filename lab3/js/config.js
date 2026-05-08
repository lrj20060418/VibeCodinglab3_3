/**
 * 本地开发：将下方占位符替换为你的高德开放平台凭据（勿将真实值提交到公开仓库）。
 * Web 端（JS API）Key + 安全密钥（securityJsCode）；控制台需配置 Referer 白名单。
 */
export const AMAP_KEY = "a4d84efd8b5aae8c37a52034a0c8a7fd";
export const AMAP_SECURITY_JS_CODE = "d77e1f0ef3ba1996676fc197f4cfd17e";

/**
 * 高德天气 API（Web 服务）Key
 * - 用途：第二轮（点击地图后自动显示天气）
 * - 注意：请勿提交真实 Key；仅本地填写
 *
 * 提示：高德控制台里通常需要创建「Web服务」类型的 Key（与 JS API Key 不是同一个）。
 */
export const AMAP_WEBSERVICE_KEY = "05510639bfa120ad8b708d0ea51ab283";

/**
 * 大模型 API（OpenAI SDK 兼容格式）
 * - 用途：第三轮（带天气上下文的 AI 对话）
 * - 注意：请勿提交真实 Key；仅本地填写
 *
 * `LLM_BASE_URL` 建议直接填写「chat completions」完整地址，例如：
 * - 智谱：`https://open.bigmodel.cn/api/paas/v4/chat/completions`
 * - DeepSeek：`https://api.deepseek.com/chat/completions`（以官方为准）
 */
export const LLM_API_KEY = "f1b507367cf34ac6b715f7d1f9ed8a97.78oXqW3zzgebYItJ";
export const LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const LLM_MODEL = "glm-5.1";
