/**
 * 棋盘几何（前端渲染用）：移植 server/src/engine/board.js 的立方坐标 → 像素映射。
 * 公式与后端严格一致，保证与 SSE 下发的棋盘坐标对齐。
 */

/** 单格半径（像素）。 */
export const HEX_SIZE = 26;

/**
 * 角名 → home/target 颜色（与后端 constants.js COLOR_HOME/COLOR_TARGET 一致，6 色固定占角）。
 * 未参与对局的角（如 2/3/4 人局）由 Board 按"场内颜色"过滤着色。
 */
const CORNER_HOME = Object.freeze({
  NEG_Q: 'red',
  NEG_R: 'green',
  NEG_S: 'blue',
  POS_Q: 'yellow',
  POS_S: 'purple',
  POS_R: 'orange',
});
/** 角名 → target 颜色（home 的对角）。 */
const CORNER_TARGET = Object.freeze({
  POS_Q: 'red',
  POS_R: 'green',
  POS_S: 'blue',
  NEG_Q: 'yellow',
  NEG_S: 'purple',
  NEG_R: 'orange',
});

/** 坐标 → 键字符串 "q,r,s"。 */
export function key(q, r, s) {
  return `${q},${r},${s}`;
}

/** 键字符串 → [q, r, s]。 */
export function parseKey(k) {
  const p = String(k).split(',');
  return [Number(p[0]), Number(p[1]), Number(p[2])];
}

/** 判断坐标是否在棋盘上（六角星 121 格）。 */
export function isValidCoord(q, r, s) {
  if (!Number.isInteger(q) || !Number.isInteger(r) || !Number.isInteger(s)) return false;
  if (q + r + s !== 0) return false;
  const m = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
  if (m <= 4) return true;
  const A = (x) => x >= 5 && x <= 8;
  const B = (x) => x <= -5 && x >= -8;
  const lo = (x) => x >= -4 && x <= -1;
  const hi = (x) => x >= 1 && x <= 4;
  if (A(q) && lo(r) && lo(s)) return true;
  if (B(q) && hi(r) && hi(s)) return true;
  if (A(r) && lo(q) && lo(s)) return true;
  if (B(r) && hi(q) && hi(s)) return true;
  if (A(s) && lo(q) && lo(r)) return true;
  if (B(s) && hi(q) && hi(r)) return true;
  return false;
}

/** 取坐标所属角名；中心六边形返回 null。 */
export function getCorner(q, r, s) {
  if (!isValidCoord(q, r, s)) return null;
  if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= 4) return null;
  if (q >= 5) return 'POS_Q';
  if (q <= -5) return 'NEG_Q';
  if (r >= 5) return 'POS_R';
  if (r <= -5) return 'NEG_R';
  if (s >= 5) return 'POS_S';
  if (s <= -5) return 'NEG_S';
  return null;
}

/** 立方坐标 → 屏幕像素（pointy-top，原点居中）。 */
export function coordToPixel(q, r, size = HEX_SIZE) {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * 1.5 * r;
  return { x, y };
}

/** 生成全部 121 个合法坐标键（稳定排序）。 */
export const ALL_COORDS = (() => {
  const keys = [];
  for (let q = -8; q <= 8; q += 1) {
    for (let r = -8; r <= 8; r += 1) {
      const s = -q - r;
      if (isValidCoord(q, r, s)) keys.push(key(q, r, s));
    }
  }
  return keys;
})();

/** 预计算渲染单元 + 包围盒（用于 SVG viewBox 居中）。 */
export const BOARD_CELLS = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const tmp = ALL_COORDS.map((k) => {
    const [q, r, s] = parseKey(k);
    const { x, y } = coordToPixel(q, r);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const corner = getCorner(q, r, s);
    return {
      key: k,
      q,
      r,
      s,
      cx: x,
      cy: y,
      homeColor: corner ? CORNER_HOME[corner] ?? null : null,
      targetColor: corner ? CORNER_TARGET[corner] ?? null : null,
    };
  });
  const pad = HEX_SIZE;
  const offsetX = pad - minX;
  const offsetY = pad - minY;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  const cells = tmp.map((c) => ({ ...c, cx: c.cx + offsetX, cy: c.cy + offsetY }));
  return { cells, width, height };
})();

/** 生成 pointy-top 六边形顶点字符串（相对中心 cx,cy）。 */
export function hexPoints(cx, cy, size = HEX_SIZE * 0.92) {
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(cx + size * Math.cos(angle)).toFixed(2)},${(cy + size * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}
