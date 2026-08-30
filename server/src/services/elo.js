/**
 * AI 玩家 ELO 评分（建议 3.2）：
 *  多人对局采用**成对比较法**——对局中每两个 AI 玩家视为一对独立对局，
 *  按名次高低计 S=1/0（同名次 0.5），期望胜率用标准 ELO 公式，
 *  每个玩家的变动为所有配对变动之和。该方案对 2~6 人局通用。
 *
 * 人类座位不参与 ELO（无持久实体），配对时跳过；某局全为人机组合中仅 1 个 AI 时无配对、不变动。
 */

/** 初始 ELO。 */
export const DEFAULT_ELO = 1200;

/** K 系数：单配对最大变动幅度（24 → 逆风翻盘单局约 ±36）。 */
export const ELO_K = 24;

/**
 * 计算一局结束后各 AI 玩家的 ELO 变动。
 * @param {Array<{aiPlayerId:string, elo:number, rank:number}>} entries 参与配对的 AI 玩家（rank 为终局名次，1 最优）
 * @param {number} [k=ELO_K]
 * @returns {Map<string, {delta:number, after:number}>} aiPlayerId → 变动（delta 保留 1 位小数，after 取整）
 */
export function computeEloChanges(entries, k = ELO_K) {
  /** @type {Map<string, {delta:number, after:number}>} */
  const result = new Map();
  const valid = (entries ?? []).filter(
    (e) => e && typeof e.aiPlayerId === 'string' && Number.isFinite(e.elo) && Number.isFinite(e.rank),
  );
  for (const e of valid) result.set(e.aiPlayerId, { delta: 0, after: Math.round(e.elo) });
  if (valid.length < 2) return result;

  /** 期望胜率（标准 ELO）。 */
  const expected = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i];
      const b = valid[j];
      const ea = expected(a.elo, b.elo);
      // 名次高（数值小）者胜；同名次（如同手数上限同时未完成）记和局
      const sa = a.rank < b.rank ? 1 : a.rank === b.rank ? 0.5 : 0;
      const deltaA = k * (sa - ea);
      const deltaB = k * (1 - sa - (1 - ea));
      result.get(a.aiPlayerId).delta += deltaA;
      result.get(b.aiPlayerId).delta += deltaB;
    }
  }
  for (const e of valid) {
    const r = result.get(e.aiPlayerId);
    const delta = Math.round(r.delta * 10) / 10;
    result.set(e.aiPlayerId, { delta, after: Math.max(100, Math.round(e.elo + delta)) });
  }
  return result;
}

/**
 * 终局结算 ELO：读取 AI 玩家当前分 → 计算变动 → 持久化新分。
 * 任何失败都不阻断终局流程（ELO 丢失只影响评分，不影响对局数据）。
 * @param {object} state GameState（需含 players；finishRank 已由 endGame 填好）
 * @returns {Promise<Record<string, {before:number, after:number, delta:number}>|null>} aiPlayerId → 变动（供归档）
 */
export async function applyEloForGame(state) {
  try {
    const { default: store } = await import('../store.js');
    const players = (state?.players ?? []).filter((p) => p.kind === 'ai' && p.aiPlayerId);
    if (players.length < 2) return null;

    const entries = [];
    for (const p of players) {
      const ai = await store.findById('aiPlayers', p.aiPlayerId);
      if (!ai) continue;
      entries.push({ aiPlayerId: p.aiPlayerId, elo: Number.isFinite(ai.elo) ? ai.elo : DEFAULT_ELO, rank: p.finishRank ?? 99 });
    }
    if (entries.length < 2) return null;

    const changes = computeEloChanges(entries);
    /** @type {Record<string, {before:number, after:number, delta:number}>} */
    const record = {};
    for (const [aiPlayerId, { delta, after }] of changes) {
      const before = entries.find((e) => e.aiPlayerId === aiPlayerId)?.elo ?? DEFAULT_ELO;
      record[aiPlayerId] = { before, after, delta };
      await store.updateItem('aiPlayers', aiPlayerId, { elo: after, eloUpdatedAt: new Date().toISOString() });
    }
    return record;
  } catch (err) {
    console.warn('[elo] 更新失败（不阻断终局）:', err?.message ?? err);
    return null;
  }
}

export default { DEFAULT_ELO, ELO_K, computeEloChanges, applyEloForGame };
