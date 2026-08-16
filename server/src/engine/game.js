/**
 * 对局状态管理：初始布局、座位→颜色分配、回合流转、胜负与积分结算。
 * 纯内存操作（无 I/O），由 routes/scheduler 调用。
 */
import { randomUUID } from 'node:crypto';

import {
  BASE_SCORE_PER_PIECE,
  COLOR_HOME,
  COLOR_TARGET,
  GAME_STATUS_FINISHED,
  GAME_STATUS_PLAYING,
  MAX_GAME_PLIES,
  PIECES_PER_COLOR,
  RANK_BONUS,
  SEAT_COLORS,
  SEAT_COUNT,
  SEAT_TYPE_AI,
  SEAT_TYPE_HUMAN,
  TIME_PENALTY_PER_UNIT,
  TIME_PENALTY_UNIT_SEC,
  AUTO_PILOT_FAIL_THRESHOLD,
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
 * 生成初始棋盘：三色各 10 子填满各自 home 角，其余 91 格为 null。
 * @returns {Record<string, string|null>} 全 121 键棋盘
 */
export function createInitialBoard() {
  const board = createEmptyBoard();
  for (const color of SEAT_COLORS) {
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
 * 创建 GameState。座位→颜色固定：seat0=red、seat1=green、seat2=blue。
 * @param {{roomId: string, seats: SeatMeta[]}} opts
 * @returns {object} GameState
 */
export function createGameState({ roomId, seats }) {
  if (!Array.isArray(seats) || seats.length !== SEAT_COUNT) {
    throw new Error(`createGameState: 需要 ${SEAT_COUNT} 个座位`);
  }
  const startedAtMs = Date.now();
  const players = seats.map((seat, index) => {
    const color = SEAT_COLORS[index];
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
    board: createInitialBoard(),
    turnSeat: 0,
    players,
    history: [],
    logs: [],
    scores: [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    finishedAt: null,
    autoPilotSeats: [],
    failCounts: { 0: 0, 1: 0, 2: 0 },
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
 * 回合流转：0→1→2→0，跳过已完成（finishTime != null）的玩家。
 * @param {object} state
 * @returns {number} 新的 turnSeat
 */
export function advanceTurn(state) {
  for (let i = 1; i <= SEAT_COUNT; i += 1) {
    const cand = (state.turnSeat + i) % SEAT_COUNT;
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
 * @param {object} entry LogEntry（缺省字段会被补齐）
 * @returns {object} 落库后的 LogEntry
 */
export function pushLog(state, entry) {
  const seat = entry.seat;
  const player = seat != null && seat >= 0 && seat < SEAT_COUNT ? state.players[seat] : null;
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
 * 将座位标记为 auto-pilot（此后不再调用 LLM）。
 * @param {object} state
 * @param {number} seat
 * @returns {void}
 */
export function markAutoPilot(state, seat) {
  if (!Array.isArray(state.autoPilotSeats)) state.autoPilotSeats = [];
  if (!state.autoPilotSeats.includes(String(seat))) state.autoPilotSeats.push(String(seat));
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

  // 终局条件：全部完成 / 剩余未完成者均无合法走法（死锁）/ 达到手数上限
  const deadlock =
    unfinished.length > 0 && unfinished.every((u) => !seatHasAnyLegalMove(state, u.p.seat));
  const plyLimitReached = state.history.length >= MAX_GAME_PLIES;

  if (
    state.status === GAME_STATUS_PLAYING &&
    (unfinished.length === 0 || deadlock || plyLimitReached)
  ) {
    endGame(state, ranks, unfinished);
    state.endReason = unfinished.length === 0 ? 'all_finished' : deadlock ? 'deadlock' : 'ply_limit';
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
    const rank = p.finishRank ?? SEAT_COUNT;
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
 * 剔除内部字段 failCounts；board 为全 121 键。
 * @param {object} state
 * @returns {object}
 */
export function toPublicGameState(state) {
  if (state == null) return null;
  const { failCounts, ...rest } = state;
  return {
    ...rest,
    board: { ...state.board },
    players: state.players.map((p) => ({ ...p })),
    history: state.history.map((m) => ({ ...m })),
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
  registerFailure,
  resetFailure,
  evaluateProgress,
  endGame,
  toPublicGameState,
};
