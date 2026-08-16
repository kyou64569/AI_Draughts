/**
 * 颜色映射（座位 → 颜色 / 中文名 / 十六进制填充色）。
 * 与后端 server/src/constants.js 的 SEAT_COLORS / COLOR_LABELS 保持一致。
 *
 * 2026-08 视觉重构：棋子主色切换为更鲜亮的现代色；
 * 棋子立体渐变（高光/深端）在 Board.jsx 内部由 COLOR_FILL/COLOR_DEEP/COLOR_LIGHT 派生。
 * 2026-08-16 棋盘木质化升级：新增 WOOD 深胡桃木调色板，与棋子形成冷暖对比。
 */

/** 座位序号 → 颜色（seat0=red、seat1=green、seat2=blue）。 */
export const SEAT_COLORS = ['red', 'green', 'blue'];

/** 颜色 → 中文名。 */
export const COLOR_LABELS = Object.freeze({ red: '红', green: '绿', blue: '蓝' });

/** 颜色 → 棋子主填充色（十六进制）。 */
export const COLOR_FILL = Object.freeze({
  red: '#f43f5e',
  green: '#10b981',
  blue: '#38bdf8',
});

/** 颜色 → 棋子渐变亮端（顶部受光面，用于立体渐变第一 stop）。 */
export const COLOR_LIGHT = Object.freeze({
  red: '#fda4af',
  green: '#6ee7b7',
  blue: '#7dd3fc',
});

/** 颜色 → 棋子渐变深端（径向渐变底部，制造立体感）。 */
export const COLOR_DEEP = Object.freeze({
  red: '#9f1239',
  green: '#065f46',
  blue: '#075985',
});

/** 颜色 → home/target 三角底色（半透明 tint，透出木纹）。 */
export const COLOR_TINT = Object.freeze({
  red: 'rgba(244, 63, 94, 0.18)',
  green: 'rgba(16, 185, 129, 0.18)',
  blue: 'rgba(56, 189, 248, 0.18)',
});

/** 颜色 → 描边色（target 高亮 / 当前回合高亮 / 棋子轮廓）。 */
export const COLOR_STROKE = Object.freeze({
  red: '#fb7185',
  green: '#34d399',
  blue: '#60a5fa',
});

/**
 * 深胡桃木棋盘调色板（2026-08-16）。
 * - 木底：偏暖的深棕渐变，与深色主题协调，与红/绿/蓝棋子形成冷暖对比；
 * - 格子：暖棕半透明，中央微亮（凹格受光感），透出下层木纹。
 */
export const WOOD = Object.freeze({
  /** 衬底最深处。 */
  base: '#241a10',
  /** 衬底中调。 */
  mid: '#3d2b1c',
  /** 木纹浅带。 */
  grain: '#57402a',
  /** 衬底受光面（顶部光照）。 */
  glow: '#4e3a26',
  /** 格子中心（受光）。 */
  cellCenter: 'rgba(63, 45, 28, 0.92)',
  /** 格子边缘（暗）。 */
  cellEdge: 'rgba(28, 20, 12, 0.96)',
  /** 格子柔和外描边。 */
  cellStroke: 'rgba(255, 214, 170, 0.07)',
  /** 格子内框暗线。 */
  cellInnerStroke: 'rgba(0, 0, 0, 0.28)',
  /** 衬底描边（木框）。 */
  rimStroke: 'rgba(190, 140, 90, 0.28)',
});

/** 空位填充色（兼容旧引用，Board 已改用 WOOD.cellCenter/cellEdge 渐变）。 */
export const EMPTY_FILL = '#241a10';

/** 座位色名（如 "红方"）。 */
export function seatLabel(seat) {
  const color = SEAT_COLORS[seat] ?? 'red';
  return `${COLOR_LABELS[color] ?? color}方`;
}

/** 颜色中文名。 */
export function colorLabel(color) {
  return COLOR_LABELS[color] ?? color;
}

/** 取颜色的十六进制填充色（带兜底）。 */
export function colorFill(color) {
  return COLOR_FILL[color] ?? EMPTY_FILL;
}
