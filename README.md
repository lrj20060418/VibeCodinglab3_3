# Lab 3-3 阶段一：项目结构 + 云函数后端（Node）

本仓库在 Lab 3-2（`frontend/` Vue + `backend/` FastAPI）基础上，增加 **CloudBase 云函数** 形态的后端，目录符合实验要求。

## 目录说明

```
project/
├── frontend/                 # Lab 3-2 前端（Vue 3 + Vite），沿用
├── cloudfunctions/
│   ├── plan/                 # 规划 + 同库天气/AI：…、POST /api/plans/:id/ai/summary、GET /api/plans/:id/ai/summary/stream（SSE）
│   ├── weather/              # 可选独立部署（与 plan 的 /tmp 不共享，线上请优先走 plan 路由）
│   └── chat/                 # 可选独立部署（同上）
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
| `plan` | SQLite CRUD、行程、导出、规则检查、**高德天气**、**AI 摘要**（内置混元/DeepSeek 或外部 LLM；流式 SSE） | `/api/plans...`、`/api/weather/live`、`/api/plans/:id/weather/live`、`POST /api/plans/:id/ai/summary`、`GET /api/plans/:id/ai/summary/stream`、`/health` |
| `weather` | 仅保留兼容；各函数 `/tmp` 隔离，**勿**把「按规划拉天气」指到本函数 | 同左路径若部署在 plan 上 |
| `chat` | 仅保留兼容；**AI 摘要**请在控制台为 **plan** 配置 `LLM_*` | 同左 |

**说明**：云函数实例间 **不共享** `/tmp` 内 SQLite。前端已将天气与 AI 请求指向 **与 CRUD 相同的 `plan` Base URL**；`plan` 云函数另将 sql.js 快照 **同步到文档型数据库集合 `lab3_plan_sqlite`**（**建议仅保留一条** `default` 文档），请求结束时写入，冷启动时拉取，以缓解多实例「Plan not found」。写入使用整数 **`version`**：先 `where({ version }).update`（CAS）；若部分环境下 `updated` 为 0，则对 **`doc('default')` 做 `update` 回退**（单文档集合下与 CAS 等价）。真并发冲突时仅在日志中打出 **CONFLICT**，**不再在 `finally` 里抛错**，以免吞掉已成功构造的 HTTP 200、导致前端误判或长时间无响应。旧数据无 `version` 时首次加载会补写 `version: 1`。本地用 `node` 直跑代码时无腾讯云密钥，会跳过同步（可设 `LAB3_DISABLE_CLOUD_SQLITE=1`）。

**超时（FUNCTION_TIME_LIMIT_EXCEEDED）**：冷启动加载 **sql.js WASM**、从文档库拉整库、写回快照，以及 **`/ai/summary` 调大模型**，累计易超过 **15s**。请到 CloudBase 控制台 **云函数 → `plan` → 函数配置**，将**执行超时**调到 **60～120 秒**（`InitTimeout` 亦建议 ≥60）。若报错来自**网关 / 调用方**的单独超时，需在对应入口一并放宽。本仓库 `cloudbaserc.json` 的 **`functions`** 里已为 **`plan` 配置 `timeout: 120`**，`tcb fn deploy plan --force` 时会一并更新。若你习惯执行 **`tcb fn deploy --all`**，请在该数组中**补全** `weather`、`chat` 等条目（与控制台现有配置一致），否则 CLI 只会部署数组里列出的函数。

**同容器加载慢 / 要刷很多次**：此前用「每次 HTTP 不同的 requestId」做 DB scope，**几乎每请求都会整库冷启**。现已改为 **`preparePlanDbForRequest`**：同实例 **复用内存 sql.js**；对 **`lab3_plan_sqlite` 做轻量 `field({ version, updatedAt })` 读取**；默认 **`LAB3_CLOUD_META_TTL_MS` 未设置时为 0**（**每次请求**都比对云端 version，换浏览器/多实例更稳）；需要减负时再设为毫秒数（如 `800`）。若 **云端 `version` > 本地 `cloudCasVersion`** 则丢弃缓存并重拉整库。若业务上仍 **404 Plan not found**，会 **整包从云端再拉一次**（每请求最多一次）自愈他实例刚写入或短暂读延迟。`flush` **CONFLICT** 时下一次请求 **强制重拉**。仍请保证 **云函数超时 ≥60s**。

返回格式：HTTP 访问场景下使用 API 网关风格 `{ statusCode, headers, body }`，`body` 为 JSON 字符串；与原有 FastAPI 的 JSON 结构一致（错误为 `{ "detail": "..." }`）。

## 前端如何走公网云函数

在 `frontend/.env.local` 中配置（**不要提交**）：

```env
# 留空则仍走 Vite 代理到本地 FastAPI（Lab 3-2）
VITE_CLOUD_PLAN_URL=
```

部署后为 **`plan`** 创建 **HTTP 访问路径**，将 `VITE_CLOUD_PLAN_URL` 设为「默认网关域名 + 路径前缀」（不要末尾 `/`）。天气与 AI 与规划 **共用该 URL**（源码中 `weatherApiBase` / `chatApiBase` 已指向 `planApiBase`）。示例：

- `plan` → `/lab3-plan`

默认域名为：`https://<envId>.service.tcloudbase.com`（与控制台「云函数网关」一致），例如：

```env
VITE_CLOUD_PLAN_URL=https://<envId>.service.tcloudbase.com/lab3-plan
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
- **前端**：配置 **`VITE_CLOUD_PLAN_URL`** 即可（天气与 AI 与 plan 同源）；**源码中不包含** LLM / 高德 Web 服务 Key；地图仅使用 `VITE_AMAP_*`（见 `frontend/.env.production.example`）。
- **本地静态验收**：见 `frontend/README.md` 中「Lab 3-3 v2.0」：`npm run build` 后于 `dist/` 下执行 `python -m http.server`。

## Lab 3-3 v2.1：静态托管上线 + 安全收紧（当前环境）

### 公网访问地址（出行规划器）

**https://vibe-lab3-3-d4gw0nadh7234883b-1429528420.tcloudbaseapp.com/**

手机浏览器打开上述链接即可使用（需已配置云函数 `plan` 的 `AMAP_WEBSERVICE_KEY`、高德 JS Key 白名单含本域名，以及构建时写入的 `VITE_CLOUD_PLAN_URL`）。

### 构建与部署静态站点

```bash
cd frontend
# 生产 API 指向云函数网关（勿提交含真实高德 Key 的 .env.production）
set VITE_CLOUD_PLAN_URL=https://vibe-lab3-3-d4gw0nadh7234883b.service.tcloudbase.com/lab3-plan
npm run build
```

将 `frontend/dist/` 部署到 CloudBase **静态网站托管**（控制台上传或使用 CloudBase CLI / MCP `uploadFiles`，`cloudPath` 为站点根 `/`）。

### CORS

`plan` / `weather` / `chat` 的 `corsOrigin.js` 将 `Access-Control-Allow-Origin` 收紧为 **静态托管 Origin**（默认即上表 URL），并允许 **localhost / 127.0.0.1 任意端口** 便于本地 Vite 调试。可通过云函数环境变量 **`LAB3_HOSTING_ORIGIN`** 覆盖默认托管域名。若手机访问的 **站点域名** 与默认不一致（例如换了静态托管域名），必须在 **`plan` 环境变量** 里设置 **`LAB3_HOSTING_ORIGIN`** 为手机打开的 **完整 Origin**（含 `https://`），否则浏览器会拦截跨域请求，表现为「加载不出」。

### 高德 Web 端 Key 白名单

在高德开放平台 → 应用 → **Web端(JS API) Key** → **安全设置** → **域名白名单**，添加：

`vibe-lab3-3-d4gw0nadh7234883b-1429528420.tcloudbaseapp.com`

（不要写 `https://` 前缀，按高德控制台要求填写主机名。）

### v2.1 安全自检清单（实验报告可逐项打勾）

| 项 | 说明 | 证据 |
|----|------|------|
| 仓库无硬编码敏感 Key | 在仓库根执行 `rg -i "sk-|Bearer |apikey|KEY=" --glob '!**/node_modules/**'` 应无真实密钥 | 自行截图检索结果 |
| 环境文件不入库 | `.gitignore` 已忽略 `.env`、`.env.*`，仅保留 `*.env.example` | 本仓库 `.gitignore` |
| 前端仅高德 JS Key | `frontend/src` 无 LLM / 高德 Web 服务 Key | 代码审查 / `rg` |
| 云函数 CORS 已收紧 | 默认仅静态托管 Origin + 本机调试 | `cloudfunctions/*/corsOrigin.js` |
| 云函数密钥在控制台 | `AMAP_WEBSERVICE_KEY` 等仅在 CloudBase 环境变量配置；v2.2 默认内置大模型可不配 `LLM_*` | 控制台截图 |
| 手机端全流程验证 | 首屏 + 新建规划 → 选点 → 天气 → 保存 | 自行截图 |
| 资源监控 | 云函数调用次数、静态托管流量 | 控制台「资源监控」截图 |

若课程要求 Git 提交说明为中文而本机 `git commit -m` 出现乱码，可在仓库根执行：  
`git commit --amend -m "feat: v2.1 前端部署至 CloudBase 静态托管，全链路上线"` 后 `git push --force-with-lease`（仅当你确定要覆盖远端该条提交时）。

## Lab 3-3 v2.2：内置大模型 + SSE 流式 + GitHub Actions 部署

### 内置大模型（与 v2.1 兼容）

- **默认**：`plan` / `chat` 在未配置 `LLM_API_KEY` 时使用 **CloudBase 内置**模型（依赖 `@cloudbase/node-sdk` ≥3.16 的 `app.ai()`），云函数内 `TCB_ENV` 等由平台注入，一般**不必**再配 `LAB3_CLOUDBASE_ENV_ID`。
- **仍用外部 Key**：照常配置 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`，或显式 `LAB3_AI_BACKEND=external`。
- **模型切换**：`LAB3_CLOUD_AI_PROVIDER=deepseek` 或 `LAB3_CLOUD_AI_MODEL=deepseek-v3.2` 等（见 `.env.example`）；默认混元 `hunyuan-2.0-instruct-20251111`。

### 流式 AI（SSE + EventSource）

- 网关路由：**`GET /api/plans/:planId/ai/summary/stream?style=normal`**（`style` 同 POST）。
- 响应：`Content-Type: text/event-stream`，正文为 SSE：`data: {"delta":"..."}` 增量；结束为 `data: {"done":true}`；业务错误为自定义事件 **`summaryerror`**（仍 200，便于 EventSource 解析）。
- **说明**：云函数 HTTP 一般为**整包返回**网关后再送达浏览器，与长连接真·逐包推送有差异；前端在收到完整响应后仍会**按 SSE 事件顺序**多次触发 `onDelta`，观感上为逐段追加。未配置 `VITE_CLOUD_PLAN_URL`（本地走 Vite 代理）时，前端会**自动回退**为 `POST /ai/summary` 非流式，避免代理不到 SSE。

### CI/CD（GitHub Actions）

- 工作流：`.github/workflows/deploy-cloudbase.yml`，在 **push 到 `master` 或 `main`** 时：`npm ci` + `npm run build`（前端），再 `tcb login --apiKeyId … --apiKey …`、`tcb fn deploy plan --force`、`tcb hosting deploy frontend/dist -e <envId>`。
- 需在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 中新增下列 **Name** 与取值（文档里已写全名；此前仅列清单，下面补「到哪看」）。

#### GitHub Actions 里各 Secret 从哪看？

| Secret 名称 | 是什么 | 在哪查看 / 怎么填 |
|-------------|--------|-------------------|
| **`TCB_ENV_ID`** | 云开发环境 ID，与根目录 **`cloudbaserc.json`** 里的 **`envId`** 必须一致 | 打开本仓库 `cloudbaserc.json` 复制 `envId`；或在 [云开发控制台](https://tcb.cloud.tencent.com/) 左上角/环境列表里看到的 **环境 ID**（形如 `xxx-数字`） |
| **`TCB_API_KEY_ID`** | 腾讯云 **SecretId**（CLI 参数名叫 `apiKeyId`） | [访问管理 → 访问密钥 → API 密钥管理](https://console.cloud.tencent.com/cam/capi) → 使用已有密钥或「新建密钥」→ 复制 **SecretId** 填到本项（勿提交到 Git） |
| **`TCB_API_KEY`** | 腾讯云 **SecretKey**（与上条同一组密钥） | 同上页复制 **SecretKey**（仅创建时完整显示一次，请自行安全保存）。该主账号或子用户需具备云开发/云函数/静态托管等相关权限 |
| **`VITE_CLOUD_PLAN_URL`** | 前端构建时写入的 **plan 云函数 HTTP 网关 Base URL**（无末尾 `/`） | [云开发控制台](https://tcb.cloud.tencent.com/) → 你的环境 → **云函数** → **`plan`** → **HTTP 访问**（或「云函数网关」）→ 查看 **默认域名 + 路径前缀**，拼成 `https://<envId>.service.tcloudbase.com/<前缀>`（具体以控制台为准，与 README 前文「前端如何走公网云函数」示例一致） |
| **`VITE_AMAP_KEY`** | 高德 **Web 端（JS API）** Key | [高德开放平台](https://console.amap.com/) → 应用 → 选择/创建应用 → **Key** 列表里类型为 **Web端(JS API)** 的 Key |
| **`VITE_AMAP_SECURITY_JS_CODE`** | 与上一条 Key 配套的 **安全密钥**（控制台里「安全密钥 / jscode」） | 同上高德控制台该 Key 的 **安全设置** 中查看；与本地 `frontend/.env.production` 里用于打包的值相同 |

补充说明：

- **`TCB_API_KEY_ID` / `TCB_API_KEY`**：与 CloudBase 文档里 `tcb login --apiKeyId … --apiKey …` 对应，一般即 **腾讯云 CAM 的 SecretId / SecretKey**；若你使用子用户，请在 CAM 为该子用户勾选云开发/SCF 等权限。官方 CI 说明仍见：[Using in the CI Environment](https://docs.cloudbase.net/en/framework/ci)。
- **`VITE_*`**：只在 **GitHub 构建前端** 时需要；与你在本机打包上线时 `frontend/.env.production` 里填的 **一致即可**（不要把含真实 Key 的 `.env.production` 提交进仓库）。

## 部署提示

1. 根目录 `cloudbaserc.json` 中 `envId` 需与你的环境一致（当前示例已为绑定环境）。
2. 在 CloudBase 控制台为 **`plan`** 配置 **`AMAP_WEBSERVICE_KEY`**（须为高德控制台 **[Web服务] 类型** 的 Key；若误用 **Web端(JS API)** Key 会返回 `USERKEY_PLAT_NOMATCH`）。**大模型（v2.2）**：未配置 **`LLM_API_KEY`** 时默认走 **CloudBase 内置**混元/DeepSeek（`@cloudbase/node-sdk` ≥3.16 的 `ai().createModel().generateText` / `streamText`），**无需自建 Key**；若仍用外部 OpenAI 兼容接口，请配置 **`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`** 或设置 **`LAB3_AI_BACKEND=external`**。可选 **`LAB3_CLOUD_AI_PROVIDER`**（`hunyuan`/`deepseek`）与 **`LAB3_CLOUD_AI_MODEL`** 覆盖默认模型名。`weather` / `chat` 若仍单独部署，可按需配置。
3. 使用 CloudBase CLI / 控制台上传云函数；至少为 **`plan`** 开启 **HTTP 访问**（如 `/lab3-plan`），路径需能转发到函数内识别的 `/api/...`（与 Lab 3-2 相同路径最省事）。
4. **数据库**：当前 **`plan`** 使用 **SQLite**（默认 `os.tmpdir()/lab3-cloudfunctions/app.db`）。多实例下仍为进程内临时存储，实验可用；生产建议改为云数据库。

## 依赖安装（本地校验云函数代码）

在每个函数目录执行：

```bash
cd cloudfunctions/plan && npm install
cd ../weather && npm install
cd ../chat && npm install
```

（部署时一般由云端安装依赖，本地仅用于语法检查或单元测试。）
