---
title: Lab 3-2 V0 系统设计（需求与架构草案）
date: 2026-04-10
---

## 0. 系统一句话定义

本系统是一个**前后端分离**的“智能出行规划器”：用户围绕“一份出行规划”完成创建、编辑、保存、再次打开，并在地点与天气信息的基础上获得一段 AI 辅助总结。

## 1. 用户主流程（必走通）

1) 用户进入系统 → **创建**或**打开**一份规划  
2) 填写规划基本信息：日期、预算、人数、偏好  
3) 在地图上选择地点 → 加入当前规划（形成地点列表）  
4) 系统为地点拉取并展示天气信息（或天气摘要）  
5) 用户把地点安排到时间段：上午 / 下午 / 晚上  
6) 用户保存规划 → 之后可再次打开继续编辑  
7) 系统基于“地点 + 天气 + 时间安排 + 预算”等生成 **AI 辅助总结**（优点/风险/可改进）

> 关键提醒：核心不是聊天，而是“规划数据的组织与闭环”。

## 2. 模块划分（前端/后端）

### 2.1 前端模块（负责展示与交互）

- **规划管理 UI**
  - 新建规划、选择已有规划、编辑基本信息、保存按钮
  - 状态：loading / error / empty
- **地点管理 UI**
  - 地图选点、地点列表（查看/删除/调整）
  - 选点时提示下一步（例如“点击加入规划”）
- **天气展示 UI**
  - 在规划页面中展示与地点相关的天气（或摘要）
  - 失败时明确提示（例如“天气获取失败/缺少 adcode”）
- **行程安排 UI**
  - 时间段面板：上午/下午/晚上
  - 支持把地点放入时间段（拖拽可选做；按钮选择也可）
- **AI 辅助总结 UI**
  - 生成按钮、生成中状态、结果展示

### 2.2 后端模块（负责数据、业务与第三方调用）

- **规划数据管理**
  - CRUD：创建/读取/更新/列表（可加删除）
  - SQLite 持久化（必须满足“重启不丢”）
- **地点与行程数据管理**
  - 规划与地点、时间段安排的结构化保存
- **天气服务（统一调用第三方）**
  - 根据地点（adcode/经纬度）获取天气并返回“前端友好”的结构
- **大模型服务（统一调用第三方，保护 Key）**
  - 前端只调用你的后端接口；大模型 Key **仅存在后端**
  - 输出为“AI 辅助总结”，不替代规划功能

## 3. 前后端职责边界（写清楚防跑偏）

- **前端不做**：直接携带第三方 Key 调大模型；复杂业务编排；持久化存储  
- **后端不做**：页面交互；地图 UI 操作  
- **第三方调用统一原则**：
  - 天气/大模型等外部调用尽量走后端
  - 前端只调用“你自己的后端 API”

## 4. 数据模型（SQLite 表设计草案）

> 目标：满足“规划可保存、可再次打开继续编辑”，并能关联地点、天气与行程安排。

### 4.1 表：plans（规划）

- `id` (TEXT / UUID, PK)
- `title` (TEXT) 规划名称（可选）
- `date` (TEXT) 出行日期（ISO 字符串）
- `budget` (INTEGER) 预算（可选）
- `people_count` (INTEGER) 人数（可选）
- `preferences` (TEXT) 偏好（可存 JSON 字符串或纯文本）
- `created_at` (TEXT)
- `updated_at` (TEXT)

### 4.2 表：places（地点，隶属于某个规划）

- `id` (TEXT / UUID, PK)
- `plan_id` (TEXT, FK → plans.id)
- `name` (TEXT) 地点名
- `address` (TEXT) 详细地址（可选）
- `lng` (REAL)
- `lat` (REAL)
- `adcode` (TEXT) 便于天气查询（建议保存）
- `note` (TEXT) 备注（可选）
- `sort_index` (INTEGER) 地点在列表中的顺序
- `created_at` (TEXT)

### 4.3 表：itinerary_items（行程安排：地点 → 时间段）

- `id` (TEXT / UUID, PK)
- `plan_id` (TEXT, FK → plans.id)
- `place_id` (TEXT, FK → places.id)
- `time_slot` (TEXT) 取值：`morning` / `afternoon` / `evening`
- `sort_index` (INTEGER) 时间段内排序

### 4.4 可选：weather_cache（天气缓存，选做）

- `id` (TEXT, PK)
- `place_id` (TEXT, FK)
- `weather_json` (TEXT) 原始/整理后的 JSON
- `fetched_at` (TEXT)

> 说明：不强制做缓存，但做了能减少重复请求、提升体验。

## 5. REST API 设计（草案：路由 + 入参 + 返回示例）

> 约定：后端统一返回 JSON；错误时返回 `{ error: { code, message } }`。

### 5.1 Health

- `GET /health`
  - 返回：`{ "ok": true }`

### 5.2 规划 Plans

- `POST /api/plans`
  - 入参：
    - `title?`, `date`, `budget?`, `people_count?`, `preferences?`
  - 返回：`{ plan }`

- `GET /api/plans`
  - 返回：`{ plans: [...] }`

- `GET /api/plans/{planId}`
  - 返回：`{ plan, places: [...], itinerary: [...] }`

- `PUT /api/plans/{planId}`
  - 入参：可更新字段
  - 返回：`{ plan }`

### 5.3 地点 Places（属于某个规划）

- `POST /api/plans/{planId}/places`
  - 入参：`name, address?, lng, lat, adcode?, note?, sort_index?`
  - 返回：`{ place }`

- `GET /api/plans/{planId}/places`
  - 返回：`{ places: [...] }`

- `DELETE /api/plans/{planId}/places/{placeId}`
  - 返回：`{ ok: true }`

### 5.4 行程 Itinerary

- `PUT /api/plans/{planId}/itinerary`
  - 入参：`items: [{ place_id, time_slot, sort_index }]`
  - 返回：`{ itinerary: [...] }`

### 5.5 天气 Weather（后端统一调用第三方）

- `GET /api/weather/live?adcode=xxxxx`
  - 返回示例：
    - `{ weather: { status, temperature, wind, humidity, report_time } }`

> 也可设计为 `GET /api/plans/{planId}/weather` 返回“规划内所有地点的天气摘要”。

### 5.6 AI 辅助总结 AI Summary（后端统一调用大模型）

- `POST /api/plans/{planId}/ai/summary`
  - 入参：可选 `style?`（简洁/详细）
  - 返回：`{ summary: "..." }`
  - 规则：前端绝不持有大模型 Key；Key 只在后端配置/环境变量。

## 6. 每个模块的最小验收标准（可检查项）

### 6.1 规划管理（必做）

- [ ] 能创建规划并保存到 SQLite
- [ ] 能列出规划列表并打开详情
- [ ] 重启后端后规划仍存在（持久化成立）
- [ ] 表单有 loading/失败提示，错误信息可理解

### 6.2 地点管理（必做）

- [ ] 地图选点后能加入规划并持久化
- [ ] 能查看地点列表、删除地点
- [ ] 刷新页面后地点仍存在

### 6.3 天气展示（必做）

- [ ] 为规划地点展示天气（至少实时/摘要）
- [ ] 请求失败时 UI 提示清楚（而不是空白）

### 6.4 行程安排（必做）

- [ ] 能把地点分配到上午/下午/晚上
- [ ] 能保存并再次打开仍保持安排

### 6.5 AI 辅助总结（必做）

- [ ] AI 总结基于地点+天气+时间段+预算输出（不是泛泛回答）
- [ ] 前端代码中找不到大模型 Key
- [ ] 生成中/失败状态清楚

