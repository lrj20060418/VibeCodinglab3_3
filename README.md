# Lab 3-3 阶段一：项目结构 + 云函数后端（Node）

本仓库在 Lab 3-2（`frontend/` Vue + `backend/` FastAPI）基础上，增加 **CloudBase 云函数** 形态的后端，目录符合实验要求。

## 目录说明

```
project/
├── frontend/                 # Lab 3-2 前端（Vue 3 + Vite），沿用
├── cloudfunctions/
│   ├── plan/                 # 规划：plans / places / itinerary / export / checks
│   ├── weather/              # 天气：/api/weather/live、/api/plans/:id/weather/live
│   └── chat/                 # AI：/api/plans/:id/ai/summary
├── .cursor/
│   └── mcp.json              # CloudBase MCP（若使用 Cursor）
├── cloudbaserc.json          # 填写 envId 后用于 tcb / 控制台部署
├── .env.example              # 环境变量占位（可提交）
├── .gitignore
└── README.md
```

- **`backend/`**：保留为 **本地开发** 的 Python FastAPI（`npm run dev` 时 Vite 仍可将 `/api` 代理到 `127.0.0.1:8000`）。
- **`cloudfunctions/`**：**线上/CloudBase** 使用的 Node 云函数（与 Lab 3-2 接口路径保持一致，便于前端切换 Base URL）。

## 云函数与 Lab 3-2 API 对齐说明

| 云函数 | 职责 | 主要路径 |
|--------|------|----------|
| `plan` | SQLite CRUD、行程、导出、规则检查 | `/api/plans...`、`/health` |
| `weather` | 高德实时天气（需 `AMAP_WEBSERVICE_KEY`） | `/api/weather/live`、`/api/plans/:id/weather/live` |
| `chat` | 读取规划上下文并调用 LLM | `POST /api/plans/:id/ai/summary` |

返回格式：HTTP 访问场景下使用 API 网关风格 `{ statusCode, headers, body }`，`body` 为 JSON 字符串；与原有 FastAPI 的 JSON 结构一致（错误为 `{ "detail": "..." }`）。

## 前端如何走公网云函数

在 `frontend/.env.local` 中配置（**不要提交**）：

```env
# 留空则仍走 Vite 代理到本地 FastAPI（Lab 3-2）
VITE_CLOUD_PLAN_URL=
VITE_CLOUD_WEATHER_URL=
VITE_CLOUD_CHAT_URL=
```

部署云函数并为每个函数创建 **HTTP 访问路径** 后，将三个变量设为「默认网关域名 + 路径前缀」（不要末尾 `/`）。本项目 MCP 创建的路径为：

- `plan` → `/lab3-plan`
- `weather` → `/lab3-weather`
- `chat` → `/lab3-chat`

默认域名为：`https://<envId>.service.tcloudbase.com`（与控制台「云函数网关」一致），例如：

```env
VITE_CLOUD_PLAN_URL=https://<envId>.service.tcloudbase.com/lab3-plan
VITE_CLOUD_WEATHER_URL=https://<envId>.service.tcloudbase.com/lab3-weather
VITE_CLOUD_CHAT_URL=https://<envId>.service.tcloudbase.com/lab3-chat
```

网关配置生效通常需 **30 秒～3 分钟**，新建后请勿立刻压测。

具体域名与路径以 CloudBase 控制台「HTTP 访问」为准。

## Lab 3-3 v2.0 产出（已完成项，不含 v2.1）

- **云函数**：`plan` / `weather` / `chat` 已部署到当前环境（可用 `tcb fn deploy --all` 或 CloudBase MCP `updateFunctionCode` 同步代码）。
- **HTTP 访问（网关）**：已为三函数各建一条公网路径（示例）  
  - `https://<envId>.service.tcloudbase.com/lab3-plan`  
  - `https://<envId>.service.tcloudbase.com/lab3-weather`  
  - `https://<envId>.service.tcloudbase.com/lab3-chat`  
  具体以控制台 **云函数网关 → HTTP 访问** 为准；生效可能需数分钟。
- **前端**：通过 `frontend/.env.local`（开发）或 `frontend/.env.production`（`npm run build`）配置 `VITE_CLOUD_*`，**源码中不包含** LLM / 高德 Web 服务 Key；地图仅使用 `VITE_AMAP_*`（见 `frontend/.env.production.example`）。
- **本地静态验收**：见 `frontend/README.md` 中「Lab 3-3 v2.0」：`npm run build` 后于 `dist/` 下执行 `python -m http.server`。

> **未做（属 v2.1）**：静态网站托管上线、CORS 收紧到托管域名、高德 Key 白名单改为托管域等。

## 部署提示

1. 根目录 `cloudbaserc.json` 中 `envId` 需与你的环境一致（当前示例已为绑定环境）。
2. 在 CloudBase 控制台为 `plan`、`weather`、`chat` 配置环境变量（见 `.env.example`）。
3. 使用 CloudBase CLI / 控制台上传云函数；为每个函数开启 **HTTP 访问**，路径需能转发到函数内识别的 `/api/...`（与 Lab 3-2 相同路径最省事）。
4. **数据库**：当前云函数使用 **SQLite**（默认路径为系统临时目录下 `lab3-cloudfunctions/app.db`，可通过 `LAB3_DB_PATH` 指定）。多实例/弹性扩缩容下 SQLite 不适用生产，后续可改为云开发文档型数据库或 MySQL。

## 依赖安装（本地校验云函数代码）

在每个函数目录执行：

```bash
cd cloudfunctions/plan && npm install
cd ../weather && npm install
cd ../chat && npm install
```

（部署时一般由云端安装依赖，本地仅用于语法检查或单元测试。）
