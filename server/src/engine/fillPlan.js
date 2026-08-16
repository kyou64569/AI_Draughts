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
import { TARGET_APEX, TARGET_CELLS, cubeDistance } from './board.js';
import { applyMove, getAllLegalMoves } from './rules.js';

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

export default { computeFillPlan, computeMoveGain, futureMaxGain, evaluateMove };
