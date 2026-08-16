/**
 * 棋盘几何：立方坐标 (q, r, s)，q + r + s = 0。
 *
 * 棋盘 = 中心六边形（max(|q|,|r|,|s|) ≤ 4，61 格）∪ 6 个角三角（每角 10 格）= **121 格**。
 * 纯函数模块，无任何 I/O，便于单测（architecture.md §4）。
 */
import {
  BOARD_SIZE,
  COLOR_HOME,
  COLOR_TARGET,
  CORNER_APEX,
  CORNER_NAMES,
  CORNER_NEG_Q,
  CORNER_NEG_R,
  CORNER_NEG_S,
  CORNER_POS_Q,
  CORNER_POS_R,
  CORNER_POS_S,
  DIRECTIONS,
  PIECES_PER_COLOR,
} from '../constants.js';

/**
 * 坐标 → 键字符串 `"q,r,s"`。
 * @param {number} q
 * @param {number} r
 * @param {number} s
 * @returns {string}
 */
export function key(q, r, s) {
  return `${q},${r},${s}`;
}

/**
 * 键字符串 → `[q, r, s]`。
 * @param {string} k 形如 `"3,-1,-2"`
 * @returns {[number, number, number]}
 */
export function parseKey(k) {
  const parts = String(k).split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * 判断坐标是否在棋盘上（六角星 121 格之一）。
 * @param {number} q
 * @param {number} r
 * @param {number} s
 * @returns {boolean}
 */
export function isValidCoord(q, r, s) {
  if (!Number.isInteger(q) || !Number.isInteger(r) || !Number.isInteger(s)) return false;
  if (q + r + s !== 0) return false;

  const m = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
  if (m <= 4) return true; // 中心六边形 61 格

  const A = (x) => x >= 5 && x <= 8; // 极端为正
  const B = (x) => x <= -5 && x >= -8; // 极端为负
  const lo = (x) => x >= -4 && x <= -1; // 另两坐标落在负小区间
  const hi = (x) => x >= 1 && x <= 4; // 另两坐标落在正小区间

  if (A(q) && lo(r) && lo(s)) return true; // +q 角
  if (B(q) && hi(r) && hi(s)) return true; // -q 角
  if (A(r) && lo(q) && lo(s)) return true; // +r 角
  if (B(r) && hi(q) && hi(s)) return true; // -r 角
  if (A(s) && lo(q) && lo(r)) return true; // +s 角
  if (B(s) && hi(q) && hi(r)) return true; // -s 角
  return false;
}

/**
 * 判断键字符串是否为合法棋盘坐标。
 * @param {string} k
 * @returns {boolean}
 */
export function isValidKey(k) {
  if (typeof k !== 'string') return false;
  const parts = k.split(',');
  if (parts.length !== 3) return false;
  const q = Number(parts[0]);
  const r = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(q) || !Number.isFinite(r) || !Number.isFinite(s)) return false;
  return isValidCoord(q, r, s);
}

/**
 * 判断坐标属于哪个角；中心六边形返回 null。
 * @param {number} q
 * @param {number} r
 * @param {number} s
 * @returns {string|null} `POS_Q|NEG_Q|POS_R|NEG_R|POS_S|NEG_S|null`
 */
export function getCorner(q, r, s) {
  if (!isValidCoord(q, r, s)) return null;
  if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= 4) return null;
  if (q >= 5) return CORNER_POS_Q;
  if (q <= -5) return CORNER_NEG_Q;
  if (r >= 5) return CORNER_POS_R;
  if (r <= -5) return CORNER_NEG_R;
  if (s >= 5) return CORNER_POS_S;
  if (s <= -5) return CORNER_NEG_S;
  return null;
}

/**
 * 按键字符串取角归属。
 * @param {string} k
 * @returns {string|null}
 */
export function getCornerOfKey(k) {
  const [q, r, s] = parseKey(k);
  return getCorner(q, r, s);
}

/** 生成全部 121 个合法坐标（按 q 升序、r 升序稳定排序）。 */
function buildAllCoords() {
  /** @type {string[]} */
  const keys = [];
  for (let q = -8; q <= 8; q += 1) {
    for (let r = -8; r <= 8; r += 1) {
      const s = -q - r;
      if (isValidCoord(q, r, s)) keys.push(key(q, r, s));
    }
  }
  return keys;
}

/** @type {ReadonlyArray<string>} 全部 121 个坐标键。 */
export const ALL_COORDS = Object.freeze(buildAllCoords());

/** @type {ReadonlySet<string>} 坐标键集合（O(1) 校验）。 */
export const COORD_SET = new Set(ALL_COORDS);

// 自检：几何是否正好 121 格。一旦不成立则整个规则引擎不可信，直接 fail-fast。
if (ALL_COORDS.length !== BOARD_SIZE) {
  throw new Error(`棋盘坐标数异常: 期望 ${BOARD_SIZE}，实际 ${ALL_COORDS.length}`);
}

/**
 * 立方坐标距离。
 * @param {string} aKey
 * @param {string} bKey
 * @returns {number}
 */
export function cubeDistance(aKey, bKey) {
  const [aq, ar, as] = parseKey(aKey);
  const [bq, br, bs] = parseKey(bKey);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(as - bs));
}

/** 构建 角名 → 该角 10 格（按到顶点距离升序，同距按键字典序）。 */
function buildCornerCells() {
  /** @type {Record<string, string[]>} */
  const map = {};
  for (const name of CORNER_NAMES) map[name] = [];
  for (const k of ALL_COORDS) {
    const corner = getCornerOfKey(k);
    if (corner) map[corner].push(k);
  }
  for (const name of CORNER_NAMES) {
    const apex = CORNER_APEX[name];
    map[name].sort((a, b) => {
      const da = cubeDistance(a, apex);
      const db = cubeDistance(b, apex);
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (map[name].length !== PIECES_PER_COLOR) {
      throw new Error(`角 ${name} 格数异常: 期望 ${PIECES_PER_COLOR}，实际 ${map[name].length}`);
    }
    Object.freeze(map[name]);
  }
  return Object.freeze(map);
}

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} 角 → 10 个坐标键。 */
export const CORNER_CELLS = buildCornerCells();

/**
 * 判断某坐标是否属于指定角。
 * @param {string} coordKey
 * @param {string} cornerName
 * @returns {boolean}
 */
export function isInCorner(coordKey, cornerName) {
  return getCornerOfKey(coordKey) === cornerName;
}

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} 颜色 → home 10 格。 */
export const HOME_CELLS = Object.freeze({
  red: CORNER_CELLS[COLOR_HOME.red],
  green: CORNER_CELLS[COLOR_HOME.green],
  blue: CORNER_CELLS[COLOR_HOME.blue],
});

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} 颜色 → target 10 格。 */
export const TARGET_CELLS = Object.freeze({
  red: CORNER_CELLS[COLOR_TARGET.red],
  green: CORNER_CELLS[COLOR_TARGET.green],
  blue: CORNER_CELLS[COLOR_TARGET.blue],
});

/** @type {Readonly<Record<string, string>>} 颜色 → target 顶点坐标（兜底推进的参考点）。 */
export const TARGET_APEX = Object.freeze({
  red: CORNER_APEX[COLOR_TARGET.red],
  green: CORNER_APEX[COLOR_TARGET.green],
  blue: CORNER_APEX[COLOR_TARGET.blue],
});

/**
 * 判断坐标是否在某颜色的目标营地内。
 * @param {string} coordKey
 * @param {'red'|'green'|'blue'} color
 * @returns {boolean}
 */
export function isInTarget(coordKey, color) {
  return isInCorner(coordKey, COLOR_TARGET[color]);
}

/**
 * 判断坐标是否在某颜色的出发营地内。
 * @param {string} coordKey
 * @param {'red'|'green'|'blue'} color
 * @returns {boolean}
 */
export function isInHome(coordKey, color) {
  return isInCorner(coordKey, COLOR_HOME[color]);
}

/**
 * 创建空棋盘：**全 121 键**，值均为 null。
 * @returns {Record<string, string|null>}
 */
export function createEmptyBoard() {
  /** @type {Record<string, string|null>} */
  const board = {};
  for (const k of ALL_COORDS) board[k] = null;
  return board;
}

/**
 * 取某坐标的 6 个合法邻居键。
 * @param {string} coordKey
 * @returns {string[]}
 */
export function neighbors(coordKey) {
  const [q, r, s] = parseKey(coordKey);
  /** @type {string[]} */
  const out = [];
  for (const [dq, dr, ds] of DIRECTIONS) {
    const nq = q + dq;
    const nr = r + dr;
    const ns = s + ds;
    if (isValidCoord(nq, nr, ns)) out.push(key(nq, nr, ns));
  }
  return out;
}

/**
 * 立方坐标 → 屏幕像素（pointy-top，原点居中；前端渲染用）。
 * @param {number} q
 * @param {number} r
 * @param {number} [size=26] 单格半径
 * @returns {{x:number, y:number}}
 */
export function coordToPixel(q, r, size = 26) {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * 1.5 * r;
  return { x, y };
}

export default {
  key,
  parseKey,
  isValidCoord,
  isValidKey,
  getCorner,
  getCornerOfKey,
  isInCorner,
  isInTarget,
  isInHome,
  cubeDistance,
  neighbors,
  createEmptyBoard,
  coordToPixel,
  ALL_COORDS,
  COORD_SET,
  CORNER_CELLS,
  HOME_CELLS,
  TARGET_CELLS,
  TARGET_APEX,
};
