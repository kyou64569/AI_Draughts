import { keyframes, css } from '@emotion/react';

import { BOARD_CELLS, hexPoints, HEX_SIZE } from '../../utils/boardGeometry.js';
import {
  COLOR_DEEP,
  COLOR_FILL,
  COLOR_LIGHT,
  COLOR_STROKE,
  COLOR_TINT,
  SEAT_COLORS,
  WOOD,
} from '../../utils/colors.js';

/* ------------------------------------------------------------------ *
 * 动画（Emotion keyframes）
 * ------------------------------------------------------------------ */

/** 落子脉冲：刚落下的棋子从 1.35 缩放回 1。 */
const dropAnim = keyframes`
  0%   { transform: scale(1.35); opacity: 0.4; }
  60%  { transform: scale(0.9);  opacity: 1; }
  100% { transform: scale(1);    opacity: 1; }
`;

/** 选中棋子持续呼吸。 */
const selectAnim = keyframes`
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.12); }
`;

/** 当前回合方棋子外圈呼吸光晕。 */
const glowAnim = keyframes`
  0%, 100% { opacity: 0.25; r: ${HEX_SIZE * 0.62}px; }
  50%      { opacity: 0.85; r: ${HEX_SIZE * 0.72}px; }
`;

/** 合法落点圆点呼吸。 */
const breatheAnim = keyframes`
  0%, 100% { opacity: 0.45; r: ${HEX_SIZE * 0.24}px; }
  50%      { opacity: 0.95; r: ${HEX_SIZE * 0.32}px; }
`;

const dropCss = css`
  animation: ${dropAnim} 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.15);
  transform-box: fill-box;
  transform-origin: center;
`;

const selectCss = css`
  animation: ${selectAnim} 1.4s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
`;

const glowCss = css`
  animation: ${glowAnim} 1.8s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
`;

const breatheCss = css`
  animation: ${breatheAnim} 1.3s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
`;

const hoverCss = css`
  transition: transform 0.18s ease;
  transform-box: fill-box;
  transform-origin: center;
  &:hover {
    transform: scale(1.1);
  }
`;

/* ------------------------------------------------------------------ *
 * 静态常量
 * ------------------------------------------------------------------ */

/** 棋子主体半径（相对格子）。 */
const PIECE_R = HEX_SIZE * 0.54;
/** 高光几何（相对棋子半径）。 */
const HL = (k) => HEX_SIZE * 0.54 * k;

/** 顶部木纹波浪线（衬底装饰，低透明度，均匀分布）。 */
const WOOD_GRAINS = [
  'M40,120 C 220,108 340,132 560,116 S 880,104 1000,122',
  'M30,210 C 200,198 360,226 580,206 S 900,192 1020,216',
  'M24,306 C 240,292 380,320 600,300 S 920,286 1036,312',
  'M40,408 C 210,394 350,422 570,402 S 880,390 1000,414',
  'M30,506 C 200,492 360,520 580,500 S 900,486 1020,510',
  'M40,600 C 220,588 340,612 560,596 S 880,584 1000,602',
].join(' ');

/**
 * 六角星棋盘渲染（SVG，2026-08-16 木质化视觉升级）。
 * - 深胡桃木渐变衬底 + 木纹波浪线 + 木框描边（桌面光照：顶部受光）；
 * - 格子：每格径向渐变（中心受光微亮 → 边缘暗）形成凹格立体感 + 内框细线；
 * - 棋子：增强立体——亮端渐变 + 底部暗弧（内阴影）+ 同色系轮廓描边 + 双高光；
 * - home 三角暖色 tint 底、target 描边高亮；
 * - 合法落点呼吸圆点；上一手虚线连线；连跳沿路径动画点；
 * - 落子脉冲 / 选中呼吸 / 当前回合光晕 / 人类回合 hover。
 *
 * @param {object|null} game GameState（含 board / turnSeat / history）
 * @param {string|null} selected 当前选中的己方棋子键
 * @param {string[]} legalTargets 合法落点键列表
 * @param {{from:string,to:string,path?:string[]}|null} lastMove 上一手
 * @param {number|null} currentSeat 当前回合座位
 * @param {boolean} interactive 是否可点击（仅人类回合）
 * @param {(key:string)=>void} onCellClick
 */
export default function Board({
  game,
  selected,
  legalTargets,
  lastMove,
  currentSeat,
  interactive,
  onCellClick,
}) {
  const { cells, width, height } = BOARD_CELLS;
  const board = game?.board ?? null;
  const currentColor = currentSeat != null ? SEAT_COLORS[currentSeat] : null;
  const targetSet = new Set(legalTargets || []);
  const moveCount = game?.history?.length ?? 0;

  const cellByKey = new Map(cells.map((c) => [c.key, c]));
  const lastFrom = lastMove ? cellByKey.get(lastMove.from) : undefined;
  const lastTo = lastMove ? cellByKey.get(lastMove.to) : undefined;

  // 连跳路径（path 含中间落点，长度 >= 3 即连跳）
  const jumpPath =
    lastMove?.path && lastMove.path.length >= 3 ? lastMove.path.map((k) => cellByKey.get(k)).filter(Boolean) : [];
  const jumpLine =
    jumpPath.length >= 2
      ? jumpPath
          .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.cx.toFixed(1)} ${c.cy.toFixed(1)}`)
          .join(' ')
      : null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: 1100, maxHeight: '88vh', height: 'auto', touchAction: 'manipulation', display: 'block' }}
      role="img"
      aria-label="中国跳棋棋盘"
    >
      <defs>
        {/* 木纹水平渐变（多 stop 模拟木纹带） */}
        <linearGradient id="wood-h" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={WOOD.mid} />
          <stop offset="14%" stopColor={WOOD.base} />
          <stop offset="16%" stopColor={WOOD.grain} />
          <stop offset="20%" stopColor={WOOD.base} />
          <stop offset="38%" stopColor={WOOD.mid} />
          <stop offset="40%" stopColor={WOOD.grain} />
          <stop offset="44%" stopColor={WOOD.base} />
          <stop offset="62%" stopColor={WOOD.mid} />
          <stop offset="64%" stopColor={WOOD.grain} />
          <stop offset="68%" stopColor={WOOD.base} />
          <stop offset="86%" stopColor={WOOD.mid} />
          <stop offset="88%" stopColor={WOOD.grain} />
          <stop offset="100%" stopColor={WOOD.base} />
        </linearGradient>

        {/* 顶部受光：径向微亮（桌面光照） */}
        <radialGradient id="wood-light" cx="50%" cy="18%" r="90%">
          <stop offset="0%" stopColor={WOOD.glow} stopOpacity="0.75" />
          <stop offset="55%" stopColor="transparent" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.4" />
        </radialGradient>

        {/* 格子：凹格渐变（每格 objectBoundingBox：中心受光 → 边缘暗） */}
        <radialGradient id="cell-grad" cx="50%" cy="46%" r="72%">
          <stop offset="0%" stopColor={WOOD.cellCenter} />
          <stop offset="72%" stopColor={WOOD.cellEdge} />
          <stop offset="100%" stopColor="#1a120a" />
        </radialGradient>

        {/* 棋子：三档立体渐变（顶部受光 → 主色 → 底部深） */}
        {SEAT_COLORS.map((color) => (
          <radialGradient key={color} id={`piece-grad-${color}`} cx="35%" cy="26%" r="82%">
            <stop offset="0%" stopColor={COLOR_LIGHT[color]} />
            <stop offset="32%" stopColor={COLOR_FILL[color]} />
            <stop offset="100%" stopColor={COLOR_DEEP[color]} />
          </radialGradient>
        ))}

        {/* 棋子底部内阴影（下暗，制造球体感） */}
        <linearGradient id="piece-under" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgba(0,0,0,0)" />
          <stop offset="55%" stopColor="rgba(0,0,0,0.10)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
        </linearGradient>

        {/* 棋子投影 */}
        <filter id="piece-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="2.6" stdDeviation="2.6" floodColor="#000" floodOpacity="0.45" />
        </filter>

        {/* 衬底投影（棋盘浮起感） */}
        <filter id="board-shadow" x="-4%" y="-4%" width="108%" height="108%">
          <feDropShadow dx="0" dy="10" stdDeviation="18" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>

      {/* ============ 棋盘衬底（深胡桃木 + 木纹 + 桌面光照） ============ */}
      <rect
        x={8}
        y={8}
        width={width - 16}
        height={height - 16}
        rx={22}
        fill="url(#wood-h)"
        stroke={WOOD.rimStroke}
        strokeWidth={2}
        filter="url(#board-shadow)"
      />
      {/* 木纹波浪线（低透明度装饰） */}
      <path
        d={WOOD_GRAINS}
        fill="none"
        stroke="#000000"
        strokeWidth={1.6}
        strokeLinecap="round"
        opacity={0.16}
        pointerEvents="none"
      />
      <path
        d={WOOD_GRAINS}
        fill="none"
        stroke="#f5e6d0"
        strokeWidth={0.7}
        strokeLinecap="round"
        opacity={0.05}
        pointerEvents="none"
      />
      {/* 桌面光照（顶部受光 + 边缘暗角） */}
      <rect x={8} y={8} width={width - 16} height={height - 16} rx={22} fill="url(#wood-light)" pointerEvents="none" />
      {/* 木框内侧细亮边 */}
      <rect x={10} y={10} width={width - 20} height={height - 20} rx={20} fill="none" stroke="#f5e6d0" strokeOpacity={0.1} strokeWidth={1} pointerEvents="none" />

      {/* ============ 格子与棋子 ============ */}
      {cells.map((c) => {
        const piece = board ? board[c.key] : null;
        const isHome = c.homeColor;
        const isTarget = c.targetColor;
        const isSelected = selected === c.key;
        const isLegalTarget = targetSet.has(c.key);
        const isCurrentPiece = Boolean(currentColor) && piece === currentColor;
        const isLastFrom = lastMove && lastMove.from === c.key;
        const isJustMoved = lastMove && lastMove.to === c.key;

        let stroke = WOOD.cellStroke;
        let strokeWidth = 1;
        let fill = 'url(#cell-grad)';
        if (isHome || isTarget) fill = COLOR_TINT[isHome || isTarget];
        if (isTarget) {
          stroke = COLOR_STROKE[isTarget];
          strokeWidth = 1.6;
        }
        if (isCurrentPiece) {
          stroke = COLOR_STROKE[currentColor];
          strokeWidth = 2.4;
        }
        if (isSelected) {
          stroke = '#fbbf24';
          strokeWidth = 3;
        }
        if (isLegalTarget) {
          stroke = '#fbbf24';
          strokeWidth = 2.5;
        }

        return (
          <g
            key={c.key}
            onClick={() => interactive && onCellClick && onCellClick(c.key)}
            style={{ cursor: interactive ? 'pointer' : 'default' }}
          >
            {/* 格：凹格渐变 + 柔和外描边 */}
            <polygon points={hexPoints(c.cx, c.cy)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
            {/* 格：内框细线（88% 缩放，提升精致度） */}
            {!isSelected && !isLegalTarget && (
              <polygon
                points={hexPoints(c.cx, c.cy, HEX_SIZE * 0.88)}
                fill="none"
                stroke={WOOD.cellInnerStroke}
                strokeWidth={0.8}
                pointerEvents="none"
              />
            )}

            {/* 合法落点：呼吸圆点 */}
            {isLegalTarget && (
              <circle
                key={`legal-${c.key}`}
                cx={c.cx}
                cy={c.cy}
                r={HEX_SIZE * 0.28}
                fill="#fbbf24"
                className={breatheCss}
                pointerEvents="none"
              />
            )}

            {/* 棋子（立体：渐变主体 + 底部暗弧 + 轮廓描边 + 双高光） */}
            {piece && (
              <g
                key={`piece-${c.key}`}
                className={[isJustMoved ? dropCss : '', isSelected ? selectCss : '', interactive && !isSelected ? hoverCss : '']
                  .filter(Boolean)
                  .join(' ')}
                filter="url(#piece-shadow)"
                pointerEvents="none"
              >
                {/* 主体：三档渐变 */}
                <circle
                  cx={c.cx}
                  cy={c.cy}
                  r={PIECE_R}
                  fill={`url(#piece-grad-${piece})`}
                  stroke={COLOR_STROKE[piece]}
                  strokeOpacity={0.55}
                  strokeWidth={1.1}
                />
                {/* 底部暗弧（球体下缘内阴影） */}
                <ellipse
                  cx={c.cx}
                  cy={c.cy + PIECE_R * 0.42}
                  rx={PIECE_R * 0.82}
                  ry={PIECE_R * 0.5}
                  fill="url(#piece-under)"
                />
                {/* 主高光（左上） */}
                <ellipse
                  cx={c.cx - HL(0.16)}
                  cy={c.cy - HL(0.24)}
                  rx={HL(0.19)}
                  ry={HL(0.11)}
                  fill="rgba(255,255,255,0.62)"
                  transform={`rotate(-24 ${c.cx - HL(0.16)} ${c.cy - HL(0.24)})`}
                />
                {/* 次高光（高光下方小点，玻璃质感） */}
                <circle
                  cx={c.cx - HL(0.04)}
                  cy={c.cy - HL(0.1)}
                  r={HL(0.05)}
                  fill="rgba(255,255,255,0.35)"
                />
              </g>
            )}

            {/* 当前回合方棋子：呼吸光晕环 */}
            {piece && isCurrentPiece && !isSelected && (
              <circle
                cx={c.cx}
                cy={c.cy}
                r={HEX_SIZE * 0.62}
                fill="none"
                stroke={COLOR_STROKE[currentColor]}
                strokeWidth={2.5}
                className={glowCss}
                pointerEvents="none"
              />
            )}

            {/* 上一手：from 空心环 */}
            {isLastFrom && (
              <circle
                cx={c.cx}
                cy={c.cy}
                r={HEX_SIZE * 0.6}
                fill="none"
                stroke="#fb923c"
                strokeWidth={2.5}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
          </g>
        );
      })}

      {/* 上一手连线：单步虚线 / 连跳折线 + 移动点 */}
      {lastFrom && lastTo && (
        <line
          x1={lastFrom.cx}
          y1={lastFrom.cy}
          x2={lastTo.cx}
          y2={lastTo.cy}
          stroke="#fb923c"
          strokeWidth={2.5}
          strokeDasharray="6 4"
          opacity={0.75}
          pointerEvents="none"
        />
      )}
      {jumpLine && (
        <g pointerEvents="none">
          <path d={jumpLine} fill="none" stroke="#fb923c" strokeWidth={2.5} strokeDasharray="6 4" opacity={0.75} />
          <circle r={4.5} fill="#fb923c">
            <animateMotion dur="1.4s" repeatCount="indefinite" path={jumpLine} />
          </circle>
        </g>
      )}
    </svg>
  );
}
