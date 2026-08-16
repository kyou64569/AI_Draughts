/**
 * 对战历史 + 积分排名（GET /api/history）。
 * 数据源：games.json（终局归档记录）。
 */
import { Router } from 'express';
import { asyncHandler, sendOk } from '../http.js';
import store from '../store.js';

const router = Router();

/** 结束原因中文名。 */
const END_REASON_LABEL = Object.freeze({
  all_finished: '全部入营',
  deadlock: '对局死锁',
  ply_limit: '达到手数上限',
});

/** 玩家聚合 key：AI 按 aiPlayerId；人类按 seat（name 变化不影响聚合）。 */
function playerKey(score, player) {
  if (player?.aiPlayerId) return `ai:${player.aiPlayerId}`;
  return `human:${score.seat}`;
}

/** 玩家展示名。 */
function playerName(score, player) {
  return player?.name ?? score.name ?? `座位 ${(score.seat ?? 0) + 1}`;
}

/**
 * GET /api/history — 对战历史（倒序）+ 积分排名。
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const games = await store.loadCollection('games');

    // 倒序（新→旧）
    const sorted = [...games].sort((a, b) =>
      String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? '')),
    );

    const list = sorted.map((g) => {
      const durationSec =
        g.startedAt && g.finishedAt
          ? Math.max(0, Math.round((new Date(g.finishedAt) - new Date(g.startedAt)) / 1000))
          : 0;
      return {
        id: g.id,
        roomId: g.roomId ?? null,
        startedAt: g.startedAt ?? null,
        finishedAt: g.finishedAt ?? null,
        durationSec,
        moveCount: g.moveCount ?? 0,
        endReason: g.endReason ?? null,
        endReasonLabel: END_REASON_LABEL[g.endReason] ?? (g.status ?? 'finished'),
        players: (g.players ?? []).map((p) => ({
          seat: p.seat,
          color: p.color,
          kind: p.kind,
          name: p.name ?? null,
          model: p.model ?? null,
          finishRank: p.finishRank ?? null,
        })),
      };
    });

    // 积分排名聚合（按玩家 key；score 取该局结算分，rank=1 计冠军）
    const rankMap = new Map();
    for (const g of sorted) {
      const players = g.players ?? [];
      for (const s of g.scores ?? []) {
        const player = players.find((p) => p.seat === s.seat);
        const key = playerKey(s, player);
        const entry = rankMap.get(key) ?? {
          key,
          name: playerName(s, player),
          kind: player?.kind ?? (key.startsWith('ai:') ? 'ai' : 'human'),
          model: player?.model ?? null,
          games: 0,
          wins: 0,
          totalScore: 0,
          rankSum: 0,
        };
        entry.games += 1;
        if (s.rank === 1) entry.wins += 1;
        entry.totalScore += Number.isFinite(s.score) ? s.score : 0;
        entry.rankSum += Number.isFinite(s.rank) ? s.rank : 3;
        rankMap.set(key, entry);
      }
    }
    const ranking = [...rankMap.values()]
      .map((r) => ({
        ...r,
        avgRank: r.games > 0 ? Math.round((r.rankSum / r.games) * 100) / 100 : null,
      }))
      .sort(
        (a, b) =>
          b.totalScore - a.totalScore || a.avgRank - b.avgRank || b.wins - a.wins,
      );

    sendOk(res, { games: list, ranking });
  }),
);

export default router;
