/**
 * AI 回合调度器：轮到 AI 座位时触发 decideMove → applyMove → evaluateProgress → 广播，
 * 直到轮到人类座位（等待 REST 走子）或终局。
 *
 * 3 个 AI 天然串行（回合制），因此这里用"每局一个异步循环 + 运行中标记"即可，
 * 不需要并发队列（决策 5）。
 */
import {
  AI_MOVE_PACING_MS,
  GAME_STATUS_PLAYING,
  ROOM_STATUS_FINISHED,
  SEAT_TYPE_HUMAN,
  SSE_EVENTS,
} from './constants.js';
import {
  advanceTurn,
  evaluateProgress,
  pushLog,
  recordMove,
  toPublicGameState,
} from './engine/game.js';
import { applyMove, colorHasAnyLegalMove } from './engine/rules.js';
import sse from './realtime/sseManager.js';
import { decideMove } from './services/llmDecision.js';
import store from './store.js';

/** @type {Set<string>} 正在运行调度循环的 gameId，避免重入。 */
const running = new Set();

/** 保留最近 N 局 finished 对局（防止 activeGames 无限增长）。 */
const GAME_RETENTION = 20;

/**
 * 睡眠。
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 广播全量 GameState。
 * @param {object} state
 * @returns {void}
 */
export function broadcastState(state) {
  sse.broadcast(state.roomId, SSE_EVENTS.STATE, toPublicGameState(state));
}

/**
 * 终局收尾：更新房间状态、归档 games.json、广播 finished、清理 SSE 连接。
 * @param {object} state
 * @returns {Promise<void>}
 */
export async function finalizeGame(state) {
  // ELO 结算（建议 3.2）：在归档前计算，变动写入归档记录；失败不阻断终局。
  const { applyEloForGame } = await import('./services/elo.js');
  state.eloChanges = await applyEloForGame(state);
  // 先归档、后改房间状态：归档是唯一对局记录，若归档写失败会抛错（throwOnError），
  // 房间保持 playing → 服务重启后 repairOrphanRooms 会自愈回 setup 可重开；
  // 若先改 finished 再归档失败，会出现"房间已结束但归档丢失"的悬空状态。
  await store.archiveGame(state);
  const room = await store.updateItem('rooms', state.roomId, {
    status: ROOM_STATUS_FINISHED,
    finishedAt: state.finishedAt,
    updatedAt: store.nowIso(),
  });
  broadcastState(state);
  if (room) sse.broadcast(state.roomId, SSE_EVENTS.ROOM, room);
  sse.broadcast(state.roomId, SSE_EVENTS.FINISHED, {
    gameId: state.id,
    scores: state.scores,
    ranks: state.players
      .slice()
      .sort((a, b) => (a.finishRank ?? 99) - (b.finishRank ?? 99))
      .map((p) => ({ seat: p.seat, color: p.color, name: p.name, rank: p.finishRank })),
    finishedAt: state.finishedAt,
    totalSeconds: state.totalSeconds ?? null,
  });

  // 锦标赛推进（建议 2.3）：该对局若属于进行中锦标赛的场次，记录结果并自动开下一场。
  // 动态 import 避免与 roomService/scheduler 的循环依赖；失败不影响终局流程。
  const { notifyGameFinished } = await import('./services/tournament.js');
  await notifyGameFinished(state).catch((err) =>
    console.warn('[tournament] 推进失败（不影响终局）:', err?.message ?? err),
  );

  // 清理 SSE 连接，防止内存泄漏
  sse.closeRoom(state.roomId);

  // 保留最近 GAME_RETENTION 局 finished 对局，超出则 dropGame 最旧的，
  // 防止 activeGames 随对局数无限增长（前端复看由 games.json 归档兜底）。
  const finishedGames = store.listGames().filter((g) => g.status !== GAME_STATUS_PLAYING);
  if (finishedGames.length > GAME_RETENTION) {
    for (const g of finishedGames.slice(0, finishedGames.length - GAME_RETENTION)) {
      store.dropGame(g.id);
    }
  }
}

/**
 * 提交一手已校验过的走法：应用棋盘 → 记 history/log → 评估进度 → 轮转 → 广播。
 * 人类走子与 AI 走子共用此函数，保证行为一致。
 * @param {object} state GameState
 * @param {number} seat 座位号
 * @param {string[]} path 合法走法路径
 * @param {{log?: object, isFallback?: boolean}} [options]
 * @returns {Promise<{finished: boolean}>}
 */
export async function commitMove(state, seat, path, options = {}) {
  const isFallback = Boolean(options.isFallback);
  state.board = applyMove(state.board, path);
  const move = recordMove(state, seat, path, isFallback);
  const logEntry = options.log
    ? pushLog(state, { ...options.log, from: path[0], to: path[path.length - 1] })
    : null;
  // 决策信息落到走法记录上（棋谱回放与质量统计只需 history 即可自洽）
  if (logEntry) {
    move.model = logEntry.model ?? null;
    move.thinking = logEntry.thinking ?? '';
    move.reason = logEntry.reason ?? '';
    if (logEntry.latencyMs != null) move.latencyMs = logEntry.latencyMs;
    if (logEntry.usage != null) move.usage = logEntry.usage;
    if (logEntry.failures != null) move.failures = logEntry.failures;
  }

  const progress = evaluateProgress(state);
  if (!progress.finished) advanceTurn(state);

  broadcastState(state);
  if (logEntry) sse.broadcast(state.roomId, SSE_EVENTS.LOG, logEntry);

  if (progress.finished) {
    await finalizeGame(state);
    return { finished: true };
  }
  return { finished: false };
}

/**
 * 跳过当前座位回合（无合法走法，决策 4④）。
 * @param {object} state
 * @param {number} seat
 * @param {object} log LogEntry
 * @returns {Promise<{finished: boolean}>}
 */
async function skipTurn(state, seat, log) {
  const entry = pushLog(state, log);
  const progress = evaluateProgress(state);
  if (!progress.finished) advanceTurn(state);
  broadcastState(state);
  sse.broadcast(state.roomId, SSE_EVENTS.LOG, entry);
  if (progress.finished) {
    await finalizeGame(state);
    return { finished: true };
  }
  return { finished: false };
}

/**
 * 触发某局的 AI 调度循环（幂等：已在运行则直接返回）。
 * 不会 reject——所有异常都转成日志事件，保证对局不中断（P0-4）。
 * @param {string} gameId
 * @returns {Promise<void>}
 */
export async function kickGame(gameId) {
  if (running.has(gameId)) return;
  running.add(gameId);
  try {
    await runLoop(gameId);
  } finally {
    running.delete(gameId);
  }
}

/**
 * 调度主循环。
 * @param {string} gameId
 * @returns {Promise<void>}
 */
async function runLoop(gameId) {
  // 保护上限：单次循环最多推进 10000 手，避免异常局面下无限占用事件循环。
  for (let guard = 0; guard < 10000; guard += 1) {
    const state = store.getGame(gameId);
    if (!state || state.status !== GAME_STATUS_PLAYING) return;

    const seat = state.turnSeat;
    const player = state.players[seat];

    // 已完成的玩家不再行动
    if (player.finishTime != null) {
      advanceTurn(state);
      broadcastState(state);
      continue;
    }

    const hasMove = colorHasAnyLegalMove(state.board, player.color);

    // 人类座位：有走法则等待 REST /move；无走法则自动跳过
    if (player.kind === SEAT_TYPE_HUMAN) {
      if (hasMove) return;
      const { finished } = await skipTurn(state, seat, {
        seat,
        model: null,
        reason: '该座位当前无合法走法，自动跳过回合',
        isFallback: true,
      });
      if (finished) return;
      continue;
    }

    /** @type {{path: string[]|null, skip?: boolean, log: object}} */
    let decision = null;
    // 流式思考：片段缓冲 250ms 批量推送（thinking 事件），决策结束统一清空；
    // 前端在收到 state/log 事件（走子落定）时自动清空思考文本。
    let thinkBuf = '';
    let thinkTimer = null;
    const flushThinking = () => {
      if (thinkBuf) {
        sse.broadcast(state.roomId, SSE_EVENTS.THINKING, { seat, delta: thinkBuf });
        thinkBuf = '';
      }
      if (thinkTimer) {
        clearTimeout(thinkTimer);
        thinkTimer = null;
      }
    };
    const onThinking = ({ kind, text }) => {
      if (kind !== 'thinking' || !text) return;
      thinkBuf += text;
      if (!thinkTimer) thinkTimer = setTimeout(flushThinking, 250);
    };
    try {
      decision = await decideMove(state, seat, { onThinking });
    } catch (err) {
      decision = {
        path: null,
        skip: true,
        log: {
          seat,
          model: player.model,
          reason: `决策异常，跳过回合：${err instanceof Error ? err.message : String(err)}`,
          isFallback: true,
        },
      };
    } finally {
      flushThinking();
    }

    // 决策期间对局可能已被终止
    const fresh = store.getGame(gameId);
    if (!fresh || fresh.status !== GAME_STATUS_PLAYING || fresh.turnSeat !== seat) continue;

    if (decision.skip || !decision.path) {
      const { finished } = await skipTurn(state, seat, decision.log);
      if (finished) return;
    } else {
      const { finished } = await commitMove(state, seat, decision.path, {
        log: decision.log,
        isFallback: Boolean(decision.log?.isFallback),
      });
      if (finished) return;
    }

    if (AI_MOVE_PACING_MS > 0) await sleep(AI_MOVE_PACING_MS);
  }
}

/**
 * 是否有调度循环在运行（测试与诊断用）。
 * @param {string} gameId
 * @returns {boolean}
 */
export function isRunning(gameId) {
  return running.has(gameId);
}

export default { kickGame, commitMove, finalizeGame, broadcastState, isRunning };
