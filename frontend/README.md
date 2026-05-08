# Frontend（Vue 3 + Vite）

## 安装与运行

```bash
cd frontend
npm install
npm run dev
```

默认开发地址通常是 `http://localhost:5173/`。

## Lab 3-3 v2.0：本地静态页 + 云端云函数（`python -m http.server`）

实验要求：**不用 Vite dev server**，用纯静态服务器打开前端，同时 API 走 CloudBase 公网。

1. 复制并填写生产环境变量（含三个 `VITE_CLOUD_*` 与高德 `VITE_AMAP_*`）：

```bash
cd frontend
copy .env.production.example .env.production
```

编辑 `.env.production` 中的 `VITE_CLOUD_PLAN_URL` / `VITE_CLOUD_WEATHER_URL` / `VITE_CLOUD_CHAT_URL`（与控制台云函数网关 HTTP 地址一致，**不要**末尾 `/`）。

2. 构建并启动静态服务（在 `dist` 目录起服务，避免根路径 404）：

```bash
npm run build
cd dist
python -m http.server 8080
```

浏览器打开 `http://localhost:8080/`。此时请求会发往 **HTTPS 云端云函数**，浏览器可能提示混合内容：若遇阻，可改用 `npm run preview` 做本地 HTTPS 预览，或等 **v2.1 静态托管同域** 后再验收跨域与混合内容。

3. 本地开发（可选）：仍可用 `npm run dev`，`/api` 默认代理到 `http://127.0.0.1:8000`；可在 `.env.development` 中设置 `VITE_DEV_PROXY_TARGET` 覆盖。

## V4：高德地图配置（地点管理）

1. 复制一份环境变量文件：

```bash
copy .env.local.example .env.local
```

2. 编辑 `.env.local`，填写你的高德 **Web 端（JS API）Key** 与 **安全密钥（securityJsCode）**：

- `VITE_AMAP_KEY`
- `VITE_AMAP_SECURITY_JS_CODE`

> 注意：`.env.local` 不要提交到仓库。

## 常见问题

如果安装依赖时出现 `ENOSPC: no space left on device`，请先清理磁盘空间后重试（例如清理临时文件、删除不必要的下载/缓存等）。

# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).
