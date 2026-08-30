/**
 * 全局常量（纯数据，无任何 import，避免循环依赖）。
 * 约定见 architecture.md §10「共享知识」。
 */

/** 颜色常量（座位固定映射：seat0=red、seat1=green、seat2=blue）。 */
export const RED = 'red';
export const GREEN = 'green';
export const BLUE = 'blue';
export const YELLOW = 'yellow';
export const PURPLE = 'purple';
export const ORANGE = 'orange';

/**
 * 全部 6 色（多人模式用）。home 角固定映射：
 *   red→NEG_Q、green→NEG_R、blue→NEG_S、yellow→POS_Q、purple→POS_S、orange→POS_R，
 * target 恒为 home 的对角。3 人局只用红绿蓝（与旧数据完全兼容）。
 */
export const ALL_COLORS = Object.freeze([RED, GREEN, BLUE, YELLOW, PURPLE, ORANGE]);

/** @type {ReadonlyArray<'red'|'green'|'blue'>} 3 人局座位序号 → 颜色（向后兼容）。 */
export const SEAT_COLORS = Object.freeze([RED, GREEN, BLUE]);

/** 颜色 → 中文名（日志与前端共用）。 */
export const COLOR_LABELS = Object.freeze({
  [RED]: '红',
  [GREEN]: '绿',
  [BLUE]: '蓝',
  [YELLOW]: '黄',
  [PURPLE]: '紫',
  [ORANGE]: '橙',
});

/** 座位总数（三人局固定 3 座；多人模式用 MODE_SEAT_COLORS，此常量仅向后兼容保留）。 */
export const SEAT_COUNT = 3;

/** 支持的对局人数（中国跳棋标准：2/3/4/6 人）。 */
export const PLAYER_COUNTS = Object.freeze([2, 3, 4, 6]);

/** 默认对局人数（三人局）。 */
export const DEFAULT_PLAYER_COUNT = 3;

/**
 * 对局人数 → 座位序号 → 颜色。
 * 角色分布（home 角见 COLOR_HOME，target 恒为对角）：
 *  - 2 人：NEG_Q(红) vs POS_Q(黄)——标准对角局；
 *  - 3 人：NEG_Q/NEG_R/NEG_S（红绿蓝）——现状布局，完全向后兼容；
 *  - 4 人：NEG_Q(红)/POS_Q(黄)/NEG_S(蓝)/POS_S(紫)——两组对角、座位交替落座；
 *  - 6 人：按环序 POS_Q/NEG_R/POS_S/NEG_Q/POS_R/NEG_S 全角落座。
 */
export const MODE_SEAT_COLORS = Object.freeze({
  2: Object.freeze([RED, YELLOW]),
  3: Object.freeze([RED, GREEN, BLUE]),
  4: Object.freeze([RED, YELLOW, BLUE, PURPLE]),
  6: Object.freeze([YELLOW, GREEN, PURPLE, RED, ORANGE, BLUE]),
});

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

/** 颜色 → home 角（初始布局所在角；6 色固定占满六角，3 人局只用 NEG_Q/NEG_R/NEG_S）。 */
export const COLOR_HOME = Object.freeze({
  [RED]: CORNER_NEG_Q,
  [GREEN]: CORNER_NEG_R,
  [BLUE]: CORNER_NEG_S,
  [YELLOW]: CORNER_POS_Q,
  [PURPLE]: CORNER_POS_S,
  [ORANGE]: CORNER_POS_R,
});

/** 颜色 → target 角（目标营地，即 home 的对角）。 */
export const COLOR_TARGET = Object.freeze({
  [RED]: CORNER_POS_Q,
  [GREEN]: CORNER_POS_R,
  [BLUE]: CORNER_POS_S,
  [YELLOW]: CORNER_NEG_Q,
  [PURPLE]: CORNER_NEG_S,
  [ORANGE]: CORNER_NEG_R,
});

/** SSE 事件名（architecture.md §3.4，前端严格按此监听）。 */
export const SSE_EVENTS = Object.freeze({
  STATE: 'state',
  LOG: 'log',
  ROOM: 'room',
  FINISHED: 'finished',
  /** AI 思考流式片段（{seat, delta}），节流推送。 */
  THINKING: 'thinking',
});

/** 统一响应错误码（architecture.md §10）。 */
export const ERROR_CODES = Object.freeze({
  OK: 0,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
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

/**
 * 托管（auto-pilot）恢复：进入托管后每隔 N 手允许重试一次真实 LLM 决策，
 * 成功即移出托管。避免一次临时故障（限流窗口/网络抖动/模型偶发异常）把 AI
 * 锁死在兜底状态直到终局；若故障是永久性的（如模型配置失效），每 N 手一次
 * 重试的代价可忽略。
 */
export const AUTO_PILOT_RETRY_INTERVAL_PLIES = 10;

/** LLM 解析/校验失败后的严格重试次数（决策 4：重试 1 次）。 */
export const LLM_STRICT_RETRY = 1;

/** 名次加成（决策 1；4~6 名用于多人模式）。 */
export const RANK_BONUS = Object.freeze({ 1: 300, 2: 150, 3: 50, 4: 25, 5: 10, 6: 0 });

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

/**
 * 无进展停滞判定（安全网）：连续 N 手没有任何棋子进入任何目标营地
 *（全场入营总数创新高）→ 以 `stall` 强制终局，名次按当前入营数结算。
 * 原有的 deadlock 只覆盖"所有未完成座位都无任何合法走法"，而被困一方
 * 仍可来回挪子时不会触发，会一路拖到 MAX_GAME_PLIES(2000)。
 *
 * 取值依据（实测，**勿凭直觉调小**）：开局阶段棋子需穿越整个棋盘，"无人入营"
 * 是常态而非停滞。实测首次入营所需手数：2 人 16 / 3 人 24~53 / 4 人 32 /
 * 6 人 44~71（区间上界为含 30% 随机走法的次优对局，用于近似 LLM 实际表现）。
 * 阈值一旦低于该区间，正常对局会被误杀为 stall —— 6 人局曾因阈值 40 而
 * **100% 在第 40 手被强制终局且 0 子入营**。
 * 120 ≈ 实测上界(71)的 1.7 倍，仍远低于 MAX_GAME_PLIES(2000) 兜底。
 */
export const STALL_WITHOUT_PROGRESS_PLIES = 120;

/** 连跳链搜索保护上限（防止病态局面下组合爆炸）。 */
export const MAX_JUMP_CHAINS = 4000;
export const MAX_JUMP_DEPTH = 24;

/**
 * 单次 getLegalMoves 调用的**扩张预算**（每次调用独立计数）。
 * dfs 按「路径」而非「落点」递归，病态局面下简单路径数呈指数增长：实测单子
 * 仅 18 条走法却耗时 3466ms（爬山法构造）。该函数是同步的，会冻结整个事件循环
 *（SSE 心跳、REST、其它房间对局全部停摆），且无超时可中断。
 * 预算耗尽即停止展开，返回已收集到的走法——结果可能不完整，但保证**有界**，
 * 以极小概率的走法缺失换取服务不被冻结。
 * 正常对局单子扩张量远低于此（实测耗时 0.02~0.03ms），不会触及预算。
 */
export const MAX_JUMP_EXPANSIONS = 20000;

/** AI 连续走子之间的节奏间隔（毫秒），让前端有观感、也避免打爆上游。 */
export const AI_MOVE_PACING_MS = 250;

/**
 * 模型提供方协议（模型配置 provider 字段）。
 *  - openai：OpenAI 兼容协议（缺省，兼容全部旧配置）
 *  - anthropic：Anthropic Messages API
 *  - gemini：Google Gemini API
 */
export const LLM_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini']);

/** 各协议建议的 baseUrl（前端表单提示用，服务端不强制）。 */
export const PROVIDER_BASE_URL_HINTS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
});

/**
 * 自定义策略模板（AI 玩家 promptStyle）最大字符数。
 * 路由校验（aiPlayers）与 prompt 注入截断（promptBuilder）必须共用此值，
 * 避免"保存时允许、使用时被静默截断"的两处上限不一致。
 */
export const PROMPT_STYLE_MAX = 2000;

/** 速率限制：时间窗口（毫秒）。 */
export const RATE_LIMIT_WINDOW_MS = 60000;

/** 速率限制：每个 IP 在时间窗口内的最大请求数。 */
export const RATE_LIMIT_MAX_REQUESTS = 120;
