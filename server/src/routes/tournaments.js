/**
 * 锦标赛路由 `/api/tournaments`（建议 2.3）：
 *  GET    /                 列表（摘要）
 *  POST   /                 创建（pending）
 *  GET    /:id              详情（赛程 + 积分榜）
 *  POST   /:id/start        启动（自动开赛）
 *  POST   /:id/abort        中止
 *  DELETE /:id              删除（仅 pending/finished/aborted）
 */
import { Router } from 'express';

import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
  requireString,
  sendOk,
} from '../http.js';
import { computeStandings, createTournament, startTournament, abortTournament } from '../services/tournament.js';
import store from '../store.js';

const router = Router();

/** 锦标赛摘要（列表用，不含赛程明细）。 */
function summarize(t) {
  const matches = t.matches ?? [];
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    aiPlayerIds: t.aiPlayerIds ?? [],
    roundsPerPairing: t.roundsPerPairing ?? 1,
    totalMatches: matches.length,
    finishedMatches: matches.filter((m) => m.status === 'finished').length,
    createdAt: t.createdAt ?? null,
    startedAt: t.startedAt ?? null,
    finishedAt: t.finishedAt ?? null,
  };
}

/**
 * 取锦标赛，不存在则 404。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function mustGetTournament(id) {
  const t = await store.findById('tournaments', id);
  if (!t) throw notFound(`锦标赛不存在: ${id}`);
  return t;
}

/** GET /api/tournaments — 列表（新→旧）。 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tournaments = await store.loadCollection('tournaments');
    const sorted = [...tournaments].sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );
    sendOk(res, sorted.map(summarize));
  }),
);

/** POST /api/tournaments — 创建。 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const tournament = await createTournament({
      name: requireString(req.body?.name, 'name'),
      aiPlayerIds: req.body?.aiPlayerIds,
      roundsPerPairing: req.body?.roundsPerPairing,
    });
    sendOk(res, summarize(tournament));
  }),
);

/** GET /api/tournaments/:id — 详情（赛程 + 积分榜）。 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const t = await mustGetTournament(req.params.id);
    const aiPlayers = await store.loadCollection('aiPlayers');
    const rooms = await store.loadCollection('rooms');
    sendOk(res, {
      ...t,
      standings: computeStandings(t, aiPlayers),
      matches: (t.matches ?? []).map((m) => ({
        ...m,
        // 场次附 AI 名称与房间状态，前端直接展示
        seats: (m.seatAiPlayerIds ?? []).map((id) => {
          const p = aiPlayers.find((x) => x.id === id);
          return { aiPlayerId: id, name: p?.name ?? id, model: p?.model ?? null };
        }),
        roomStatus: rooms.find((r) => r.id === m.roomId)?.status ?? null,
      })),
    });
  }),
);

/** POST /api/tournaments/:id/start — 启动。 */
router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const updated = await startTournament(req.params.id);
    sendOk(res, summarize(updated));
  }),
);

/** POST /api/tournaments/:id/abort — 中止。 */
router.post(
  '/:id/abort',
  asyncHandler(async (req, res) => {
    const updated = await abortTournament(req.params.id);
    sendOk(res, summarize(updated));
  }),
);

/** DELETE /api/tournaments/:id — 删除（running 需先中止）。 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const t = await mustGetTournament(req.params.id);
    if (t.status === 'running') throw conflict('锦标赛进行中，请先中止再删除');
    await store.removeItem('tournaments', req.params.id);
    sendOk(res, null);
  }),
);

export default router;
