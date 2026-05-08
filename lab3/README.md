# Lab 3-1 — 地图天气 AI 助手（前端）

纯前端项目，分阶段接入：地图 → 天气 → 大模型。当前目录完成 **第一轮**：

- 嵌入高德 JS API 2.0，点击地图选点；
- **经纬度**在页面「选中位置」面板展示，并 `console.log` 输出；
- **地名**通过 `AMap.Geocoder` 逆地理编码展示（与评分「地名/经纬度」一致），成功时同样 `console.log`。

项目级 AI 开发规范见仓库根目录 `cursor-rules/lab3-1-global.mdc`（可复制到 `.cursor/rules/`，见同目录 `INSTALL.md`）。

## 运行方式

1. 在高德开放平台申请 **Web 端（JS API）** Key 与 **安全密钥（securityJsCode）**。
2. 在控制台为该 Key 配置 **HTTP Referer 白名单**，与本地访问地址一致，例如：`http://localhost:5500` 或 `http://127.0.0.1:5173`。
3. 在高德开放平台申请 **Web 服务** Key（用于天气 API）。
4. 编辑 `js/config.js`，将下列占位符替换为你的凭据（**不要**将真实凭据提交到公开仓库）：
   - `YOUR_AMAP_KEY_HERE`
   - `YOUR_AMAP_SECURITY_JS_CODE_HERE`
   - `YOUR_AMAP_WEBSERVICE_KEY_HERE`
   - `YOUR_LLM_API_KEY_HERE`
   - `YOUR_LLM_BASE_URL_HERE`（填完整的 chat/completions 地址）
   - `YOUR_LLM_MODEL_HERE`
4. 用任意静态服务器打开本目录（双击打开 `file://` 可能受限于部分浏览器策略，建议本地 HTTP 服务）：
   - VS Code：Live Server
   - 或：`npx serve .`（在项目根目录 `lab3` 下执行）

## 目录结构

```
lab3/
  index.html
  css/style.css
  js/config.js    # 凭据占位符，本地填写
  js/app.js       # 地图初始化与点击逻辑
  README.md
```

## 后续轮次（实验文档）

- 第二轮：根据选中经纬度调用天气 API 并展示。
- 第三轮：接入大模型，将位置与天气写入对话上下文。
