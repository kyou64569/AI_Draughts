/**
 * 房间服务：建房 / 开赛的共享实现（HTTP 路由与锦标赛调度共用，避免逻辑分叉）。
 * 从 routes/rooms.js 抽取，行为保持一致。
 */
import {
  DEFAULT_PLAYER_COUNT,
  MODE_SEAT_COLORS,
  PLAYER_COUNTS,
  ROOM_MODE_HUMAN,
  ROOM_MODE_WATCH,
  ROOM_STATUS_FINISHED,
  ROOM_STATUS_PLAYING,
  ROOM_STATUS_SETUP,
  SEAT_TYPE_AI,
  SEAT_TYPE_HUMAN,
  SSE_EVENTS,
} from '../constants.js';
import { createGameState, toPublicGameState } from '../engine/game.js';
import { badRequest, conflict, notFound } from '../http.js';
import sse from '../realtime/sseManager.js';
import { kickGame } from '../scheduler.js';
import store from '../store.js';

/**
 * 满员判定（决策 2：严格满员，不允许强开）。
 * @param {object} room
 * @returns {boolean}
 */
export function isFull(room) {
  return room.seats.every((seat) => seat.type !== SEAT_TYPE_AI || Boolean(seat.aiPlayerId));
}

/**
 * 给房间座位补充 AI 玩家展示信息（不含密钥）。
 * @param {object} room
 * @param {object[]} aiPlayers
 * @returns {object}
 */
export function decorateRoom(room, aiPlayers) {
  const seatColors = MODE_SEAT_COLORS[room.playerCount ?? DEFAULT_PLAYER_COUNT] ?? [];
  return {
    ...room,
    seats: room.seats.map((seat) => {
      const ai = seat.aiPlayerId ? aiPlayers.find((p) => p.id === seat.aiPlayerId) ?? null : null;
      return {
        index: seat.index,
        type: seat.type,
        color: seat.color ?? seatColors[seat.index] ?? null,
        aiPlayerId: seat.aiPlayerId ?? null,
        aiPlayerName: ai?.name ?? null,
        model: ai?.model ?? null,
      };
    }),
    isFull: isFull(room),
  };
}

/**
 * 广播房间变更。
 * @param {object} room
 * @param {object[]} aiPlayers
 * @returns {void}
 */
export function broadcastRoom(room, aiPlayers) {
  sse.broadcast(room.id, SSE_EVENTS.ROOM, decorateRoom(room, aiPlayers));
}

/**
 * 创建房间（mode=human：humanSeat 人类 + 其余 AI；mode=watch：全部 AI）。
 * @param {{mode:string, playerCount?:number, humanSeat?:number, createdBy?:string}} opts
 * @returns {Promise<object>} 未装饰的房间文档
 */
export async function createRoom({ mode, playerCount = DEFAULT_PLAYER_COUNT, humanSeat = 0, createdBy = '匿名用户' }) {
  if (mode !== ROOM_MODE_HUMAN && mode !== ROOM_MODE_WATCH) {
    throw badRequest(`mode 只能是 ${ROOM_MODE_HUMAN} 或 ${ROOM_MODE_WATCH}`);
  }
  if (!PLAYER_COUNTS.includes(playerCount)) {
    throw badRequest(`playerCount 只能是 ${PLAYER_COUNTS.join(' | ')} 人`);
  }
  const seatColors = MODE_SEAT_COLORS[playerCount];
  let hs = 0;
  if (mode === ROOM_MODE_HUMAN) {
    hs = Number(humanSeat ?? 0);
    if (!Number.isInteger(hs) || hs < 0 || hs >= playerCount) {
      throw badRequest(`humanSeat 必须是 0..${playerCount - 1}`);
    }
  }
  const seats = [];
  for (let i = 0; i < playerCount; i += 1) {
    const type = mode === ROOM_MODE_HUMAN && i === hs ? SEAT_TYPE_HUMAN : SEAT_TYPE_AI;
    seats.push({ index: i, type, color: seatColors[i] ?? null, aiPlayerId: null });
  }
  const now = store.nowIso();
  const room = {
    id: store.newId(),
    mode,
    playerCount,
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
  return room;
}

/**
 * 开赛：校验满员 → 原子翻转房间状态 → 发布活跃对局 → 广播 → 启动 AI 调度。
 * @param {object} room 未装饰的房间文档（status 必须 setup）
 * @returns {Promise<object>} GameState
 */
export async function startRoom(room) {
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
        color: seat.color ?? null,
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
      color: seat.color ?? null,
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
  if (!result.item) throw notFound(`房间不存在: ${room.id}`);
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

  // 异步启动 AI 回合调度：不阻塞调用方（AI 决策可能耗时数十秒）。
  void kickGame(state.id);

  return state;
}

export default { isFull, decorateRoom, broadcastRoom, createRoom, startRoom };
