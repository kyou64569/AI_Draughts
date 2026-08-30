/**
 * 对战历史 + 积分排名（GET /api/history）。
 * 数据源：games.json（终局归档记录，含完整棋谱 history）。
 *
 * - GET /api/history          列表（倒序）+ 积分排名
 * - GET /api/history/:id      单局详情（完整棋谱 + 每座位决策质量统计）
 * - GET /api/history/:id/export  棋谱文本导出（可分享/存档）
 */
import { Router } from 'express';
import { asyncHandler, notFound, sendOk } from '../http.js';
import store from '../store.js';

const router = Router();

/** 结束原因中文名。 */
const END_REASON_LABEL = Object.freeze({
  all_finished: '全部入营',
  deadlock: '对局死锁',
  stall: '无进展停滞（长时间无子入营）',
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
 * 从归档棋谱统计每座位的决策质量（回放面板与跨模型对比的数据源）。
 * 旧归档无 history 字段时各计数为 0。
 * @param {object} record games.json 归档记录
 * @returns {Array<{seat:number,color:string,name:string|null,model:string|null,moves:number,fallbackMoves:number,fallbackRate:number|null,llmFailures:number,avgLatencyMs:number|null,maxLatencyMs:number|null,llmCalls:number,promptTokens:number,completionTokens:number}>}
 */
export function computeGameStats(record) {
  const history = Array.isArray(record?.history) ? record.history : [];
  /** @type {Map<number, object>} */
  const bySeat = new Map();
  for (const p of record?.players ?? []) {
    bySeat.set(p.seat, {
      seat: p.seat,
      color: p.color,
      name: p.name ?? null,
      model: p.model ?? null,
      moves: 0,
      fallbackMoves: 0,
      fallbackRate: null,
      llmFailures: 0,
      latencyTotal: 0,
      latencyCount: 0,
      avgLatencyMs: null,
      maxLatencyMs: null,
      llmCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
  }
  for (const m of history) {
    const s = bySeat.get(m.seat);
    if (!s) continue;
    s.moves += 1;
    if (m.isFallback) s.fallbackMoves += 1;
    if (Number.isFinite(m.failures)) s.llmFailures += m.failures;
    if (Number.isFinite(m.latencyMs)) {
      s.latencyTotal += m.latencyMs;
      s.latencyCount += 1;
      s.maxLatencyMs = Math.max(s.maxLatencyMs ?? 0, m.latencyMs);
    }
    if (m.usage && Number.isFinite(m.usage.promptTokens)) {
      s.promptTokens += m.usage.promptTokens;
      s.completionTokens += Number.isFinite(m.usage.completionTokens) ? m.usage.completionTokens : 0;
      s.llmCalls += 1;
    }
  }
  const out = [...bySeat.values()];
  for (const s of out) {
    s.avgLatencyMs = s.latencyCount > 0 ? Math.round(s.latencyTotal / s.latencyCount) : null;
    s.fallbackRate = s.moves > 0 ? Math.round((s.fallbackMoves / s.moves) * 100) : null;
    delete s.latencyTotal;
    delete s.latencyCount;
  }
  return out;
}

/**
 * 生成可分享的文本棋谱（PGN 风格头部 + 逐手记录）。
 * @param {object} g 归档记录
 * @returns {string}
 */
export function buildExportText(g) {
  const lines = [];
  // 按实际参战人数生成标题（2/3/4/6 人局；旧归档缺 players 时按 3 人兜底）
  const COUNT_LABEL = { 2: '双人', 3: '三人', 4: '四人', 6: '六人' };
  const playerCount = Array.isArray(g?.players) ? g.players.length : 3;
  const countLabel = COUNT_LABEL[playerCount] ?? `${playerCount}人`;
  lines.push(`AI_Draughts ${countLabel}中国跳棋 棋谱`);
  lines.push('========================================');
  lines.push(`[GameID   "${g.id}"]`);
  lines.push(`[RoomID   "${g.roomId ?? '-'}"]`);
  lines.push(`[Started  "${g.startedAt ?? '-'}"]`);
  lines.push(`[Finished "${g.finishedAt ?? '-'}"]`);
  lines.push(`[EndReason "${END_REASON_LABEL[g.endReason] ?? g.endReason ?? '-'}"]`);
  lines.push(`[Moves    "${g.moveCount ?? (g.history?.length ?? 0)}"]`);
  lines.push('');
  lines.push('玩家与结算:');
  for (const s of g.scores ?? []) {
    const p = (g.players ?? []).find((pl) => pl.seat === s.seat);
    const kind = p?.kind === 'human' ? '人类' : 'AI';
    lines.push(
      `  [${s.color}] 座位${s.seat + 1} ${p?.name ?? s.name ?? '-'} (${kind}${p?.model ? ` · ${p.model}` : ''})` +
        ` — 第 ${s.rank} 名, ${s.score} 分 (入营 ${Math.round((s.base ?? 0) / 100)}, 名次加成 ${s.rankBonus ?? 0}, 时间罚分 ${s.timePenalty ?? 0})`,
    );
  }
  lines.push('');
  lines.push('走法记录 (from -> to 为立方坐标 q,r,s):');
  const history = Array.isArray(g.history) ? g.history : [];
  if (history.length === 0) {
    lines.push('  （该对局归档时未保存棋谱明细）');
  }
  history.forEach((m, i) => {
    const p = (g.players ?? []).find((pl) => pl.seat === m.seat);
    const jump = Array.isArray(m.path) && m.path.length >= 3 ? ` (连跳x${m.path.length - 1})` : '';
    const fallback = m.isFallback ? ' [兜底]' : '';
    const reason = m.reason ? `  {${m.reason}}` : '';
    lines.push(
      `${String(i + 1).padStart(4, ' ')}. [${p?.color ?? m.seat}] ${p?.name ?? '-'}${p?.model ? `·${p.model}` : ''}:` +
        ` ${m.from} -> ${m.to}${jump}${fallback}${reason}`,
    );
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 按 id 查找归档对局，不存在抛 404。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function mustGetGame(id) {
  const games = await store.loadCollection('games');
  const g = games.find((it) => it.id === id);
  if (!g) throw notFound(`对局记录不存在: ${id}`);
  return g;
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
        // 是否含可回放棋谱（旧归档无 history 字段）
        replayable: Array.isArray(g.history) && g.history.length > 0,
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

/**
 * GET /api/history/:id — 单局详情（棋谱回放数据源：完整 history + 每座位决策质量统计）。
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const g = await mustGetGame(req.params.id);
    sendOk(res, { ...g, stats: computeGameStats(g) });
  }),
);

/**
 * GET /api/history/:id/export — 棋谱文本导出（浏览器直接下载）。
 */
router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const g = await mustGetGame(req.params.id);
    const text = buildExportText(g);
    // 文件名只保留安全字符：req.params.id 来自 URL（可含百分号编码的 CR/LF），
    // 直接拼进 Content-Disposition 会触发响应头注入，setHeader 抛错 → 500。
    // 若 ID 全为特殊字符导致 safeId 为空，使用时间戳确保唯一性。
    const safeId = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const filename = safeId || `game-${Date.now()}`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="draughts-${filename}.txt"`,
    );
    res.status(200).send(text);
  }),
);

export default router;
