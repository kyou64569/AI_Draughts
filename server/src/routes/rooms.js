/**
 * 房间路由 `/api/rooms`（P0-6、P1-1、P1-2）：
 * 建房 → 座位指派 → 满员开赛 → SSE 推送 → 人类走子。
 */
import express from 'express';

import {
  GAME_STATUS_PLAYING,
  ROOM_MODE_HUMAN,
  ROOM_MODE_WATCH,
  ROOM_STATUS_FINISHED,
  ROOM_STATUS_PLAYING,
  ROOM_STATUS_SETUP,
  SEAT_COLORS,
  SEAT_COUNT,
  SEAT_TYPE_AI,
  SEAT_TYPE_HUMAN,
  SSE_EVENTS,
} from '../constants.js';
import { createGameState, toPublicGameState } from '../engine/game.js';
import { findMoveByEndpoints, getLegalMoves, ownPieces } from '../engine/rules.js';
import { isValidKey } from '../engine/board.js';
import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
  requireString,
  sendOk,
  unprocessable,
} from '../http.js';
import sse from '../realtime/sseManager.js';
import { commitMove, kickGame } from '../scheduler.js';
import store from '../store.js';

const router = express.Router();

/**
 * 取房间，不存在则 404。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function mustGetRoom(id) {
  const room = await store.findById('rooms', id);
  if (!room) throw notFound(`房间不存在: ${id}`);
  return room;
}

/**
 * 给房间座位补充 AI 玩家展示信息（不含密钥）。
 * @param {object} room
 * @param {object[]} aiPlayers
 * @returns {object}
 */
function decorateRoom(room, aiPlayers) {
  return {
    ...room,
    seats: room.seats.map((seat) => {
      const ai = seat.aiPlayerId ? aiPlayers.find((p) => p.id === seat.aiPlayerId) ?? null : null;
      return {
        index: seat.index,
        type: seat.type,
        aiPlayerId: seat.aiPlayerId ?? null,
        aiPlayerName: ai?.name ?? null,
        model: ai?.model ?? null,
      };
    }),
    isFull: isFull(room),
  };
}

/**
 * 满员判定（决策 2：严格满员，不允许强开）。
 * @param {object} room
 * @returns {boolean}
 */
function isFull(room) {
  return room.seats.every((seat) => seat.type !== SEAT_TYPE_AI || Boolean(seat.aiPlayerId));
}

/**
 * 广播房间变更。
 * @param {object} room
 * @param {object[]} aiPlayers
 * @returns {void}
 */
function broadcastRoom(room, aiPlayers) {
  sse.broadcast(room.id, SSE_EVENTS.ROOM, decorateRoom(room, aiPlayers));
}

/** GET /api/rooms — 房间列表（不含 board）。 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rooms, aiPlayers] = await Promise.all([
      store.loadCollection('rooms'),
      store.loadCollection('aiPlayers'),
    ]);
    sendOk(res, rooms.map((room) => decorateRoom(room, aiPlayers)));
  }),
);

/** POST /api/rooms — 创建房间（human：seat0 人类 + 1/2 AI；watch：3 AI）。 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const mode = requireString(req.body?.mode, 'mode');
    if (mode !== ROOM_MODE_HUMAN && mode !== ROOM_MODE_WATCH) {
      throw badRequest(`mode 只能是 ${ROOM_MODE_HUMAN} 或 ${ROOM_MODE_WATCH}`);
    }
    const createdBy =
      typeof req.body?.createdBy === 'string' && req.body.createdBy.trim() !== ''
        ? req.body.createdBy.trim()
        : '匿名用户';

    // 人机对战：可选人类座位（默认 0=红方），支持玩家选择座位/颜色。
    let humanSeat = 0;
    if (
      mode === ROOM_MODE_HUMAN &&
      req.body?.humanSeat !== undefined &&
      req.body.humanSeat !== null &&
      req.body.humanSeat !== ''
    ) {
      humanSeat = Number(req.body.humanSeat);
      if (!Number.isInteger(humanSeat) || humanSeat < 0 || humanSeat >= SEAT_COUNT) {
        throw badRequest(`humanSeat 必须是 0..${SEAT_COUNT - 1}`);
      }
    }

    const seats = [];
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const type = mode === ROOM_MODE_HUMAN && i === humanSeat ? SEAT_TYPE_HUMAN : SEAT_TYPE_AI;
      seats.push({ index: i, type, aiPlayerId: null });
    }
    const now = store.nowIso();
    const room = {
      id: store.newId(),
      mode,
      seats,
      status: ROOM_STATUS_SETUP,
      createdBy,
      gameId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await store.insertItem('rooms', room);
    const aiPlayers = await store.loadCollection('aiPlayers');
    sendOk(res, decorateRoom(room, aiPlayers));
  }),
);

/** GET /api/rooms/:id — 房间详情（已开局则附带 GameState）。 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    const aiPlayers = await store.loadCollection('aiPlayers');
    const game = room.gameId ? store.getGame(room.gameId) : null;
    sendOk(res, { ...decorateRoom(room, aiPlayers), game: game ? toPublicGameState(game) : null });
  }),
);

/** PUT /api/rooms/:id/seats — 指派/清空某 AI 座位。 */
router.put(
  '/:id/seats',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    if (room.status !== ROOM_STATUS_SETUP) {
      throw conflict('对局已开始或已结束，无法调整座位');
    }
    const seatIndex = Number(req.body?.seatIndex);
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEAT_COUNT) {
      throw badRequest(`seatIndex 必须是 0..${SEAT_COUNT - 1}`);
    }
    const seat = room.seats[seatIndex];
    if (seat.type !== SEAT_TYPE_AI) throw conflict('该座位为人类座位，不能指派 AI 玩家');

    const raw = req.body?.aiPlayerId;
    /** @type {string|null} */
    let aiPlayerId = null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      aiPlayerId = String(raw).trim();
      const ai = await store.findById('aiPlayers', aiPlayerId);
      if (!ai) throw notFound(`AI 玩家不存在: ${aiPlayerId}`);
    }

    const seats = room.seats.map((s) =>
      s.index === seatIndex ? { ...s, aiPlayerId } : { ...s },
    );
    const updated = await store.updateItem('rooms', room.id, {
      seats,
      updatedAt: store.nowIso(),
    });
    const aiPlayers = await store.loadCollection('aiPlayers');
    broadcastRoom(updated, aiPlayers);
    sendOk(res, decorateRoom(updated, aiPlayers));
  }),
);

/** POST /api/rooms/:id/start — 满员开赛（未满员 409）。 */
router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    if (room.status === ROOM_STATUS_PLAYING) throw conflict('对局已在进行中');
    if (room.status === ROOM_STATUS_FINISHED) throw conflict('对局已结束，请新建房间');
    if (!isFull(room)) {
      const empty = room.seats.filter((s) => s.type === SEAT_TYPE_AI && !s.aiPlayerId);
      throw conflict(
        `座位未满员（还有 ${empty.length} 个 AI 座位未指派：${empty
          .map((s) => `#${s.index}`)
          .join('、')}），不允许开赛`,
      );
    }

    const aiPlayers = await store.loadCollection('aiPlayers');
    const seatMeta = [];
    for (const seat of room.seats) {
      if (seat.type === SEAT_TYPE_HUMAN) {
        seatMeta.push({
          type: SEAT_TYPE_HUMAN,
          aiPlayerId: null,
          name: room.createdBy || '人类玩家',
          model: null,
          modelConfigId: null,
        });
        continue;
      }
      const ai = aiPlayers.find((p) => p.id === seat.aiPlayerId);
      if (!ai) throw conflict(`座位 #${seat.index} 绑定的 AI 玩家已不存在，请重新指派`);
      seatMeta.push({
        type: SEAT_TYPE_AI,
        aiPlayerId: ai.id,
        name: ai.name,
        model: ai.model,
        modelConfigId: ai.modelConfigId,
        thinkingLevel: ai.thinkingLevel ?? 'default',
      });
    }

    // 先创建对局对象（纯内存、拿 id 与 startedAt），但暂不入 activeGames：
    // 必须等"检查前置条件 + 翻转状态"原子成功后才发布，避免并发 /start（如双击按钮）
    // 各自创建对局、最后一个 updateItem 覆盖 gameId 后留下孤儿对局与冲突广播。
    const state = createGameState({ roomId: room.id, seats: seatMeta });
    const result = await store.updateItemIf(
      'rooms',
      room.id,
      (r) => r.status === ROOM_STATUS_SETUP && isFull(r),
      {
        status: ROOM_STATUS_PLAYING,
        gameId: state.id,
        startedAt: state.startedAt,
        updatedAt: store.nowIso(),
      },
    );
    if (!result.item) throw notFound(`房间不存在: ${req.params.id}`);
    if (!result.updated) {
      const cur = result.item;
      if (cur.status === ROOM_STATUS_PLAYING) throw conflict('对局已在进行中');
      if (cur.status === ROOM_STATUS_FINISHED) throw conflict('对局已结束，请新建房间');
      throw conflict('座位未满员或状态已变更，不允许开赛');
    }

    // 原子翻转成功 → 安全发布活跃对局
    store.putGame(state);
    const updated = result.item;

    broadcastRoom(updated, aiPlayers);
    sse.broadcast(room.id, SSE_EVENTS.STATE, toPublicGameState(state));

    // 异步启动 AI 回合调度：不阻塞 HTTP 响应（AI 决策可能耗时数十秒）。
    void kickGame(state.id);

    sendOk(res, toPublicGameState(state));
  }),
);

/** GET /api/rooms/:id/stream — SSE 事件流（连接即推当前 room/state 快照）。 */
router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    const aiPlayers = await store.loadCollection('aiPlayers');
    sse.addClient(room.id, req, res);
    // 立即补发快照，便于中途接入/重连自愈
    res.write(
      `event: ${SSE_EVENTS.ROOM}\ndata: ${JSON.stringify(decorateRoom(room, aiPlayers))}\n\n`,
    );
    const game = room.gameId ? store.getGame(room.gameId) : null;
    if (game) {
      res.write(
        `event: ${SSE_EVENTS.STATE}\ndata: ${JSON.stringify(toPublicGameState(game))}\n\n`,
      );
      for (const log of game.logs.slice(-20)) {
        res.write(`event: ${SSE_EVENTS.LOG}\ndata: ${JSON.stringify(log)}\n\n`);
      }
    } else if (room.status === ROOM_STATUS_FINISHED) {
      // 服务重启后内存对局已清空：从归档恢复"结束摘要"，让牌桌显示结果而非"尚未开始"。
      const archived = await store.findArchivedGame(room.gameId, room.id);
      res.write(
        `event: ${SSE_EVENTS.STATE}\ndata: ${JSON.stringify(
          archived
            ? {
                id: archived.id,
                roomId: archived.roomId ?? room.id,
                status: ROOM_STATUS_FINISHED,
                startedAt: archived.startedAt,
                finishedAt: archived.finishedAt,
                endReason: archived.endReason,
                moveCount: archived.moveCount,
                players: (archived.players ?? []).map((p) => ({ ...p })),
                scores: archived.scores ?? [],
                board: {},
                history: [],
                logs: [],
                autoPilotSeats: archived.autoPilotSeats ?? [],
                archived: true,
              }
            : {
                // 归档也丢失（历史缺陷）：至少给出明确提示，避免误读为"尚未开始"
                id: room.gameId ?? room.id,
                roomId: room.id,
                status: ROOM_STATUS_FINISHED,
                startedAt: null,
                finishedAt: room.finishedAt,
                endReason: null,
                moveCount: 0,
                players: (room.seats ?? []).map((s, i) => ({
                  seat: i,
                  color: SEAT_COLORS[i] ?? null,
                  kind: s.type === SEAT_TYPE_HUMAN ? 'human' : 'ai',
                  name: null,
                  model: null,
                  finishRank: null,
                })),
                scores: [],
                board: {},
                history: [],
                logs: [],
                autoPilotSeats: [],
                archived: false,
              },
        )}\n\n`,
      );
    }
  }),
);

/** GET /api/rooms/:id/legal-moves — 当前 human 座位的所有合法走法端点列表（前端高亮落点用）。 */
router.get(
  '/:id/legal-moves',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    /** @type {{from:string, to:string}[]} */
    const moves = [];
    if (room.status === ROOM_STATUS_PLAYING && room.gameId) {
      const state = store.getGame(room.gameId);
      if (state && state.status === GAME_STATUS_PLAYING) {
        const seat = state.turnSeat;
        const player = state.players[seat];
        // 仅当当前回合是 human 座位时下发合法走法；AI 回合/未开局/已结束均返回 []
        if (player && player.kind === SEAT_TYPE_HUMAN) {
          const color = player.color;
          for (const fromKey of ownPieces(state.board, color)) {
            for (const path of getLegalMoves(state.board, fromKey)) {
              moves.push({ from: path[0], to: path[path.length - 1] });
            }
          }
        }
      }
    }
    sendOk(res, moves);
  }),
);

/** POST /api/rooms/:id/move — 人类走子（非法走法 422）。 */
router.post(
  '/:id/move',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    if (room.status !== ROOM_STATUS_PLAYING || !room.gameId) throw conflict('对局尚未开始');
    const state = store.getGame(room.gameId);
    if (!state) throw notFound('对局状态不存在（服务可能已重启）');
    if (state.status !== GAME_STATUS_PLAYING) throw conflict('对局已结束');

    const from = requireString(req.body?.from, 'from');
    const to = requireString(req.body?.to, 'to');
    if (!isValidKey(from) || !isValidKey(to)) {
      throw badRequest('from/to 必须是棋盘上的合法坐标，格式 "q,r,s"');
    }

    const seat = state.turnSeat;
    const player = state.players[seat];
    if (player.kind !== SEAT_TYPE_HUMAN) {
      throw conflict(`当前是 AI 座位 #${seat} 的回合，请等待 AI 走子`);
    }
    if (state.board[from] !== player.color) {
      throw unprocessable(`${from} 不是你的棋子（你的颜色是 ${player.color}）`);
    }
    const path = findMoveByEndpoints(state.board, from, to);
    if (!path) throw unprocessable(`${from} -> ${to} 不是合法走法（单步需相邻空格；连跳需跳到底）`);

    // 防并发：记录当前回合的 history 长度作为版本号
    const turnVersion = state.history.length;

    await commitMove(state, seat, path, {
      isFallback: false,
      log: {
        seat,
        model: null,
        thinking: '',
        reason: `人类玩家走子 ${from} -> ${to}${path.length >= 3 ? `（连跳x${path.length - 1}）` : '（单步）'}`,
        isFallback: false,
      },
    });

    // 验证回合版本，防止重复提交
    if (state.history.length !== turnVersion + 1) {
      throw conflict('对局状态已变更，请刷新棋盘后重试');
    }

    // 继续推进后续 AI 座位
    void kickGame(state.id);

    sendOk(res, toPublicGameState(state));
  }),
);

/** DELETE /api/rooms/:id — 删除房间（含进行中的对局：中断对局、断开 SSE、移除房间）。 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const room = await mustGetRoom(req.params.id);
    // 进行中的对局：直接中断（dropGame 后调度循环会在下一轮因取不到 state 自然退出）。
    if (room.gameId) store.dropGame(room.gameId);
    sse.closeRoom(room.id);
    await store.removeItem('rooms', room.id);
    sendOk(res, null);
  }),
);

export default router;
