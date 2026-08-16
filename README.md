# AI Draughts — 中国跳棋 AI 对战平台

一个基于 **大语言模型（LLM）** 驱动的三人中国跳棋（Chinese Checkers）对战平台：
支持「人机对战」（玩家任选座位/颜色，其余座位由 AI 接管）与「纯观战」（三个 AI 自动对弈），
后端内置规则引擎、LLM 决策与 SSE 实时推送，前端用 React 实时渲染棋盘与决策日志。

> 仓库为前后端分离结构：`server/`（Node + Express 5 后端）+ `client/`（Vite + React 18 前端）。

---

## 功能特性

- **三人跳棋对战**：固定红 / 绿 / 蓝三座，每方 10 子，按中国跳棋规则（连跳可中途停止）。
- **两种房间模式**
  - `human`（人机对战）：seat0 默认人类，其余座位指派 AI 玩家；支持 `humanSeat` 选择落座/颜色。
  - `watch`（纯观战）：三个座位全部由 AI 玩家接管，自动开赛。
- **AI 玩家管理**：每个 AI 玩家绑定一个「模型配置」+ 具体模型名 +「思考强度」（`reasoning_effort`：off / low / medium / high / default）。
- **多模型供应商**：兼容 OpenAI 格式 API（`baseUrl` + `apiKey`），可配置多家并缓存模型列表、做连通性测试。
- **实时观战**：SSE 长连接推送 `state` / `room` / `log` / `finished` 四类事件，前端实时渲染棋盘与决策理由。
- **稳健的 LLM 决策**：阶段化策略（开局 / 中盘 / 收尾）、连跳规则校验、思考强度分级、严格重试 1 次、连续失败自动转兜底（auto-pilot），保证对局必然终止（手数上限兜底）。
- **零编译后端**：纯 ESM，直接 `node` 运行，无需构建步骤。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18、Vite 5、React Router 6、MUI 5、Tailwind CSS 3、Emotion |
| 后端 | Node.js ≥ 22、Express 5、CORS、原生 SSE |
| 规则引擎 | 自研（立方坐标 `q,r,s`，六方向） |
| 持久化 | 项目内 JSON 文件（`server/data/`） |
| 实时通信 | Server-Sent Events（SSE） |

---

## 目录结构

```
AI_Draughts/
├── ai-draughts-launch.bat   # Windows 一键启动脚本（后端 3001 + 前端 5180）
├── server/                  # 后端
│   ├── src/
│   │   ├── index.js         # 入口：Express 应用 + 启动监听
│   │   ├── start.mjs        # 一键启动（自动探测可用端口）
│   │   ├── config.js        # 运行时配置（环境变量覆盖）
│   │   ├── constants.js     # 全局常量（颜色/座位/规则/超时/错误码）
│   │   ├── engine/          # 规则引擎：board / rules / game / fillPlan
│   │   ├── routes/          # REST 路由：rooms / aiPlayers / modelConfigs
│   │   ├── services/        # llmDecision / modelProvider / promptBuilder
│   │   ├── realtime/        # sseManager（SSE 连接管理）
│   │   ├── scheduler.js     # AI 回合调度
│   │   ├── store.js         # JSON 文件持久化层
│   │   └── http.js          # 统一响应 / 错误封装
│   └── test/engine.test.mjs # 规则引擎自测
├── client/                  # 前端
│   └── src/
│       ├── api/             # client.js（REST）、sse.js（SSE）
│       ├── pages/           # RoomPage / GamePage / AIPlayerPage / ModelConfigPage
│       ├── components/      # 房间、棋盘、AI 玩家、模型配置等组件
│       ├── context/         # AppContext / ThemeContext
│       ├── hooks/           # useSSE / useModels
│       └── utils/           # boardGeometry / colors
└── docs/                    # 设计文档（architecture.md / prd.md / *.mermaid）
```

---

## 快速开始

### 环境要求

- **Node.js ≥ 22**（后端 `engines` 要求；推荐 22 LTS）。
- npm（随 Node 附带）。

### 方式一：Windows 一键启动（推荐）

双击 `ai-draughts-launch.bat`：自动探测并安装缺失依赖、分别在新窗口启动
后端（端口 `3001`）与前端（端口 `5180`），并打开浏览器。
关闭两个控制台窗口即可停止服务。

### 方式二：手动启动

```bash
# 1) 安装依赖（首次）
cd server && npm install
cd ../client && npm install

# 2) 启动后端（默认 3001；或用 node src/index.js 直接指定端口）
cd ../server
node start.mjs                 # 自动探测可用端口（默认从 3001 起）
# 或：PORT=3005 node start.mjs # 强制使用 3005

# 3) 启动前端（另开一个终端）
cd ../client
npm run dev                   # 默认 5173；VITE_PORT=5180 npm run dev 可改端口
```

启动后访问前端地址（默认 `http://localhost:5173/`）。

---

## 配置

### 后端（`server/.env.example` → 复制为 `server/.env`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3001` | 后端监听端口（设置后跳过自动探测） |
| `START_PORT` | `3001` | 未设 `PORT` 时，从此端口起自动探测可用端口 |
| `CORS_ORIGIN` | `*` | 允许跨域的前端地址；`*` 放行全部，或逗号分隔多个 |
| `DATA_DIR` | `server/data` | JSON 数据文件目录 |
| `LLM_TIMEOUT_MS` | `30000` | 单次 LLM 调用总超时 |
| `LLM_CONNECT_TIMEOUT_MS` | `15000` | 单次 LLM 连接超时 |
| `MIN_LLM_INTERVAL_MS` | `800` | 同一 `baseUrl` 最小调用间隔 |
| `SSE_HEARTBEAT_MS` | `15000` | SSE 心跳间隔 |
| `AI_DRAUGHTS_AUTOSTART` | — | 设为 `1` 时 `import` 也自动启动（测试用） |

> ⚠️ `server/data/` 含第三方模型 API Key 与对局状态，**已被 `.gitignore` 忽略**，请勿提交。

### 前端（`client/.env`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE` | `http://localhost:3001` | 后端 API 基地址 |

---

## 使用流程

1. **模型配置**：在「模型配置」页添加供应商（`baseUrl` + `apiKey`），可拉取模型列表、做连通性测试。
2. **AI 玩家**：在「AI 玩家」页创建玩家，绑定模型配置 + 具体模型 + 思考强度。
3. **建房**：在「房间」页创建房间（`human` / `watch`），为 AI 座位指派玩家。
4. **开赛**：座位满员后点击开赛，AI 自动接管对应回合。
5. **对弈 / 观战**：人机模式下轮到你时点击合法落点走子；SSE 实时推送棋盘与 AI 决策日志。

---

## API 概览

基础前缀 `/api`。统一响应格式：`{ code, data, message }`（`code=0` 成功）。

### 健康检查
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务健康 + 活跃对局数 |

### 模型配置 `/api/model-configs`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 列表（**不含 apiKey**） |
| POST | `/` | 新增（`name`,`baseUrl`,`apiKey`） |
| GET | `/:id` | 详情（不含 apiKey） |
| PUT | `/:id` | 编辑（`apiKey` 传空串保留原值） |
| DELETE | `/:id` | 删除（被 AI 玩家占用返回 409） |
| GET | `/:id/models` | 代理拉取模型列表并缓存 |
| POST | `/:id/test` | 连通性测试（成功/失败 + 耗时） |

### AI 玩家 `/api/ai-players`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 列表 |
| POST | `/` | 新增（`name`,`modelConfigId`,`model`,`thinkingLevel?`） |
| GET | `/:id` | 详情 |
| PUT | `/:id` | 编辑 |
| DELETE | `/:id` | 删除（被未结束房间占用返回 409） |

### 房间 `/api/rooms`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 房间列表（不含棋盘） |
| POST | `/` | 创建（`mode`,`humanSeat?`,`createdBy?`） |
| GET | `/:id` | 房间详情（含 GameState） |
| PUT | `/:id/seats` | 指派 / 清空 AI 座位 |
| POST | `/:id/start` | 满员开赛（未满员 409） |
| GET | `/:id/stream` | **SSE** 事件流（连接即推快照） |
| GET | `/:id/legal-moves` | 当前人类座位的合法走法（高亮用） |
| POST | `/:id/move` | 人类走子（`from`,`to`，非法 422） |
| DELETE | `/:id` | 删除房间（中断进行中对局） |

**SSE 事件**：`state`（棋盘/对局状态）、`room`（房间变更）、`log`（决策日志）、`finished`（终局）。

---

## 测试

```bash
cd server
npm test            # 规则引擎自测（engine.test.mjs）
```

---

## 架构与设计

详细设计见 [`docs/architecture.md`](docs/architecture.md)（含类图 `class-diagram.mermaid`、时序图 `sequence-diagram.mermaid` 与需求 `prd.md`）。核心要点：

- **规则引擎**：立方坐标 `q+r+s=0`，六方向相邻；连跳收集所有可达落点（含中途停止）。
- **LLM 决策**：`services/llmDecision.js` 调用模型，按思考强度传 `reasoning_effort`；`promptBuilder.js` 注入阶段化策略；解析失败严格重试 1 次，连续失败转兜底。
- **调度**：`scheduler.js` 异步推进 AI 回合，不阻塞 HTTP 响应。
- **持久化**：`store.js` 以 JSON 文件保存 `modelConfigs / aiPlayers / rooms / games`，重启自愈孤儿房间。

---

## 已知限制 / 注意事项

- `server/data/` 与各类 `*.log` 已被 `.gitignore` 忽略；克隆仓库后首次启动会自动创建数据目录。
- `ai-draughts-launch.bat` 为 Windows 专用；其它平台请使用「方式二」手动启动。
- LLM 决策依赖外部模型 API，模型不支持 `reasoning_effort` 时会调用失败并走兜底逻辑，不影响对局进行。
- 前端默认开发端口 `5173`，一键启动脚本用 `5180`；如不一致请同步 `CORS_ORIGIN` 与 `VITE_API_BASE`。
