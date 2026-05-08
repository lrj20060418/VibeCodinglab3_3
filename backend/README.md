# Backend（FastAPI）

## 运行（Windows / PowerShell）

建议使用虚拟环境：

```bash
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

验证：

- 打开 `http://127.0.0.1:8000/health`  
  期望返回：`{"ok": true}`

## V2：规划管理 API（SQLite 持久化）

后端会在 `backend/app.db` 创建 SQLite 数据库文件（可用环境变量 `LAB3_DB_PATH` 自定义路径）。

### 接口

- `POST /api/plans`
  - body 示例：
    ```json
    {"title":"周末出游","date":"2026-04-30","budget":500,"people_count":2,"preferences":"喜欢自然景点"}
    ```
- `GET /api/plans`
- `GET /api/plans/{plan_id}`
- `PUT /api/plans/{plan_id}`
  - body 示例（仅传需要更新的字段）：
    ```json
    {"budget":800,"preferences":"尽量少走路"}
    ```

### 验收点（持久化）

1. `POST /api/plans` 创建一条规划
2. 重启后端（停止再启动）
3. `GET /api/plans` 仍能看到刚才创建的规划

## V4：地点管理 API（加入规划、列表、删除）

### 接口

- `GET /api/plans/{plan_id}/places`
- `POST /api/plans/{plan_id}/places`
  - body 示例：
    ```json
    {"name":"选中地点","address":"上海市…","lng":121.47,"lat":31.23,"adcode":"310000"}
    ```
- `DELETE /api/plans/{plan_id}/places/{place_id}`

## V5：天气展示（后端统一调用高德天气）

### 配置

把高德 Web 服务 Key 放到后端本地文件 `backend/.env`（不要写进前端，也不要提交到仓库）：

1. 复制示例文件：

```bash
cd backend
copy .env.example .env
```

2. 编辑 `backend/.env`，填写你的 Key：

`AMAP_WEBSERVICE_KEY=你的Web服务Key`

### 接口

- `GET /api/weather/live?adcode=xxxxxx`
  - 返回：`{ "weather": { status, temperature, wind_direction, wind_power, humidity, report_time, adcode } }`
- `GET /api/plans/{plan_id}/weather/live`
  - 返回：`{ "weathers": { [place_id]: weather }, "errors": { [place_id]: "reason" } }`

## V6：行程安排 + AI 辅助总结

### 行程接口

- `GET /api/plans/{plan_id}/itinerary`
- `PUT /api/plans/{plan_id}/itinerary`
  - body 示例：
    ```json
    {"items":[{"place_id":"...","time_slot":"morning","sort_index":0}]}
    ```

### AI 总结配置（写在 backend/.env，本地文件不提交）

在 `backend/.env` 中加入：

```env
LLM_API_KEY=你的Key
LLM_BASE_URL=你的chat/completions地址
LLM_MODEL=你的模型名
```

### AI 总结接口

- `POST /api/plans/{plan_id}/ai/summary`
  - body 示例：`{"style":"normal"}`
  - 返回：`{"summary":"..."}`

## 扩展：规划导出 + 规则检查

### 导出（Markdown / JSON）

- `GET /api/plans/{plan_id}/export?format=md`
  - 返回：`{ "format": "md", "content": "# ...markdown..." }`
- `GET /api/plans/{plan_id}/export?format=json`
  - 返回：`{ "format": "json", "content": { plan, places, itinerary, weather_by_place } }`

### 规则检查（预算 / 安排完整性 / 雨天风险）

- `GET /api/plans/{plan_id}/checks`
  - 返回：`{ "issues": [ { level, code, title, detail } ] }`