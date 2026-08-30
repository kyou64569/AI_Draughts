/**
 * 锦标赛服务（建议 2.3）：多个 AI 玩家循环对战，自动建房 → 开赛 → 记录结果 → 下一场。
 *
 * 赛制：从参赛 AI 中生成 3 人组合（roundsPerPairing 轮，轮次间轮换座位），
 * 依序自动进行；对局完全复用现有房间/开赛/调度链路（roomService + scheduler）。
 * 同一时刻只允许一个锦标赛处于 running（避免多赛程争抢 AI/限流窗口）。
 */
import { ROOM_MODE_WATCH, SEAT_TYPE_AI } from '../constants.js';
import { badRequest, conflict, notFound, requireString } from '../http.js';
import { createRoom, startRoom } from './roomService.js';
import store from '../store.js';

/** 单届锦标赛最大场次（组合数封顶，防止参赛者过多时赛程爆炸：C(7,3)=35 → 截断 30）。 */
export const TOURNAMENT_MAX_MATCHES = 30;

/** 场间间隔（毫秒）：给上一局的 SSE 清理与限流窗口留缓冲。 */
const MATCH_GAP_MS = 1500;

/** 锦标赛状态。 */
export const TOURNAMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  FINISHED: 'finished',
  ABORTED: 'aborted',
});

/**
 * 生成 3 人组合赛程（C(n,3)；rounds 轮间轮换座位；封顶 maxMatches）。
 * @param {string[]} aiPlayerIds 参赛 AI（去重后需 ≥3）
 * @param {number} [roundsPerPairing=1] 1..3
 * @param {number} [maxMatches=TOURNAMENT_MAX_MATCHES]
 * @returns {Array<{id:string, seatAiPlayerIds:string[], status:string, roomId:string|null, gameId:string|null, result:object[]|null}>}
 */
export function generateMatches(aiPlayerIds, roundsPerPairing = 1, maxMatches = TOURNAMENT_MAX_MATCHES) {
  const ids = [...new Set(aiPlayerIds)];
  /** @type {string[][]} */
  const combos = [];
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      for (let c = b + 1; c < ids.length; c += 1) {
        combos.push([ids[a], ids[b], ids[c]]);
      }
    }
  }
  /** @type {object[]} */
  const matches = [];
  for (let round = 0; round < Math.max(1, roundsPerPairing); round += 1) {
    for (const combo of combos) {
      // 轮次间轮换座位（先手优势均衡）
      const rotated = combo.map((_, i) => combo[(i + round) % combo.length]);
      matches.push({
        id: `m${matches.length + 1}`,
        seatAiPlayerIds: rotated,
        status: 'pending',
        roomId: null,
        gameId: null,
        result: null,
      });
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

/**
 * 计算积分榜（从已完成场次聚合；ELO 取自 aiPlayers 当前值）。
 * @param {object} tournament
 * @param {object[]} aiPlayers
 * @returns {Array<object>} 按 总分→均名次→冠军数 排序
 */
export function computeStandings(tournament, aiPlayers) {
  const byId = new Map((aiPlayers ?? []).map((p) => [p.id, p]));
  /** @type {Map<string, object>} */
  const rows = new Map();
  for (const id of tournament.aiPlayerIds ?? []) {
    const p = byId.get(id);
    rows.set(id, {
      aiPlayerId: id,
      name: p?.name ?? id,
      model: p?.model ?? null,
      elo: Number.isFinite(p?.elo) ? p.elo : 1200,
      played: 0,
      first: 0,
      second: 0,
      third: 0,
      totalScore: 0,
      rankSum: 0,
    });
  }
  for (const m of tournament.matches ?? []) {
    if (m.status !== 'finished' || !Array.isArray(m.result)) continue;
    for (const r of m.result) {
      const row = rows.get(r.aiPlayerId);
      if (!row) continue;
      row.played += 1;
      if (r.rank === 1) row.first += 1;
      else if (r.rank === 2) row.second += 1;
      else row.third += 1;
      row.totalScore += Number.isFinite(r.score) ? r.score : 0;
      row.rankSum += Number.isFinite(r.rank) ? r.rank : 3;
    }
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    avgRank: r.played > 0 ? Math.round((r.rankSum / r.played) * 100) / 100 : null,
  }));
  list.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      (a.avgRank ?? 99) - (b.avgRank ?? 99) ||
      b.first - a.first,
  );
  return list;
}

/**
 * 校验并取参赛 AI 列表（去重、存在性、数量 ≥3）。
 * @param {any} raw
 * @returns {Promise<string[]>}
 */
async function resolveParticipants(raw) {
  if (!Array.isArray(raw)) throw badRequest('aiPlayerIds 必须是数组');
  const ids = [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (ids.length < 3) throw badRequest('锦标赛至少需要 3 个不同的 AI 玩家');
  for (const id of ids) {
    const ai = await store.findById('aiPlayers', id);
    if (!ai) throw notFound(`AI 玩家不存在: ${id}`);
  }
  return ids;
}

/**
 * 创建锦标赛（pending，不自动开赛）。
 * @param {{name:string, aiPlayerIds:string[], roundsPerPairing?:number}} opts
 * @returns {Promise<object>}
 */
export async function createTournament({ name, aiPlayerIds, roundsPerPairing = 1 }) {
  const ids = await resolveParticipants(aiPlayerIds);
  const rounds = Math.min(3, Math.max(1, Number(roundsPerPairing) || 1));
  const now = store.nowIso();
  const tournament = {
    id: store.newId(),
    name: requireString(name, 'name'),
    status: TOURNAMENT_STATUS.PENDING,
    aiPlayerIds: ids,
    roundsPerPairing: rounds,
    matches: generateMatches(ids, rounds),
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  await store.insertItem('tournaments', tournament);
  return tournament;
}

/**
 * 启动锦标赛（pending → running，自动开第一场）。
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function startTournament(id) {
  const tournament = await store.findById('tournaments', id);
  if (!tournament) throw notFound(`锦标赛不存在: ${id}`);
  if (tournament.status === TOURNAMENT_STATUS.RUNNING) throw conflict('锦标赛已在进行中');
  if (tournament.status === TOURNAMENT_STATUS.FINISHED) throw conflict('锦标赛已结束');
  if (tournament.status === TOURNAMENT_STATUS.ABORTED) throw conflict('锦标赛已中止，无法重启');

  const all = await store.loadCollection('tournaments');
  const otherRunning = all.find((x) => x.status === TOURNAMENT_STATUS.RUNNING && x.id !== id);
  if (otherRunning) {
    throw conflict(`另一届锦标赛「${otherRunning.name}」正在进行中，请先等待完成或中止它`);
  }

  const updated = await store.updateItem('tournaments', id, {
    status: TOURNAMENT_STATUS.RUNNING,
    startedAt: store.nowIso(),
    updatedAt: store.nowIso(),
  });
  // 异步开第一场：不阻塞 HTTP 响应
  void kickTournament(id);
  return updated;
}

/**
 * 开下一场待赛场次（无待赛则收尾为 finished）。
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function kickTournament(id) {
  const tournament = await store.findById('tournaments', id);
  if (!tournament || tournament.status !== TOURNAMENT_STATUS.RUNNING) return;
  const next = (tournament.matches ?? []).find((m) => m.status === 'pending');
  if (!next) {
    await store.updateItem('tournaments', id, {
      status: TOURNAMENT_STATUS.FINISHED,
      finishedAt: store.nowIso(),
      updatedAt: store.nowIso(),
    });
    return;
  }
  try {
    await startMatch(tournament, next);
  } catch (err) {
    // 单场开赛失败（如 AI 玩家被删）：标记跳过并继续后续场次。
    // 统一"读旧值 → 生成新数组 → updateItem"写回，不原地改缓存对象
    //（绕过 store 写队列、刷盘失败会造成内存与磁盘不一致）。
    console.warn(`[tournament] 场次 ${next.id} 开赛失败，跳过:`, err?.message ?? err);
    const matches = (tournament.matches ?? []).map((m) =>
      m.id === next.id ? { ...m, status: 'skipped' } : m,
    );
    await store.updateItem('tournaments', id, { matches, updatedAt: store.nowIso() });
    await scheduleNext(id);
  }
}

/** 延迟开下一场。 */
async function scheduleNext(id) {
  const timer = setTimeout(() => {
    void kickTournament(id);
  }, MATCH_GAP_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 开一场：建房（观战模式）→ 按赛程指派 AI → 开赛 → 回写场次信息。
 * @param {object} tournament 所属锦标赛（取 id 做持久化定位）
 * @param {object} match 待赛场次（只读其 id；进度经 updateItem 写回，不就地更新）
 */
async function startMatch(tournament, match) {
  const seatIds = match.seatAiPlayerIds ?? [];
  for (const aiId of seatIds) {
    const ai = await store.findById('aiPlayers', aiId);
    if (!ai) throw new Error(`参赛 AI 已被删除: ${aiId}`);
  }
  const room = await createRoom({
    mode: ROOM_MODE_WATCH,
    playerCount: 3,
    createdBy: `锦标赛·${tournament.name}`,
  });
  // 按赛程指派三个 AI 座位（观战房间全部为 AI 座位）
  const seats = room.seats.map((s, i) =>
    s.type === SEAT_TYPE_AI && seatIds[i] ? { ...s, aiPlayerId: seatIds[i] } : { ...s },
  );
  const updatedRoom = await store.updateItem('rooms', room.id, {
    seats,
    updatedAt: store.nowIso(),
  });
  const state = await startRoom(updatedRoom);
  // 回写场次进度到锦标赛文档：按 id 定位同一场次，生成新数组后 updateItem
  //（不原地改缓存对象，避免绕过 store 写队列、刷盘失败时内存与磁盘不一致）
  const fresh = await store.findById('tournaments', tournament.id);
  if (fresh && (fresh.matches ?? []).some((m) => m.id === match.id)) {
    const matches = (fresh.matches ?? []).map((m) =>
      m.id === match.id ? { ...m, status: 'running', roomId: room.id, gameId: state.id } : m,
    );
    await store.updateItem('tournaments', tournament.id, {
      matches,
      updatedAt: store.nowIso(),
    });
  }
}

/**
 * 终局回调（由 scheduler.finalizeGame 调用）：记录结果并自动开下一场。
 * @param {object} state 已终局的 GameState
 * @returns {Promise<void>}
 */
export async function notifyGameFinished(state) {
  const tournaments = await store.loadCollection('tournaments');
  const tournament = tournaments.find(
    (t) => t.status === TOURNAMENT_STATUS.RUNNING && (t.matches ?? []).some((m) => m.gameId === state.id),
  );
  if (!tournament) return;
  const match = tournament.matches.find((m) => m.gameId === state.id);
  if (!match || match.status === 'finished') return;

  const result = (state.scores ?? []).map((s) => {
    const p = (state.players ?? []).find((pl) => pl.seat === s.seat);
    return {
      aiPlayerId: p?.aiPlayerId ?? null,
      seat: s.seat,
      color: s.color ?? p?.color ?? null,
      rank: s.rank,
      score: s.score,
    };
  });
  // 读旧值 → 生成新数组 → updateItem（不原地改缓存对象，避免绕过 store 写队列）
  const matches = (tournament.matches ?? []).map((m) =>
    m.id === match.id ? { ...m, status: 'finished', result } : m,
  );
  const allDone = matches.every((m) => m.status === 'finished' || m.status === 'skipped');
  await store.updateItem('tournaments', tournament.id, {
    matches,
    ...(allDone
      ? { status: TOURNAMENT_STATUS.FINISHED, finishedAt: store.nowIso() }
      : {}),
    updatedAt: store.nowIso(),
  });
  if (!allDone) await scheduleNext(tournament.id);
}

/**
 * 中止锦标赛：running/pending → aborted（进行中的场次任其自然结束，不再开新场）。
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function abortTournament(id) {
  const tournament = await store.findById('tournaments', id);
  if (!tournament) throw notFound(`锦标赛不存在: ${id}`);
  if (tournament.status === TOURNAMENT_STATUS.FINISHED) throw conflict('锦标赛已结束');
  if (tournament.status === TOURNAMENT_STATUS.ABORTED) throw conflict('锦标赛已中止');
  return store.updateItem('tournaments', id, {
    status: TOURNAMENT_STATUS.ABORTED,
    finishedAt: store.nowIso(),
    updatedAt: store.nowIso(),
  });
}

/**
 * 服务重启自愈：running 锦标赛中"running 但对局已不在内存"的场次回退为 pending，
 * 并继续调度（避免重启后锦标赛卡死）。
 * @returns {Promise<number>} 回退的场次数量
 */
export async function resumeRunningTournaments() {
  const tournaments = await store.loadCollection('tournaments');
  const games = await store.loadCollection('games');
  const gameIds = new Set(games.map((g) => g.id));
  let reverted = 0;
  for (const t of tournaments) {
    if (t.status !== TOURNAMENT_STATUS.RUNNING) continue;
    // 读旧值 → 生成新数组 → updateItem（不原地改缓存对象）
    let revertedHere = 0;
    const matches = (t.matches ?? []).map((m) => {
      // 只回退真正丢失的对局：既不在内存中，也未归档到磁盘
      if (m.status === 'running' && (!m.gameId || (!store.getGame(m.gameId) && !gameIds.has(m.gameId)))) {
        revertedHere += 1;
        return { ...m, status: 'pending' };
      }
      return m;
    });
    if (revertedHere > 0) {
      reverted += revertedHere;
      await store.updateItem('tournaments', t.id, { matches, updatedAt: store.nowIso() });
      await scheduleNext(t.id);
    }
  }
  return reverted;
}

export default {
  TOURNAMENT_STATUS,
  TOURNAMENT_MAX_MATCHES,
  generateMatches,
  computeStandings,
  createTournament,
  startTournament,
  kickTournament,
  notifyGameFinished,
  abortTournament,
  resumeRunningTournaments,
};
