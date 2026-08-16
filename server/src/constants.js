/**
 * 全局常量（纯数据，无任何 import，避免循环依赖）。
 * 约定见 architecture.md §10「共享知识」。
 */

/** 颜色常量（座位固定映射：seat0=red、seat1=green、seat2=blue）。 */
export const RED = 'red';
export const GREEN = 'green';
export const BLUE = 'blue';

/** @type {ReadonlyArray<'red'|'green'|'blue'>} 座位序号 → 颜色。 */
export const SEAT_COLORS = Object.freeze([RED, GREEN, BLUE]);

/** 颜色 → 中文名（日志与前端共用）。 */
export const COLOR_LABELS = Object.freeze({
  [RED]: '红',
  [GREEN]: '绿',
  [BLUE]: '蓝',
});

/** 座位总数（三人局固定 3 座）。 */
export const SEAT_COUNT = 3;

/** 每方棋子数（= home 角格数 = target 角格数）。 */
export const PIECES_PER_COLOR = 10;

/** 棋盘合法坐标总数（中心六边形 61 + 6 个角 × 10）。 */
export const BOARD_SIZE = 121;

/**
 * 立方坐标 6 个相邻方向向量（q + r + s = 0 恒成立）。
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const DIRECTIONS = Object.freeze([
  Object.freeze([1, -1, 0]),
  Object.freeze([-1, 1, 0]),
  Object.freeze([1, 0, -1]),
  Object.freeze([-1, 0, 1]),
  Object.freeze([0, 1, -1]),
  Object.freeze([0, -1, 1]),
]);

/** 6 个角的名称。 */
export const CORNER_POS_Q = 'POS_Q';
export const CORNER_NEG_Q = 'NEG_Q';
export const CORNER_POS_R = 'POS_R';
export const CORNER_NEG_R = 'NEG_R';
export const CORNER_POS_S = 'POS_S';
export const CORNER_NEG_S = 'NEG_S';

/** @type {ReadonlyArray<string>} 全部角名。 */
export const CORNER_NAMES = Object.freeze([
  CORNER_POS_Q,
  CORNER_NEG_Q,
  CORNER_POS_R,
  CORNER_NEG_R,
  CORNER_POS_S,
  CORNER_NEG_S,
]);

/** 角 → 顶点坐标字符串（architecture.md §4.3）。 */
export const CORNER_APEX = Object.freeze({
  [CORNER_POS_Q]: '8,-4,-4',
  [CORNER_NEG_Q]: '-8,4,4',
  [CORNER_POS_R]: '-4,8,-4',
  [CORNER_NEG_R]: '4,-8,4',
  [CORNER_POS_S]: '-4,-4,8',
  [CORNER_NEG_S]: '4,4,-8',
});

/** 颜色 → home 角（初始布局所在角）。 */
export const COLOR_HOME = Object.freeze({
  [RED]: CORNER_NEG_Q,
  [GREEN]: CORNER_NEG_R,
  [BLUE]: CORNER_NEG_S,
});

/** 颜色 → target 角（目标营地，即 home 的对角）。 */
export const COLOR_TARGET = Object.freeze({
  [RED]: CORNER_POS_Q,
  [GREEN]: CORNER_POS_R,
  [BLUE]: CORNER_POS_S,
});

/** SSE 事件名（architecture.md §3.4，前端严格按此监听）。 */
export const SSE_EVENTS = Object.freeze({
  STATE: 'state',
  LOG: 'log',
  ROOM: 'room',
  FINISHED: 'finished',
});

/** 统一响应错误码（architecture.md §10）。 */
export const ERROR_CODES = Object.freeze({
  OK: 0,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  LLM_UNAVAILABLE: 503,
  INTERNAL: 500,
});

/** 房间模式。 */
export const ROOM_MODE_HUMAN = 'human';
export const ROOM_MODE_WATCH = 'watch';

/** 房间状态。 */
export const ROOM_STATUS_SETUP = 'setup';
export const ROOM_STATUS_PLAYING = 'playing';
export const ROOM_STATUS_FINISHED = 'finished';

/** 座位/玩家类型。 */
export const SEAT_TYPE_HUMAN = 'human';
export const SEAT_TYPE_AI = 'ai';

/**
 * AI 玩家思考强度（语义：模型自身是否经过思考做出决策；越高越慢、token 越多、通常越准）。
 * 通过 OpenAI 兼容的 `reasoning_effort` 参数透传（default 不传，跟随模型默认）。
 */
export const THINKING_LEVELS = Object.freeze(['default', 'off', 'low', 'medium', 'high']);

/** 思考强度 → reasoning_effort（default 不传）。 */
export const THINKING_TO_EFFORT = Object.freeze({
  off: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
});

/** 对局状态。 */
export const GAME_STATUS_PLAYING = 'playing';
export const GAME_STATUS_FINISHED = 'finished';

/** 单次 LLM 调用连接超时（TCP/TLS/首字节前的建立阶段，15s）。 */
export const LLM_CONNECT_TIMEOUT_MS = 15000;

/** 单次 LLM 调用总超时（含模型思考与响应体读取，30s；决策 4）。 */
export const LLM_TIMEOUT_MS = 30000;

/**
 * LLM 决策输出上限（max_tokens），按思考强度分级：
 *  - off / low：1024（几乎不思考或轻量思考，走法 JSON 很短）
 *  - default / medium：2048（标准思考）
 *  - high：4096（深度思考，推理模型需要更多输出预算，防截断成半个 JSON）
 */
export const LLM_MAX_TOKENS_BY_THINKING = Object.freeze({
  off: 1024,
  default: 2048,
  low: 1024,
  medium: 2048,
  high: 4096,
});

/** 同一 baseUrl 最小调用间隔（决策 5）。 */
export const MIN_LLM_INTERVAL_MS = 800;

/** 连通性测试 / 模型列表拉取超时（比对局决策更短，避免管理界面久等）。 */
export const PROVIDER_PROBE_TIMEOUT_MS = 15000;

/** SSE 心跳间隔。 */
export const SSE_HEARTBEAT_MS = 15000;

/** 连续失败达到该次数 → 座位进入 auto-pilot（决策 4）。 */
export const AUTO_PILOT_FAIL_THRESHOLD = 3;

/** LLM 解析/校验失败后的严格重试次数（决策 4：重试 1 次）。 */
export const LLM_STRICT_RETRY = 1;

/** 名次加成（决策 1）。 */
export const RANK_BONUS = Object.freeze({ 1: 300, 2: 150, 3: 50 });

/** 每 30 秒扣 5 分（决策 1）。 */
export const TIME_PENALTY_UNIT_SEC = 30;
export const TIME_PENALTY_PER_UNIT = 5;

/** 基础分：每颗到达目标营地的棋子 100 分（决策 1）。 */
export const BASE_SCORE_PER_PIECE = 100;

/**
 * 单局手数上限：达到后按当前进度强制终局结算。
 * 保证任何局面都会终止（例如对手棋子长期占住我方营地格，理论上永远填不满）。
 * 参考值：纯兜底算法完成一整局约 225 手，2000 手是非常宽松的安全网。
 */
export const MAX_GAME_PLIES = 2000;

/** 连跳链搜索保护上限（防止病态局面下组合爆炸）。 */
export const MAX_JUMP_CHAINS = 4000;
export const MAX_JUMP_DEPTH = 24;

/** AI 连续走子之间的节奏间隔（毫秒），让前端有观感、也避免打爆上游。 */
export const AI_MOVE_PACING_MS = 250;

/** 速率限制：时间窗口（毫秒）。 */
export const RATE_LIMIT_WINDOW_MS = 60000;

/** 速率限制：每个 IP 在时间窗口内的最大请求数。 */
export const RATE_LIMIT_MAX_REQUESTS = 120;
