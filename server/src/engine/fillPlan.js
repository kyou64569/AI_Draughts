/**
 * 目标营地补位计划（fill plan）+ 推进收益（prompt 构建与确定性兜底共用）。
 *
 * 中国跳棋的营地是三角形，**必须由深到浅填充**：先占靠外的格子会把通往顶点的
 * 通道堵死，剩余棋子永远进不去（实测会卡在 7/10）。因此约定一个强不变量：
 *   己方在营地内占据的格子，永远是"按到顶点距离升序"排列的一个前缀。
 * 做法是每回合只开放**一个**落位点 `nextHole`（最深的空格），
 * 落在营地内其它格子的走法一律重罚，从而保持前缀不变量、避免来回抖动。
 *
 * 前瞻（铺路）：`futureMaxGain` 模拟"走完一步后，本方可获得的最大下一手收益"，
 * 使决策不只是单步贪心——当前收益小但能为下回合创造大收益（搭跳板/占位）的走法
 * 也能被选中（fallbackMove 与候选清单均采用 当前收益 + 0.5×未来潜力）。
 */
import {
  TARGET_APEX,
  TARGET_CELLS,
  cubeDistance,
  isValidCoord,
  key,
  parseKey,
} from './board.js';
import { DIRECTIONS } from '../constants.js';
import { applyMove, getAllLegalMoves, getLegalMoves, ownPieces } from './rules.js';

/**
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {{nextHole: string, settled: Set<string>}} 当前落位点与已就位（冻结）的棋子
 */
export function computeFillPlan(board, color) {
  const cells = TARGET_CELLS[color];
  /** @type {string|null} */
  let nextHole = null;
  let nextIndex = cells.length;
  for (let i = 0; i < cells.length; i += 1) {
    if (board[cells[i]] == null) {
      nextHole = cells[i];
      nextIndex = i;
      break;
    }
  }
  // 已就位：站在比 nextHole 更深（索引更小）的营地格上的己方棋子
  const settled = new Set();
  for (let i = 0; i < nextIndex; i += 1) {
    if (board[cells[i]] === color) settled.add(cells[i]);
  }
  return { nextHole: nextHole ?? TARGET_APEX[color], settled };
}

/**
 * 单步推进收益：到当前落位点 nextHole 的立方距离减少量，精确落位额外 +2。
 * 与确定性兜底算法一致（已就位棋子由调用方另行重罚）。
 * @param {Record<string, string|null>} board
 * @param {string} from 起点
 * @param {string} to 落点
 * @param {'red'|'green'|'blue'} color
 * @returns {number}
 */
export function computeMoveGain(board, from, to, color) {
  const { nextHole } = computeFillPlan(board, color);
  let gain = cubeDistance(from, nextHole) - cubeDistance(to, nextHole);
  if (to === nextHole) gain += 2;
  return gain;
}

/**
 * 前瞻评估：本方可获得的最大"下一手收益"（用于给当前候选打铺路分）。
 * 模拟走一步后的棋盘上，遍历本方的合法走法，取最大单步收益；
 * 已就位棋子（settled）的走法不计入（冻结）。
 * @param {Record<string, string|null>} board 走一步之后的棋盘
 * @param {'red'|'green'|'blue'} color
 * @returns {number}
 */
export function futureMaxGain(board, color) {
  const { settled } = computeFillPlan(board, color);
  let best = 0;
  for (const path of getAllLegalMoves(board, color)) {
    const from = path[0];
    if (settled.has(from)) continue; // 已就位勿动
    const g = computeMoveGain(board, from, path[path.length - 1], color);
    if (g > best) best = g;
  }
  return best;
}

/**
 * 候选走法的综合评分（当前收益 + 未来铺路潜力）。
 * @param {Record<string, string|null>} board
 * @param {string[]} path
 * @param {'red'|'green'|'blue'} color
 * @returns {{gain:number, future:number, total:number}}
 */
export function evaluateMove(board, path, color) {
  const from = path[0];
  const to = path[path.length - 1];
  const gain = computeMoveGain(board, from, to, color);
  const nextBoard = applyMove(board, path);
  const future = futureMaxGain(nextBoard, color);
  return { gain, future, total: gain + future * 0.5 };
}

/* ------------------------------------------------------------------ *
 * 让位（大本营堵死僵局的解法）
 *
 * 场景：对方（或人类）的最后一枚棋子仍在其出发营地中，而该营地恰是本方
 * 的目标营地且已被本方填满——被困棋子无路可出，本方棋子又因"已就位冻结"
 * 永不让位，对局来回横跳直到手数上限。
 *
 * 规则引擎（rules.js）从不禁止移出目标营地，"不得离开"只是 AI 约束层
 * （sanityCheck 冻结 settled / prompt 硬约束 / 兜底重罚）的产物。让位的
 * 本质：在"确实有棋子被困"时临时解除该约束，挪开一枚挡路己子为其让出
 * 出口，待其脱困后再移回（fillPlan 的深前缀不变量天然支持这个暂态——
 * 挪空的位置会成为 nextHole，本方会被正常收益引导移回）。
 * ------------------------------------------------------------------ */

/**
 * 判断站在 fromKey 的棋子能否在 depth 手内离开 campCells 营地。
 * 深度 2：本手直接出，或先在营内挪一步再出（营地未满时的过渡位）。
 * @param {Record<string, string|null>} board
 * @param {string} fromKey
 * @param {Set<string>} campCells
 * @param {number} [depth=2]
 * @returns {boolean}
 */
function canLeaveCamp(board, fromKey, campCells, depth = 2) {
  for (const path of getLegalMoves(board, fromKey)) {
    const dest = path[path.length - 1];
    if (!campCells.has(dest)) return true;
    if (depth > 1) {
      const next = applyMove(board, path);
      if (canLeaveCamp(next, dest, campCells, depth - 1)) return true;
    }
  }
  return false;
}

/** 六邻格中在棋盘上的坐标键。 */
function neighborKeys(cell) {
  const [q, r, s] = parseKey(cell);
  return DIRECTIONS.map(([dq, dr, ds]) => [q + dq, r + dr, s + ds])
    .filter(([nq, nr, ns]) => isValidCoord(nq, nr, ns))
    .map(([nq, nr, ns]) => key(nq, nr, ns));
}

/**
 * 棋子是否"被我方围死"：无法在 depth 手内离开营地，且所有紧邻占用格都是
 * color 己方棋子。后者是排除误报的关键——开局时双方各自的出发营地被对方
 * 目标视角看作"满营外族"，但围住棋子的是它自己的队友（会自然走开），
 * 不构成"只有营地主人才能解困"的让位义务。
 */
function isWalledInByMe(board, cell, color, campCells, depth = 2) {
  if (canLeaveCamp(board, cell, campCells, depth)) return false;
  for (const n of neighborKeys(cell)) {
    const occ = board[n];
    if (occ && occ !== color) return false;
  }
  return true;
}

/**
 * 让位检测：找出困在 color 目标营地内、被 color 己方棋子围死而无法脱身的
 * 外族棋子所在格。营地内没有外族棋子时近乎零成本（只扫 10 格占用）。
 * @param {Record<string, string|null>} board
 * @param {string} color 营地主人（这是谁的目标营地）
 * @returns {string[]} 被困外族棋子的坐标键（按营地格顺序，稳定输出）
 */
export function findCampBlockedForeigners(board, color) {
  const campCells = new Set(TARGET_CELLS[color]);
  const blocked = [];
  for (const cell of TARGET_CELLS[color]) {
    const piece = board[cell];
    if (!piece || piece === color) continue;
    if (!isWalledInByMe(board, cell, color, campCells)) continue;
    blocked.push(cell);
  }
  return blocked;
}

/**
 * 模拟走 path 后，统计 blockedCells 中因此脱困（恢复离开营地能力）的外族棋子数。
 * @param {Record<string, string|null>} board
 * @param {string} color 营地主人
 * @param {string[]} path
 * @param {string[]} blockedCells findCampBlockedForeigners 的返回值
 * @returns {number}
 */
export function countFreedAfterMove(board, color, path, blockedCells) {
  if (blockedCells.length === 0) return 0;
  const next = applyMove(board, path);
  const campCells = new Set(TARGET_CELLS[color]);
  let freed = 0;
  for (const cell of blockedCells) {
    if (board[cell] && canLeaveCamp(next, cell, campCells)) freed += 1;
  }
  return freed;
}

/**
 * 是否为让位走法：存在被困外族棋子，且走完 path 后至少一枚脱困。
 * sanityCheck 用它豁免 settled 冻结——只放行真正起解困作用的走法。
 * @param {Record<string, string|null>} board
 * @param {string} color 营地主人
 * @param {string[]} path
 * @returns {boolean}
 */
export function isUnblockMove(board, color, path) {
  const blocked = findCampBlockedForeigners(board, color);
  if (blocked.length === 0) return false;
  return countFreedAfterMove(board, color, path, blocked) > 0;
}

/**
 * 选出最佳让位走法：释放的被困棋子数优先，其次让位棋子离营地顶点尽量近
 * （便于脱困后移回）。无任何可解困走法时返回 null（调用方落回常规逻辑）。
 * @param {Record<string, string|null>} board
 * @param {string} color 营地主人
 * @param {string[]} blockedCells findCampBlockedForeigners 的返回值
 * @returns {{path:string[], freed:number}|null}
 */
export function findUnblockMove(board, color, blockedCells) {
  if (blockedCells.length === 0) return null;
  let best = null;
  for (const from of ownPieces(board, color)) {
    for (const path of getLegalMoves(board, from)) {
      const freed = countFreedAfterMove(board, color, path, blockedCells);
      if (freed === 0) continue;
      const to = path[path.length - 1];
      const score = freed * 1000 - cubeDistance(to, TARGET_APEX[color]);
      if (!best || score > best.score) best = { path, freed, score };
    }
  }
  return best ? { path: best.path, freed: best.freed } : null;
}

export default { computeFillPlan, computeMoveGain, futureMaxGain, evaluateMove, findCampBlockedForeigners, countFreedAfterMove, isUnblockMove, findUnblockMove };
