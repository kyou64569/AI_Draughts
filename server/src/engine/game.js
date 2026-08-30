/**
 * 对局状态管理：初始布局、座位→颜色分配、回合流转、胜负与积分结算。
 * 纯内存操作（无 I/O），由 routes/scheduler 调用。
 */
import { randomUUID } from 'node:crypto';

import {
  ALL_COLORS,
  BASE_SCORE_PER_PIECE,
  COLOR_HOME,
  COLOR_TARGET,
  GAME_STATUS_FINISHED,
  GAME_STATUS_PLAYING,
  MAX_GAME_PLIES,
  MODE_SEAT_COLORS,
  PIECES_PER_COLOR,
  PLAYER_COUNTS,
  RANK_BONUS,
  SEAT_COLORS,
  SEAT_TYPE_AI,
  SEAT_TYPE_HUMAN,
  TIME_PENALTY_PER_UNIT,
  TIME_PENALTY_UNIT_SEC,
  AUTO_PILOT_FAIL_THRESHOLD,
  AUTO_PILOT_RETRY_INTERVAL_PLIES,
  STALL_WITHOUT_PROGRESS_PLIES,
} from '../constants.js';
import { HOME_CELLS, TARGET_CELLS, createEmptyBoard } from './board.js';
import { countInTarget, seatHasAnyLegalMove } from './rules.js';

/**
 * 对外下发时保留的最近日志条数。
 *
 * DecisionLog 前端只消费 SSE 增量推送的 log 事件（useRoomStream 维护的 logs 数组），
 * 从不读取 public state 里的 game.logs；但 /stream 重连补发、REST 快照仍可能携带，
 * 故保留一个有界窗口（与 /stream 重发窗口一致）即可，避免每次广播都深拷贝并序列化
 * 整段历史日志（随对局增长 O(n)/广播、O(n²)/整局，最多 ~MAX_GAME_PLIES 条）。
 */
const PUBLIC_LOG_WINDOW = 20;

/**
 * 生成初始棋盘：活跃颜色各 10 子填满各自 home 角，其余格为 null。
 * @param {string[]} colors 本局活跃颜色（2/3/4/6 人局分别 2/3/4/6 色）
 * @returns {Record<string, string|null>} 全 121 键棋盘
 */
export function createInitialBoard(colors = SEAT_COLORS) {
  const board = createEmptyBoard();
  for (const color of colors) {
    for (const cell of HOME_CELLS[color]) board[cell] = color;
  }
  return board;
}

/**
 * @typedef {object} SeatMeta
 * @property {'human'|'ai'} type 座位类型
 * @property {string|null} [aiPlayerId] AI 玩家 id（human 座位为 null）
 * @property {string|null} [name] 展示名（AI 玩家名 / 人类昵称）
 * @property {string|null} [model] 绑定模型名
 * @property {string|null} [modelConfigId] 绑定模型配置 id
 */

/**
 * 创建 GameState。座位→颜色：优先 seat.color，缺省按 MODE_SEAT_COLORS[seatCount]
 * （2/3/4/6 人局；3 人局即红绿蓝，与旧数据完全兼容）。
 * @param {{roomId: string, seats: SeatMeta[]}} opts
 * @returns {object} GameState
 */
export function createGameState({ roomId, seats }) {
  if (!Array.isArray(seats) || !PLAYER_COUNTS.includes(seats.length)) {
    throw new Error(`createGameState: 座位数必须是 ${PLAYER_COUNTS.join(' | ')} 人`);
  }
  const seatCount = seats.length;
  const seatColors = MODE_SEAT_COLORS[seatCount];
  // 颜色必须逐个校验后再使用：
  //  - 非法色 → COLOR_HOME/TARGET_CELLS[color] 为 undefined，进而在下方
  //    [...TARGET_CELLS[color]] 处抛 TypeError，表现为 500 且无有效信息；
  //  - 颜色重复 → 两个座位共控同 10 子，countInTarget / 胜负判定完全串台。
  // 两者都必须在建局时 fail-fast，绝不能让脏状态流进对局。
  const colors = seats.map((seat, index) => {
    const color = seat.color ?? seatColors[index];
    if (!ALL_COLORS.includes(color)) {
      throw new Error(`createGameState: 座位 #${index} 的颜色非法: ${String(seat.color)}`);
    }
    return color;
  });
  if (new Set(colors).size !== colors.length) {
    throw new Error(`createGameState: 座位颜色重复: ${colors.join(', ')}`);
  }
  const startedAtMs = Date.now();
  const players = seats.map((seat, index) => {
    const color = colors[index];
    return {
      seat: index,
      color,
      kind: seat.type === SEAT_TYPE_HUMAN ? SEAT_TYPE_HUMAN : SEAT_TYPE_AI,
      aiPlayerId: seat.aiPlayerId ?? null,
      name: seat.name ?? (seat.type === SEAT_TYPE_HUMAN ? '人类玩家' : 'AI'),
      model: seat.model ?? null,
      modelConfigId: seat.modelConfigId ?? null,
      thinkingLevel: seat.thinkingLevel ?? 'default',
      home: COLOR_HOME[color],
      target: COLOR_TARGET[color],
      targetCells: [...TARGET_CELLS[color]],
      inTarget: 0,
      finishRank: null,
      finishTime: null,
    };
  });

  /** @type {object} */
  const state = {
    id: randomUUID(),
    roomId,
    seatCount,
    board: createInitialBoard(players.map((p) => p.color)),
    turnSeat: 0,
    players,
    history: [],
    logs: [],
    scores: [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    finishedAt: null,
    autoPilotSeats: [],
    // 无进展停滞检测（evaluateProgress 维护）：最近一次"入营总数创新高"的手数与水位
    lastProgressPly: 0,
    lastProgressTotal: 0,
    failCounts: Object.fromEntries(players.map((p) => [p.seat, 0])),
    status: GAME_STATUS_PLAYING,
  };
  refreshProgress(state);
  return state;
}

/**
 * 当前回合玩家。
 * @param {object} state
 * @returns {object} Player
 */
export function currentPlayer(state) {
  return state.players[state.turnSeat];
}

/**
 * 回合流转：0→1→…→n-1→0，跳过已完成（finishTime != null）的玩家。
 * @param {object} state
 * @returns {number} 新的 turnSeat
 */
export function advanceTurn(state) {
  const n = state.players.length;
  for (let i = 1; i <= n; i += 1) {
    const cand = (state.turnSeat + i) % n;
    if (state.players[cand].finishTime == null) {
      state.turnSeat = cand;
      return cand;
    }
  }
  return state.turnSeat; // 全部完成（终局由 evaluateProgress 处理）
}

/**
 * 刷新每个玩家 target 内子数（供前端展示与结算）。
 * @param {object} state
 * @returns {void}
 */
export function refreshProgress(state) {
  for (const p of state.players) {
    p.inTarget = countInTarget(state.board, p.color);
  }
}

/**
 * 记录一手走法到 history。
 * @param {object} state
 * @param {number} seat
 * @param {string[]} path
 * @param {boolean} [isFallback=false]
 * @returns {object} GameMove
 */
export function recordMove(state, seat, path, isFallback = false) {
  /** @type {object} */
  const move = {
    seat,
    from: path[0],
    to: path[path.length - 1],
    path: [...path],
    isFallback: Boolean(isFallback),
    ts: new Date().toISOString(),
  };
  state.history.push(move);
  return move;
}

/**
 * 追加一条决策日志（AI 思考/理由，或系统提示）。
 * @param {object} state
 * @param {object} entry LogEntry（缺省字段会被补齐；latencyMs/usage/failures 为可选结构化统计字段）
 * @returns {object} 落库后的 LogEntry
 */
export function pushLog(state, entry) {
  const seat = entry.seat;
  const player =
    seat != null && seat >= 0 && seat < state.players.length ? state.players[seat] : null;
  /** @type {object} */
  const log = {
    seat: entry.seat ?? null,
    color: entry.color ?? (player?.color ?? null),
    model: entry.model ?? null,
    thinking: entry.thinking ?? '',
    reason: entry.reason ?? '',
    from: entry.from ?? null,
    to: entry.to ?? null,
    isFallback: Boolean(entry.isFallback),
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  // 结构化决策统计字段（可选）：决策延迟 / token 用量 / LLM 失败次数
  if (entry.latencyMs != null) log.latencyMs = entry.latencyMs;
  if (entry.usage != null) log.usage = entry.usage;
  if (entry.failures != null) log.failures = entry.failures;
  state.logs.push(log);
  return log;
}

/**
 * 判断某座位是否处于 auto-pilot（托管）。
 * @param {object} state
 * @param {number} seat
 * @returns {boolean}
 */
export function isAutoPilot(state, seat) {
  return (state.autoPilotSeats ?? []).includes(String(seat));
}

/**
 * 将座位标记为 auto-pilot（默认不再调用 LLM；托管恢复见 shouldRetryAutoPilot）。
 * 同时记录进入托管时的手数，作为"每 N 手重试一次"计时的起点。
 * @param {object} state
 * @param {number} seat
 * @returns {void}
 */
export function markAutoPilot(state, seat) {
  if (!Array.isArray(state.autoPilotSeats)) state.autoPilotSeats = [];
  if (!state.autoPilotSeats.includes(String(seat))) state.autoPilotSeats.push(String(seat));
  if (state.autoPilotRetryPly == null || typeof state.autoPilotRetryPly !== 'object') {
    state.autoPilotRetryPly = {};
  }
  state.autoPilotRetryPly[seat] = state.history.length;
}

/**
 * 将座位移出 auto-pilot（托管恢复成功时调用；未在托管中则为空操作）。
 * @param {object} state
 * @param {number} seat
 * @returns {void}
 */
export function unmarkAutoPilot(state, seat) {
  if (!Array.isArray(state.autoPilotSeats)) return;
  const idx = state.autoPilotSeats.indexOf(String(seat));
  if (idx >= 0) state.autoPilotSeats.splice(idx, 1);
  resetFailure(state, seat);
}

/**
 * 托管座位本手是否允许重试真实 LLM：距上次重试/进入托管已满 N 手。
 * @param {object} state
 * @param {number} seat
 * @returns {boolean}
 */
export function shouldRetryAutoPilot(state, seat) {
  const last = state.autoPilotRetryPly?.[seat];
  return last == null || state.history.length - last >= AUTO_PILOT_RETRY_INTERVAL_PLIES;
}

/**
 * 记录一次托管重试（无论成败，重置 N 手计时；防止重试失败后每手都打 LLM）。
 * @param {object} state
 * @param {number} seat
 * @returns {void}
 */
export function markAutoPilotRetry(state, seat) {
  if (state.autoPilotRetryPly == null || typeof state.autoPilotRetryPly !== 'object') {
    state.autoPilotRetryPly = {};
  }
  state.autoPilotRetryPly[seat] = state.history.length;
}

/**
 * 记录一次 LLM 失败；连续达到阈值则进入 auto-pilot。
 * @param {object} state
 * @param {number} seat
 * @returns {{count:number, autoPilot:boolean}}
 */
export function registerFailure(state, seat) {
  if (state.failCounts == null) state.failCounts = {};
  const count = (state.failCounts[seat] ?? 0) + 1;
  state.failCounts[seat] = count;
  let autoPilot = false;
  if (count >= AUTO_PILOT_FAIL_THRESHOLD) {
    markAutoPilot(state, seat);
    autoPilot = true;
  }
  return { count, autoPilot };
}

/**
 * 重置某座位的连续失败计数。
 * @param {object} state
 * @param {number} seat
 * @returns {void}
 */
export function resetFailure(state, seat) {
  if (state.failCounts == null) state.failCounts = {};
  state.failCounts[seat] = 0;
}

/**
 * 评估进度：判定新完成的玩家、必要时触发终局结算。
 *
 * 与 architecture.md §5.4 的差异（已修正其示例代码缺陷）：名次基于**历史已完成人数**
 * 累加，而不是仅按本次调用内新完成的数量，避免多次调用后名次重复。
 *
 * @param {object} state
 * @returns {{finished:boolean, newlyFinished:number[], ranks:number[]}}
 */
export function evaluateProgress(state) {
  refreshProgress(state);

  /** @type {number[]} */
  const newlyFinished = [];
  /** @type {Array<{p:object, inTarget:number}>} */
  const unfinished = [];

  let finishedCount = state.players.filter((p) => p.finishTime != null).length;

  for (const p of state.players) {
    if (p.finishTime == null && p.inTarget === PIECES_PER_COLOR) {
      p.finishTime = new Date().toISOString();
      finishedCount += 1;
      p.finishRank = finishedCount;
      newlyFinished.push(p.seat);
    } else if (p.finishTime == null) {
      unfinished.push({ p, inTarget: p.inTarget });
    }
  }

  const ranks = state.players
    .filter((p) => p.finishTime != null)
    .sort((a, b) => (a.finishRank ?? 0) - (b.finishRank ?? 0))
    .map((p) => p.seat);

  // 无进展停滞（安全网）：全场入营总数创新高才算"进展"。连续
  // STALL_WITHOUT_PROGRESS_PLIES 手无进展 → 强制终局。覆盖 deadlock
  // 管不到的场景：被困一方仍能来回挪子（有合法走法），僵局会拖到手数上限。
  const totalInTarget = state.players.reduce((s, p) => s + p.inTarget, 0);
  // 进展 = 入场总数**增加**。只允许回落：让位（unblock）会主动把已入营的棋子
  // 挪出营地为被困对手让路，但回落不应重置停滞计时器，否则可被滥用（反复挪出
  // 挪入来重置计时器）。只有创新高才算进展。
  if (totalInTarget > (state.lastProgressTotal ?? -1)) {
    state.lastProgressTotal = totalInTarget;
    state.lastProgressPly = state.history.length;
  }
  const stall =
    unfinished.length > 0 &&
    state.history.length - (state.lastProgressPly ?? 0) >= STALL_WITHOUT_PROGRESS_PLIES;

  // 终局条件：全部完成 / 剩余未完成者均无合法走法（死锁）/ 无进展停滞 / 达到手数上限
  const deadlock =
    unfinished.length > 0 && unfinished.every((u) => !seatHasAnyLegalMove(state, u.p.seat));
  const plyLimitReached = state.history.length >= MAX_GAME_PLIES;

  if (
    state.status === GAME_STATUS_PLAYING &&
    (unfinished.length === 0 || deadlock || stall || plyLimitReached)
  ) {
    endGame(state, ranks, unfinished);
    state.endReason =
      unfinished.length === 0
        ? 'all_finished'
        : deadlock
          ? 'deadlock'
          : stall
            ? 'stall'
            : 'ply_limit';
    return { finished: true, newlyFinished, ranks };
  }
  return { finished: false, newlyFinished, ranks };
}

/**
 * 终局结算（决策 1）：
 *  base = target 内子数 × 100；rank 加成 1/2/3 = 300/150/50；
 *  penalty = ⌊总对局秒 / 30⌋ × 5；score = max(0, base + rankBonus − penalty)。
 * @param {object} state
 * @param {number[]} ranks 已按完成顺序排列的 seat 列表
 * @param {Array<{p:object, inTarget:number}>} unfinished 未完成玩家（按 target 内子数降序补名次）
 * @returns {object[]} ScoreEntry[]
 */
export function endGame(state, ranks, unfinished) {
  const rest = [...unfinished].sort((a, b) => {
    if (b.inTarget !== a.inTarget) return b.inTarget - a.inTarget;
    return a.p.seat - b.p.seat;
  });
  let rankNo = ranks.length + 1;
  for (const u of rest) {
    u.p.finishRank = rankNo;
    rankNo += 1;
  }

  const finishedAtMs = Date.now();
  const totalSec = Math.floor((finishedAtMs - state.startedAtMs) / 1000);
  const timePenalty = Math.floor(totalSec / TIME_PENALTY_UNIT_SEC) * TIME_PENALTY_PER_UNIT;

  state.scores = [];
  for (const p of state.players) {
    const inTarget = countInTarget(state.board, p.color);
    const base = inTarget * BASE_SCORE_PER_PIECE;
    const rank = p.finishRank ?? state.players.length;
    const rankBonus = RANK_BONUS[rank] ?? 0;
    const score = Math.max(0, base + rankBonus - timePenalty);
    state.scores.push({
      seat: p.seat,
      color: p.color,
      name: p.name ?? null,
      base,
      rank,
      rankBonus,
      timePenalty,
      score,
    });
  }
  state.scores.sort((a, b) => a.rank - b.rank);
  state.status = GAME_STATUS_FINISHED;
  state.finishedAt = new Date(finishedAtMs).toISOString();
  state.totalSeconds = totalSec;
  return state.scores;
}

/**
 * 生成对外下发的 GameState（SSE `state` 事件 / REST 响应统一使用）。
 * 剔除内部字段 failCounts / autoPilotRetryPly / lastProgress*；board 为全 121 键。
 * @param {object} state
 * @returns {object}
 */
export function toPublicGameState(state) {
  if (state == null) return null;
  const { failCounts, autoPilotRetryPly, lastProgressPly, lastProgressTotal, ...rest } = state;
  return {
    ...rest,
    board: { ...state.board },
    // targetCells 必须连同 player 一起拷贝：仅 {...p} 时该数组仍与内部状态共享引用，
    // 消费方改动会直接污染活局。
    players: state.players.map((p) => ({ ...p, targetCells: [...p.targetCells] })),
    // 决策文本（reason/thinking 等）只随 log 事件推送；state 广播保留轻量走法记录，
    // 避免 payload 随对局手数线性膨胀（前端 lastMove 高亮只需 from/to/path）。
    history: state.history.map(({ reason, thinking, ...m }) => ({ ...m })),
    logs: state.logs.slice(-PUBLIC_LOG_WINDOW).map((l) => ({ ...l })),
    scores: state.scores.map((sc) => ({ ...sc })),
    autoPilotSeats: [...(state.autoPilotSeats ?? [])],
  };
}

export default {
  createInitialBoard,
  createGameState,
  currentPlayer,
  advanceTurn,
  refreshProgress,
  recordMove,
  pushLog,
  isAutoPilot,
  markAutoPilot,
  unmarkAutoPilot,
  shouldRetryAutoPilot,
  markAutoPilotRetry,
  registerFailure,
  resetFailure,
  evaluateProgress,
  endGame,
  toPublicGameState,
};
