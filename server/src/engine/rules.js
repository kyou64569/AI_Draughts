/**
 * 规则引擎（纯函数，无 I/O）：单步 / 连跳 / 走法应用 / 目标营地统计。
 *
 * 走法用 path 表示：`[fromKey, ...midKeys, toKey]`
 *  - 单步：`path.length === 2`（相邻空格）
 *  - 跳跃：`path.length >= 3`（连跳）
 *  - **连跳可中途停止**（中国跳棋标准规则）：每个可达落点（含跳 1 步、2 步…）
 *    都是一条独立合法走法；跳到无子可跳为止只是其中一种（信息量最大）。
 * 中间格只是"落脚点"，被跳过的棋子不移除（中国跳棋不吃子）。
 */
import { DIRECTIONS, MAX_JUMP_CHAINS, MAX_JUMP_DEPTH, SEAT_COLORS } from '../constants.js';
import { TARGET_CELLS, isValidCoord, key, parseKey } from './board.js';

/**
 * 从某个位置出发的全部合法走法。
 * 跳跃部分：DFS 收集所有可达落点（**含中途停点**，标准规则允许连跳中任意停下）；
 * 同落点保留"跳数最多"的路径（走法等价、信息量最大，标注连跳步数更准确）。
 * @param {Record<string, string|null>} board 全 121 键棋盘
 * @param {string} fromKey 起点（必须有己方棋子，由调用方保证归属）
 * @returns {string[][]} 每项为一条 path
 */
export function getLegalMoves(board, fromKey) {
  /** @type {string[][]} */
  const moves = [];
  if (board == null || board[fromKey] == null) return moves;
  const [q, r, s] = parseKey(fromKey);

  // 1) 单步：6 个方向的相邻空位
  for (const [dq, dr, ds] of DIRECTIONS) {
    const nq = q + dq;
    const nr = r + dr;
    const ns = s + ds;
    if (!isValidCoord(nq, nr, ns)) continue;
    const nk = key(nq, nr, ns);
    if (board[nk] == null) moves.push([fromKey, nk]);
  }

  // 2) 跳跃（含中途停）：DFS 展开所有可达落点
  /** @type {Map<string, {jumps:number, path:string[]}>} toKey → 最优（跳数最多）路径 */
  const landings = new Map();
  const dfs = (curKey, path) => {
    if (path.length - 1 >= MAX_JUMP_DEPTH) return; // 深度保险
    const [cq, cr, cs] = parseKey(curKey);
    for (const [dq, dr, ds] of DIRECTIONS) {
      const oq = cq + dq;
      const or = cr + dr;
      const os = cs + ds;
      const lq = cq + 2 * dq;
      const lr = cr + 2 * dr;
      const ls = cs + 2 * ds;
      if (!isValidCoord(oq, or, os) || !isValidCoord(lq, lr, ls)) continue;
      const ok = key(oq, or, os);
      const lk = key(lq, lr, ls);
      if (board[ok] == null || board[lk] != null) continue;
      if (path.includes(lk)) continue; // 防环
      const jumps = path.length; // 本次跳跃后的总跳数（= 新路径格数 - 1）
      const existing = landings.get(lk);
      if (!existing || jumps > existing.jumps) {
        landings.set(lk, { jumps, path: [...path, lk] });
      }
      dfs(lk, [...path, lk]);
    }
  };
  dfs(fromKey, [fromKey]);
  for (const { path } of landings.values()) moves.push(path);

  return moves;
}

/**
 * 从当前落点递归展开所有"完整连跳链"（跳到无子可跳为止，禁止回到已访问格防环）。
 * @param {Record<string, string|null>} board
 * @param {string} curKey 当前落点
 * @param {string[]} path 已走路径（含起点与当前落点）
 * @returns {string[][]} 每项为一条完整连跳 path（末项为无法继续跳的落点）
 */
export function findJumpChains(board, curKey, path) {
  /** @type {string[][]} */
  const results = [];
  const visited = new Set(path);
  expandJumps(board, curKey, path, visited, results);
  return results;
}

/**
 * 连跳递归内核。
 * @param {Record<string, string|null>} board
 * @param {string} curKey
 * @param {string[]} path
 * @param {Set<string>} visited
 * @param {string[][]} results
 * @returns {void}
 */
function expandJumps(board, curKey, path, visited, results) {
  if (results.length >= MAX_JUMP_CHAINS) return;
  if (path.length - 1 >= MAX_JUMP_DEPTH) {
    // 深度保护：当作叶子收口，保证仍是一条合法（且已足够长）的连跳。
    results.push([...path]);
    return;
  }

  const [q, r, s] = parseKey(curKey);
  let extended = false;

  for (const [dq, dr, ds] of DIRECTIONS) {
    const oq = q + dq;
    const or = r + dr;
    const os = s + ds;
    const lq = q + 2 * dq;
    const lr = r + 2 * dr;
    const ls = s + 2 * ds;
    if (!isValidCoord(oq, or, os) || !isValidCoord(lq, lr, ls)) continue;
    const ok = key(oq, or, os);
    const lk = key(lq, lr, ls);
    if (board[ok] == null || board[lk] != null) continue;
    if (visited.has(lk)) continue; // 防环

    extended = true;
    path.push(lk);
    visited.add(lk);
    expandJumps(board, lk, path, visited, results);
    visited.delete(lk);
    path.pop();
    if (results.length >= MAX_JUMP_CHAINS) return;
  }

  if (!extended) results.push([...path]); // 叶子 = 一条完整连跳
}

/**
 * 应用走法，返回**新** board（不修改入参）。中间格保持不变。
 * @param {Record<string, string|null>} board
 * @param {string[]} path
 * @returns {Record<string, string|null>} 新棋盘
 */
export function applyMove(board, path) {
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('applyMove: path 非法');
  }
  const from = path[0];
  const to = path[path.length - 1];
  const color = board[from];
  if (color == null) throw new Error(`applyMove: 起点 ${from} 无棋子`);
  if (board[to] != null) throw new Error(`applyMove: 落点 ${to} 已被占用`);
  const next = { ...board };
  next[from] = null;
  next[to] = color;
  return next;
}

/**
 * 判断某棋子是否还有任意合法走法（比 getLegalMoves 更快，用于死锁检测）。
 * @param {Record<string, string|null>} board
 * @param {string} fromKey
 * @returns {boolean}
 */
export function hasAnyLegalMove(board, fromKey) {
  if (board == null || board[fromKey] == null) return false;
  const [q, r, s] = parseKey(fromKey);
  for (const [dq, dr, ds] of DIRECTIONS) {
    const nq = q + dq;
    const nr = r + dr;
    const ns = s + ds;
    if (isValidCoord(nq, nr, ns) && board[key(nq, nr, ns)] == null) return true; // 单步
    const lq = q + 2 * dq;
    const lr = r + 2 * dr;
    const ls = s + 2 * ds;
    if (
      isValidCoord(nq, nr, ns) &&
      isValidCoord(lq, lr, ls) &&
      board[key(nq, nr, ns)] != null &&
      board[key(lq, lr, ls)] == null
    ) {
      return true; // 至少存在一次跳跃
    }
  }
  return false;
}

/**
 * 列出某颜色的全部棋子坐标（按 ALL_COORDS 顺序稳定，保证兜底算法确定性）。
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {string[]}
 */
export function ownPieces(board, color) {
  /** @type {string[]} */
  const out = [];
  for (const k of Object.keys(board)) {
    if (board[k] === color) out.push(k);
  }
  out.sort();
  return out;
}

/**
 * 统计某颜色在其目标营地内的棋子数（满 10 即完成）。
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {number}
 */
export function countInTarget(board, color) {
  const cells = TARGET_CELLS[color];
  if (!cells) return 0;
  let n = 0;
  for (const k of cells) {
    if (board[k] === color) n += 1;
  }
  return n;
}

/**
 * 某颜色的全部合法走法（用于 prompt 候选清单与兜底）。
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {string[][]}
 */
export function getAllLegalMoves(board, color) {
  /** @type {string[][]} */
  const all = [];
  for (const from of ownPieces(board, color)) {
    for (const path of getLegalMoves(board, from)) all.push(path);
  }
  return all;
}

/**
 * 某颜色是否还有任意合法走法。
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {boolean}
 */
export function colorHasAnyLegalMove(board, color) {
  for (const from of ownPieces(board, color)) {
    if (hasAnyLegalMove(board, from)) return true;
  }
  return false;
}

/**
 * 某座位是否还有任意合法走法（死锁判定用，architecture.md §5.4）。
 * @param {{board: Record<string, string|null>, players: Array<{seat:number,color:string}>}} state
 * @param {number} seat
 * @returns {boolean}
 */
export function seatHasAnyLegalMove(state, seat) {
  const player = state.players?.find((p) => p.seat === seat);
  const color = player?.color ?? SEAT_COLORS[seat];
  return colorHasAnyLegalMove(state.board, color);
}

/**
 * 按起点/终点匹配一条合法走法（人类走子与 LLM 返回值校验共用）。
 * 若单步与连跳同终点，优先返回较短路径（单步），落子结果等价。
 * @param {Record<string, string|null>} board
 * @param {string} fromKey
 * @param {string} toKey
 * @returns {string[]|null} 匹配到的 path；无匹配返回 null
 */
export function findMoveByEndpoints(board, fromKey, toKey) {
  const candidates = getLegalMoves(board, fromKey).filter(
    (path) => path[path.length - 1] === toKey,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

/**
 * 是否为单步走法。
 * @param {string[]} path
 * @returns {boolean}
 */
export function isSingleStep(path) {
  return Array.isArray(path) && path.length === 2;
}

/**
 * 是否为连跳走法。
 * @param {string[]} path
 * @returns {boolean}
 */
export function isJump(path) {
  return Array.isArray(path) && path.length >= 3;
}

export default {
  getLegalMoves,
  findJumpChains,
  applyMove,
  hasAnyLegalMove,
  ownPieces,
  countInTarget,
  getAllLegalMoves,
  colorHasAnyLegalMove,
  seatHasAnyLegalMove,
  findMoveByEndpoints,
  isSingleStep,
  isJump,
};
