/**
 * 规则引擎 + 结算自测（无测试框架，直接 `node test/engine.test.mjs` 运行）。
 * 覆盖：121 格几何、初始布局、单步、完整连跳、applyMove、回合轮转、
 *       fallbackMove 长程推进、evaluateProgress 名次、endGame 积分公式。
 */
import assert from 'node:assert/strict';

import {
  ALL_COORDS,
  CORNER_CELLS,
  HOME_CELLS,
  TARGET_CELLS,
  createEmptyBoard,
  cubeDistance,
  getCorner,
  isValidCoord,
  key,
  parseKey,
} from '../src/engine/board.js';
import {
  applyMove,
  colorHasAnyLegalMove,
  countInTarget,
  findJumpChains,
  getAllLegalMoves,
  getLegalMoves,
  hasAnyLegalMove,
  isJump,
  ownPieces,
  seatHasAnyLegalMove,
} from '../src/engine/rules.js';
import {
  advanceTurn,
  createGameState,
  createInitialBoard,
  endGame,
  evaluateProgress,
  isAutoPilot,
  markAutoPilotRetry,
  recordMove,
  registerFailure,
  resetFailure,
  shouldRetryAutoPilot,
  unmarkAutoPilot,
} from '../src/engine/game.js';
import { fallbackMove, sanityCheck } from '../src/services/llmDecision.js';
import {
  countFreedAfterMove,
  findCampBlockedForeigners,
  findUnblockMove,
  futureMaxGain,
  isUnblockMove,
} from '../src/engine/fillPlan.js';
import {
  buildPrompt,
  buildCandidateList,
  describeOwnRecentMoves,
  phaseStrategyHint,
  targetDirectionHint,
} from '../src/services/promptBuilder.js';
import {
  AUTO_PILOT_FAIL_THRESHOLD,
  AUTO_PILOT_RETRY_INTERVAL_PLIES,
  COLOR_TARGET,
  PIECES_PER_COLOR,
  SEAT_COLORS,
  STALL_WITHOUT_PROGRESS_PLIES,
  THINKING_TO_EFFORT,
} from '../src/constants.js';

let passed = 0;
let failed = 0;

/**
 * 断言包装：打印每条用例结果。
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message ? err.message : err}`);
  }
}

/**
 * 构造 watch 模式（3 AI）对局状态。
 * @returns {object}
 */
function newWatchState() {
  return createGameState({
    roomId: 'test-room',
    seats: [
      { type: 'ai', aiPlayerId: 'ai-0', name: 'AI-0', model: 'm0', modelConfigId: 'c0' },
      { type: 'ai', aiPlayerId: 'ai-1', name: 'AI-1', model: 'm1', modelConfigId: 'c0' },
      { type: 'ai', aiPlayerId: 'ai-2', name: 'AI-2', model: 'm2', modelConfigId: 'c0' },
    ],
  });
}

console.log('\n=== 1. 棋盘几何（121 格） ===');

test('isValidCoord 生成的坐标集合恰好 121 个', () => {
  let count = 0;
  for (let q = -12; q <= 12; q += 1) {
    for (let r = -12; r <= 12; r += 1) {
      const s = -q - r;
      if (isValidCoord(q, r, s)) count += 1;
    }
  }
  assert.equal(count, 121, `期望 121，实际 ${count}`);
  assert.equal(ALL_COORDS.length, 121);
  assert.equal(new Set(ALL_COORDS).size, 121, '坐标键不应重复');
});

test('全部坐标满足 q+r+s=0，且中心六边形 61 格 + 6 角各 10 格', () => {
  let center = 0;
  const cornerCount = {};
  for (const k of ALL_COORDS) {
    const [q, r, s] = parseKey(k);
    assert.equal(q + r + s, 0, `${k} 不满足 q+r+s=0`);
    const corner = getCorner(q, r, s);
    if (corner == null) center += 1;
    else cornerCount[corner] = (cornerCount[corner] ?? 0) + 1;
  }
  assert.equal(center, 61, `中心六边形应为 61 格，实际 ${center}`);
  assert.equal(Object.keys(cornerCount).length, 6);
  for (const [name, n] of Object.entries(cornerCount)) {
    assert.equal(n, 10, `角 ${name} 应为 10 格，实际 ${n}`);
  }
  assert.equal(61 + 60, 121);
});

test('home/target 角映射正确（red:NEG_Q→POS_Q, green:NEG_R→POS_R, blue:NEG_S→POS_S）', () => {
  assert.equal(COLOR_TARGET.red, 'POS_Q');
  assert.equal(COLOR_TARGET.green, 'POS_R');
  assert.equal(COLOR_TARGET.blue, 'POS_S');
  for (const color of SEAT_COLORS) {
    assert.equal(HOME_CELLS[color].length, 10);
    assert.equal(TARGET_CELLS[color].length, 10);
    // home 与 target 不相交
    const inter = HOME_CELLS[color].filter((k) => TARGET_CELLS[color].includes(k));
    assert.equal(inter.length, 0);
  }
  assert.ok(CORNER_CELLS.POS_Q.includes('8,-4,-4'), '+q 角应含顶点 8,-4,-4');
  assert.ok(CORNER_CELLS.NEG_Q.includes('-8,4,4'), '-q 角应含顶点 -8,4,4');
});

console.log('\n=== 2. 初始布局 ===');

test('初始 board 有 121 键、非空格 30（红/绿/蓝各 10）', () => {
  const board = createInitialBoard();
  assert.equal(Object.keys(board).length, 121);
  const occupied = Object.values(board).filter((v) => v != null);
  assert.equal(occupied.length, 30, `期望 30 子，实际 ${occupied.length}`);
  for (const color of SEAT_COLORS) {
    assert.equal(ownPieces(board, color).length, PIECES_PER_COLOR);
    for (const cell of HOME_CELLS[color]) assert.equal(board[cell], color);
    assert.equal(countInTarget(board, color), 0, '开局时 target 内应为 0 子');
  }
});

test('createGameState 座位→颜色固定 0=red/1=green/2=blue', () => {
  const state = newWatchState();
  assert.equal(state.players.length, 3);
  assert.equal(state.players[0].color, 'red');
  assert.equal(state.players[1].color, 'green');
  assert.equal(state.players[2].color, 'blue');
  assert.equal(state.turnSeat, 0);
  assert.equal(state.status, 'playing');
  assert.deepEqual(state.autoPilotSeats, []);
});

console.log('\n=== 3. 单步与连跳 ===');

test('home 角棋子有合法单步走法', () => {
  const board = createInitialBoard();
  // red home 顶点 -8,4,4 被 3 颗同色包围，取一颗靠近中心的棋子
  let found = 0;
  for (const from of HOME_CELLS.red) {
    const moves = getLegalMoves(board, from);
    if (moves.length > 0) {
      found += 1;
      assert.ok(
        moves.some((p) => p.length === 2),
        `${from} 应存在单步走法`,
      );
      for (const p of moves) {
        assert.equal(p[0], from);
        assert.equal(board[p[p.length - 1]], null, '落点必须为空');
      }
    }
  }
  assert.ok(found >= 3, `至少 3 颗 home 棋子应有走法，实际 ${found}`);
  assert.ok(colorHasAnyLegalMove(board, 'red'));
});

test('单步仅限相邻空位（被同色包住的顶点无单步）', () => {
  const board = createEmptyBoard();
  const center = '0,0,0';
  board[center] = 'red';
  // 6 个邻居全部占满 → 无单步；且后方也占满 → 无跳
  const [q, r, s] = parseKey(center);
  const dirs = [
    [1, -1, 0],
    [-1, 1, 0],
    [1, 0, -1],
    [-1, 0, 1],
    [0, 1, -1],
    [0, -1, 1],
  ];
  for (const [dq, dr, ds] of dirs) {
    board[key(q + dq, r + dr, s + ds)] = 'green';
    board[key(q + 2 * dq, r + 2 * dr, s + 2 * ds)] = 'blue';
  }
  assert.equal(getLegalMoves(board, center).length, 0);
  assert.equal(hasAnyLegalMove(board, center), false);
});

test('findJumpChains 返回完整连跳链（长度≥3，叶子）；连跳可中途停止（标准规则）', () => {
  const board = createEmptyBoard();
  // 沿 +q 方向铺设跳板：0,0,0 起跳，越过 1,-1,0 落 2,-2,0，
  // 再越过 3,-3,0 落 4,-4,0（此处再无子可跳）
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green';
  board['3,-3,0'] = 'blue';

  const chains = findJumpChains(board, '2,-2,0', ['0,0,0', '2,-2,0']);
  assert.equal(chains.length, 1, `应只有一条完整链，实际 ${chains.length}`);
  assert.deepEqual(chains[0], ['0,0,0', '2,-2,0', '4,-4,0']);

  const moves = getLegalMoves(board, '0,0,0');
  // 中途停点合法：跳 1 步停在 2,-2,0 也是一条走法（标准规则：连跳可任意停下）
  assert.ok(
    moves.some((p) => p.length === 2 && p[p.length - 1] === '2,-2,0'),
    '应允许跳 1 步停在 2,-2,0（连跳中途可停）',
  );
  // 完整连跳仍然存在
  assert.ok(
    moves.some((p) => p.length === 3 && p[p.length - 1] === '4,-4,0'),
    '应保留跳到无子可跳的完整链',
  );
});

test('构造 3 段连跳：路径长度 4（起点 + 3 次跳跃）', () => {
  const board = createEmptyBoard();
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green'; // 跳板 1 → 落 2,-2,0
  board['3,-3,0'] = 'green'; // 跳板 2 → 落 4,-4,0
  board['4,-5,1'] = 'green'; // 跳板 3（方向 0,-1,1）→ 落 4,-6,2
  const chains = findJumpChains(board, '2,-2,0', ['0,0,0', '2,-2,0']);
  const best = chains.reduce((a, b) => (b.length > a.length ? b : a), chains[0]);
  assert.ok(best.length >= 4, `应存在长度≥4 的连跳链，实际 ${best.length}`);
  assert.deepEqual(best, ['0,0,0', '2,-2,0', '4,-4,0', '4,-6,2']);
  // 所有返回的链末端都不能再继续跳
  for (const chain of chains) {
    const tail = chain[chain.length - 1];
    const further = findJumpChains(board, tail, chain);
    assert.equal(further.length, 1, '叶子节点应无法继续跳');
    assert.deepEqual(further[0], chain);
  }
});

test('连跳防环：闭合跳板不会无限递归', () => {
  const board = createEmptyBoard();
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green';
  board['3,-3,0'] = 'green';
  board['2,-1,-1'] = 'green';
  board['1,1,-2'] = 'green';
  const moves = getLegalMoves(board, '0,0,0');
  assert.ok(moves.length > 0);
  for (const p of moves) {
    assert.equal(new Set(p).size, p.length, `路径不应重复访问同一格: ${p.join('->')}`);
  }
});

test('同一起点多种连跳方式：跳 1 步停 / 跳 2 步停 / 跳到底都是独立走法', () => {
  const board = createEmptyBoard();
  // 0,0,0 可向两个方向各跳 1 步：+q 方向（越过 1,-1,0 落 2,-2,0，还能续跳 3,-3,0→4,-4,0）
  // 与 -q 方向（越过 -1,1,0 落 -2,2,0，无可续跳）
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green';
  board['3,-3,0'] = 'blue';
  board['-1,1,0'] = 'green';

  const moves = getLegalMoves(board, '0,0,0');
  const endpoints = moves.map((p) => p[p.length - 1]);
  const jumpLen = (to) => moves.find((p) => p[p.length - 1] === to)?.length ?? 0;

  // +q 方向：2,-2,0（跳1步停）与 4,-4,0（跳2步到底）都应可选
  assert.ok(endpoints.includes('2,-2,0'), '应能停在 2,-2,0（跳 1 步停）');
  assert.ok(endpoints.includes('4,-4,0'), '应能跳到 4,-4,0（完整链）');
  assert.equal(jumpLen('2,-2,0'), 2, '2,-2,0 停点路径应为 [0,0,0, 2,-2,0]');
  // -q 方向：-2,2,0（跳 1 步，无可续跳）
  assert.ok(endpoints.includes('-2,2,0'), '应能跳到 -2,2,0');
  // 完整链应有 3 个格
  assert.equal(jumpLen('4,-4,0'), 3);
});

test('applyMove：起点变空、落点变色、中间格不变、不修改原 board', () => {
  const board = createEmptyBoard();
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green';
  const path = ['0,0,0', '2,-2,0'];
  const next = applyMove(board, path);
  assert.equal(next['0,0,0'], null);
  assert.equal(next['2,-2,0'], 'red');
  assert.equal(next['1,-1,0'], 'green', '被跳过的棋子必须保留（不吃子）');
  assert.equal(board['0,0,0'], 'red', '原 board 不应被修改');
  assert.equal(Object.keys(next).length, 121);
});

console.log('\n=== 4. 回合流转 + 兜底长程推进 ===');

test('advanceTurn 0→1→2→0 轮转，并跳过已完成玩家', () => {
  const state = newWatchState();
  assert.equal(state.turnSeat, 0);
  assert.equal(advanceTurn(state), 1);
  assert.equal(advanceTurn(state), 2);
  assert.equal(advanceTurn(state), 0);
  state.players[1].finishTime = new Date().toISOString();
  assert.equal(advanceTurn(state), 2, '应跳过已完成的 seat1');
});

test('fallbackMove 连续推进 60 手：走法始终合法、回合正确轮转、无异常', () => {
  const state = newWatchState();
  const seatSequence = [];
  for (let i = 0; i < 60; i += 1) {
    const seat = state.turnSeat;
    seatSequence.push(seat);
    const decision = fallbackMove(state, seat, 'test-model', '单测');
    assert.ok(decision.path, `第 ${i + 1} 手应有走法`);
    const path = decision.path;
    const color = state.players[seat].color;
    assert.equal(state.board[path[0]], color, '起点必须是本方棋子');
    // 校验该 path 确实在合法走法集合内
    const legal = getLegalMoves(state.board, path[0]);
    assert.ok(
      legal.some((p) => p.length === path.length && p.every((k, idx) => k === path[idx])),
      `第 ${i + 1} 手 ${path.join('->')} 必须是合法走法`,
    );
    state.board = applyMove(state.board, path);
    recordMove(state, seat, path, true);
    const progress = evaluateProgress(state);
    if (progress.finished) break;
    advanceTurn(state);
  }
  assert.equal(state.history.length, 60);
  // 轮转序列应为 0,1,2,0,1,2...
  for (let i = 0; i < seatSequence.length; i += 1) {
    assert.equal(seatSequence[i], i % 3, `第 ${i + 1} 手应由 seat${i % 3} 走`);
  }
  // 60 手后三色棋子数不变
  for (const color of SEAT_COLORS) {
    assert.equal(ownPieces(state.board, color).length, PIECES_PER_COLOR);
  }
});

test('兜底推进使 red 距目标营地的总距离显著下降', () => {
  const state = newWatchState();
  const distSum = (board) =>
    ownPieces(board, 'red').reduce((acc, k) => acc + cubeDistance(k, '8,-4,-4'), 0);
  const before = distSum(state.board);
  for (let i = 0; i < 90; i += 1) {
    const seat = state.turnSeat;
    const decision = fallbackMove(state, seat, 'test-model', '单测');
    if (!decision.path) break;
    state.board = applyMove(state.board, decision.path);
    recordMove(state, seat, decision.path, true);
    if (evaluateProgress(state).finished) break;
    advanceTurn(state);
  }
  const after = distSum(state.board);
  assert.ok(after < before, `red 总距离应下降：before=${before}, after=${after}`);
});

test('纯兜底可把整局推完：三色 10 子全部入营、正常终局并结算', () => {
  const state = newWatchState();
  let plies = 0;
  for (; plies < 3000; plies += 1) {
    const seat = state.turnSeat;
    const decision = fallbackMove(state, seat, 'test-model', '单测');
    if (decision.skip) {
      if (evaluateProgress(state).finished) break;
      advanceTurn(state);
      continue;
    }
    state.board = applyMove(state.board, decision.path);
    recordMove(state, seat, decision.path, true);
    if (evaluateProgress(state).finished) break;
    advanceTurn(state);
  }
  assert.equal(state.status, 'finished', `对局应在 3000 手内结束（实际 ${plies} 手仍未结束）`);
  assert.ok(plies < 1000, `兜底应在千手内完成，实际 ${plies} 手`);
  for (const color of SEAT_COLORS) {
    assert.equal(
      countInTarget(state.board, color),
      PIECES_PER_COLOR,
      `${color} 应 10 子全部入营，实际 ${countInTarget(state.board, color)}`,
    );
  }
  assert.equal(state.scores.length, 3);
  for (const p of state.players) {
    assert.ok([1, 2, 3].includes(p.finishRank), `seat${p.seat} 应有名次`);
    assert.ok(p.finishTime != null);
  }
  assert.deepEqual(
    state.scores.map((s) => s.rank).sort(),
    [1, 2, 3],
    '三个名次应各出现一次',
  );
  for (const s of state.scores) {
    assert.equal(s.base, 1000);
    assert.equal(s.score, Math.max(0, s.base + s.rankBonus - s.timePenalty));
    assert.ok(s.score > 0);
  }
  console.log(
    `        （兜底完局用了 ${state.history.length} 手，名次 ${state.scores
      .map((s) => `${s.color}#${s.rank}:${s.score}`)
      .join(' ')}）`,
  );
});

console.log('\n=== 5. 胜负判定与积分结算 ===');

test('evaluateProgress：某色 10 子入营 → finishRank=1', () => {
  const state = newWatchState();
  // 直接构造：清空 red 的 home，把 10 子放进 target
  for (const cell of HOME_CELLS.red) state.board[cell] = null;
  for (const cell of TARGET_CELLS.red) state.board[cell] = 'red';

  const progress = evaluateProgress(state);
  assert.deepEqual(progress.newlyFinished, [0]);
  assert.equal(state.players[0].finishRank, 1);
  assert.ok(state.players[0].finishTime != null);
  assert.equal(state.players[0].inTarget, 10);
  assert.equal(countInTarget(state.board, 'red'), 10);
  assert.equal(progress.finished, false, 'green/blue 未完成，对局不应结束');
  assert.equal(state.status, 'playing');
});

test('三色全部入营 → 终局，scores 每 seat 一条且符合公式', () => {
  const state = newWatchState();
  state.startedAtMs = Date.now() - 95_000; // 95s → penalty = floor(95/30)*5 = 15
  // red 先完成
  for (const cell of HOME_CELLS.red) state.board[cell] = null;
  for (const cell of TARGET_CELLS.red) state.board[cell] = 'red';
  evaluateProgress(state);
  // green 次之
  for (const cell of HOME_CELLS.green) state.board[cell] = null;
  for (const cell of TARGET_CELLS.green) state.board[cell] = 'green';
  evaluateProgress(state);
  // blue 最后
  for (const cell of HOME_CELLS.blue) state.board[cell] = null;
  for (const cell of TARGET_CELLS.blue) state.board[cell] = 'blue';
  const progress = evaluateProgress(state);

  assert.equal(progress.finished, true);
  assert.equal(state.status, 'finished');
  assert.ok(state.finishedAt != null);
  assert.equal(state.scores.length, 3);

  const bonus = { 1: 300, 2: 150, 3: 50 };
  const penalty = Math.floor(state.totalSeconds / 30) * 5;
  assert.equal(penalty, 15, `95 秒应扣 15 分，实际 ${penalty}`);
  for (const entry of state.scores) {
    assert.ok([0, 1, 2].includes(entry.seat));
    assert.equal(entry.base, 1000, '10 子入营 base 应为 1000');
    assert.equal(entry.timePenalty, penalty);
    assert.equal(entry.rankBonus, bonus[entry.rank]);
    assert.equal(entry.score, Math.max(0, entry.base + bonus[entry.rank] - penalty));
  }
  assert.deepEqual(
    state.scores.map((s) => s.rank),
    [1, 2, 3],
  );
  assert.deepEqual(
    state.scores.map((s) => s.color),
    ['red', 'green', 'blue'],
  );
  // 第 1 名得分：1000 + 300 - 15 = 1285
  assert.equal(state.scores[0].score, 1285);
  assert.equal(state.scores[1].score, 1135);
  assert.equal(state.scores[2].score, 1035);
});

test('未完成者按 target 内子数降序补名次，score 不为负', () => {
  const state = newWatchState();
  state.startedAtMs = Date.now() - 30 * 60 * 1000; // 30 分钟 → penalty = 300
  // red 完成
  for (const cell of HOME_CELLS.red) state.board[cell] = null;
  for (const cell of TARGET_CELLS.red) state.board[cell] = 'red';
  evaluateProgress(state);
  // green 放 4 子入营，blue 放 2 子入营
  for (let i = 0; i < 4; i += 1) {
    state.board[HOME_CELLS.green[i]] = null;
    state.board[TARGET_CELLS.green[i]] = 'green';
  }
  for (let i = 0; i < 2; i += 1) {
    state.board[HOME_CELLS.blue[i]] = null;
    state.board[TARGET_CELLS.blue[i]] = 'blue';
  }
  const ranks = [0];
  const unfinished = [
    { p: state.players[1], inTarget: countInTarget(state.board, 'green') },
    { p: state.players[2], inTarget: countInTarget(state.board, 'blue') },
  ];
  const scores = endGame(state, ranks, unfinished);
  assert.equal(state.status, 'finished');
  assert.equal(scores.length, 3);
  const green = scores.find((s) => s.color === 'green');
  const blue = scores.find((s) => s.color === 'blue');
  assert.equal(green.rank, 2, 'green(4 子) 应排第 2');
  assert.equal(blue.rank, 3, 'blue(2 子) 应排第 3');
  assert.equal(green.base, 400);
  assert.equal(blue.base, 200);
  assert.equal(green.timePenalty, 300);
  assert.equal(green.score, Math.max(0, 400 + 150 - 300));
  for (const s of scores) assert.ok(s.score >= 0, 'score 不应为负');
});

test('死锁判定：无合法走法的未完成者触发终局', () => {
  const state = newWatchState();
  // red 完成
  for (const cell of HOME_CELLS.red) state.board[cell] = null;
  for (const cell of TARGET_CELLS.red) state.board[cell] = 'red';
  // 清掉 green / blue 的全部棋子（模拟"无任何合法走法"）
  for (const cell of HOME_CELLS.green) state.board[cell] = null;
  for (const cell of HOME_CELLS.blue) state.board[cell] = null;
  assert.equal(seatHasAnyLegalMove(state, 1), false);
  assert.equal(seatHasAnyLegalMove(state, 2), false);
  const progress = evaluateProgress(state);
  assert.equal(progress.finished, true, '死锁应触发终局');
  assert.equal(state.status, 'finished');
  assert.equal(state.scores.length, 3);
});

console.log('\n=== 6. 候选走法与提示词 ===');

test('getAllLegalMoves 开局时每色均有走法，且均以本方棋子为起点', () => {
  const board = createInitialBoard();
  for (const color of SEAT_COLORS) {
    const moves = getAllLegalMoves(board, color);
    assert.ok(moves.length > 0, `${color} 开局应有合法走法`);
    for (const p of moves) assert.equal(board[p[0]], color);
  }
});

console.log('\n=== 7. P0：sanityCheck（防原地往返 / 冻结已就位） + prompt 记忆 ===');

test('sanityCheck 拒绝与上一手严格逆向的走法（还原"跳过去又跳回来"）', () => {
  const state = newWatchState();
  // 复现实测 bug：红棋上一手 7,-3,-4 -> 8,-4,-4（进入目标顶点），
  // 下一手又想 8,-4,-4 -> 7,-3,-4 原路返回（真实对局 #46↔#49 的行为）
  state.board['8,-4,-4'] = 'red';
  state.history.push({
    seat: 0,
    from: '7,-3,-4',
    to: '8,-4,-4',
    path: ['7,-3,-4', '8,-4,-4'],
    isFallback: false,
  });
  const result = sanityCheck(state, 0, ['8,-4,-4', '7,-3,-4']);
  assert.equal(result.ok, false, '应拒绝原路返回');
  assert.ok(result.error.includes('上一手起点'), `错误信息应指明原因: ${result.error}`);
});

test('sanityCheck 拒绝移动已就位棋子（营地深前缀冻结）', () => {
  const state = newWatchState();
  // red 占住目标顶点 8,-4,-4（TARGET_CELLS.red 深前缀第一格）→ 该格为 settled
  state.board['8,-4,-4'] = 'red';
  const moves = getLegalMoves(state.board, '8,-4,-4');
  assert.ok(moves.length > 0, '顶点 8,-4,-4 应有合法走法');
  for (const p of moves) {
    const r = sanityCheck(state, 0, p);
    assert.equal(r.ok, false, `${p.join('->')} 应被已就位冻结拒绝`);
    assert.ok(r.error.includes('冻结'), `错误信息应指明冻结: ${r.error}`);
  }
});

test('sanityCheck 放行正常推进走法（非逆向、非已就位）', () => {
  const state = newWatchState();
  // 红棋在途棋子 4,0,-4（不在营地、非 settled），上一手是别的位置
  state.board['4,0,-4'] = 'red';
  state.history.push({
    seat: 0,
    from: '3,1,-4',
    to: '4,0,-4',
    path: ['3,1,-4', '4,0,-4'],
    isFallback: false,
  });
  const moves = getLegalMoves(state.board, '4,0,-4');
  assert.ok(moves.length > 0);
  // 至少存在一条不被拦截的走法
  const allowed = moves.filter((p) => sanityCheck(state, 0, p).ok);
  assert.ok(allowed.length > 0, '应有正常推进走法通过 sanityCheck');
});

test('prompt 注入"你最近的走子"（本座位最近 3 手，跨回合记忆）', () => {
  const state = newWatchState();
  state.history.push(
    { seat: 0, from: '0,0,0', to: '1,-1,0', path: ['0,0,0', '1,-1,0'] },
    { seat: 1, from: '9,9,-9', to: '8,8,-8', path: ['9,9,-9', '8,8,-8'] }, // 其他座位，不应出现
    { seat: 0, from: '1,-1,0', to: '2,-2,0', path: ['1,-1,0', '2,-2,0'] },
  );
  const { messages } = buildPrompt(state, 0);
  const user = messages.find((m) => m.role === 'user').content;
  assert.ok(user.includes('你最近的走子'), 'prompt 应包含本座位最近走子段落');
  assert.ok(user.includes('0,0,0 -> 1,-1,0'), '应包含该座位最近第 1 手');
  assert.ok(user.includes('1,-1,0 -> 2,-2,0'), '应包含该座位最近第 2 手');
  assert.ok(!user.includes('9,9,-9'), '不应混入其他座位的走子');
  assert.ok(user.includes('硬性约束'), 'prompt 应包含防往返/不出营硬性约束');
  // 直接函数级验证
  const desc = describeOwnRecentMoves(state, 0);
  assert.ok(desc.includes('0,0,0 -> 1,-1,0') && desc.includes('1,-1,0 -> 2,-2,0'));
});

console.log('\n=== 8. 目标营地方向提示与候选收益标注 ===');

test('targetDirectionHint：red/green/blue 分别指向 +q/+r/+s 方向', () => {
  assert.ok(targetDirectionHint('red').includes('8,-4,-4'));
  assert.ok(targetDirectionHint('red').includes('q 增大'));
  assert.ok(targetDirectionHint('green').includes('-4,8,-4'));
  assert.ok(targetDirectionHint('green').includes('r 增大'));
  assert.ok(targetDirectionHint('blue').includes('-4,-4,8'));
  assert.ok(targetDirectionHint('blue').includes('s 增大'));
});

test('prompt 注入目标顶点/方向/最深空格（由深到浅）', () => {
  const state = newWatchState();
  const { messages } = buildPrompt(state, 0);
  const user = messages.find((m) => m.role === 'user').content;
  assert.ok(user.includes('目标营地顶点(最深格)与推进方向'), '应给出目标顶点与方向');
  assert.ok(user.includes('8,-4,-4'), 'red 目标顶点应出现在 prompt');
  assert.ok(user.includes('当前应优先填充的营地格'), '应给出最深空格(nextHole)');
  assert.ok(user.includes('必须由深到浅填'), '应强调由深到浅填充');
  assert.ok(user.includes('推进'), '候选清单应带推进收益');
  assert.ok(user.includes('已就位勿动'), '策略提示应包含已就位勿动约束');
});

test('候选清单标注推进收益；已就位棋子标注"已就位勿动"', () => {
  // 开局：red 尚无棋子入营 → 收益标注正常
  const initState = newWatchState();
  const list = buildCandidateList(initState.board, 'red');
  assert.ok(list.text.includes('推进'), `开局候选应含推进收益: ${list.text.slice(0, 120)}`);

  // 已就位：red 占目标顶点 8,-4,-4（深前缀）→ 其走法标"已就位勿动"
  const state = newWatchState();
  state.board['8,-4,-4'] = 'red';
  const settledList = buildCandidateList(state.board, 'red');
  const apexMoves = settledList.moves.filter((p) => p[0] === '8,-4,-4');
  assert.ok(apexMoves.length > 0, '顶点应有合法走法');
  assert.ok(
    settledList.text.includes('已就位勿动'),
    `已就位棋子的走法应标注勿动: ${settledList.text.slice(0, 200)}`,
  );
});

console.log('\n=== 9. 阶段化策略与思考强度 ===');

test('phaseStrategyHint 按 inTarget 分三阶段', () => {
  assert.ok(phaseStrategyHint(0).includes('开局'), 'inTarget<3 应为开局策略');
  assert.ok(phaseStrategyHint(2).includes('开局'));
  assert.ok(phaseStrategyHint(3).includes('中盘'), 'inTarget=3 应为中盘策略');
  assert.ok(phaseStrategyHint(7).includes('中盘'));
  assert.ok(phaseStrategyHint(8).includes('收尾'), 'inTarget>=8 应为收尾策略');
  assert.ok(phaseStrategyHint(10).includes('收尾'));
});

test('buildPrompt 按阶段注入对应策略提示', () => {
  // 开局（red 未入营）
  const open = newWatchState();
  const openUser = buildPrompt(open, 0).messages.find((m) => m.role === 'user').content;
  assert.ok(openUser.includes('【开局阶段】'), '开局局面应注入开局策略');
  assert.ok(!openUser.includes('【收尾阶段】'));

  // 收尾（red 8 子入营）
  const end = newWatchState();
  const TARGET_RED = TARGET_CELLS.red;
  for (let i = 0; i < 8; i += 1) {
    end.board[TARGET_RED[i]] = null;
    end.board[TARGET_RED[i]] = 'red';
  }
  const endUser = buildPrompt(end, 0).messages.find((m) => m.role === 'user').content;
  assert.ok(endUser.includes('【收尾阶段】'), '收尾局面应注入收尾策略');
});

test('THINKING_TO_EFFORT 映射正确（default 不传）', () => {
  assert.equal(THINKING_TO_EFFORT.off, 'minimal');
  assert.equal(THINKING_TO_EFFORT.low, 'low');
  assert.equal(THINKING_TO_EFFORT.medium, 'medium');
  assert.equal(THINKING_TO_EFFORT.high, 'high');
  assert.equal(THINKING_TO_EFFORT.default, undefined, 'default 不应透传 reasoning_effort');
});

console.log('\n=== 10. 连跳偏好修正（收益最大化，不"为了连跳而倒退"） ===');

test('fallbackMove 不选负收益连跳（存在正收益走法时）', () => {
  const state = newWatchState();
  // 清空 red 开局棋子，只留两颗用于精确构造
  for (const k of Object.keys(state.board)) {
    if (state.board[k] === 'red') state.board[k] = null;
  }
  // red A：靠近营地但向反方向连跳（收益为负，绕远路）
  state.board['6,-4,-2'] = 'red';
  state.board['5,-4,-1'] = 'green'; // 跳板 → 落 4,-4,0（远离顶点）
  state.board['3,-3,0'] = 'blue'; // 跳板 → 落 2,-2,0（更远）
  // red B：单步接近营地（收益为正）
  state.board['5,-3,-2'] = 'red';

  const decision = fallbackMove(state, 0, 'test-model', '单测');
  assert.ok(decision.path, '应有走法');
  // 不应选择 A 的反方向负收益连跳（6,-4,-2 出发且跳 2 次以上）
  const isBadJump = decision.path[0] === '6,-4,-2' && decision.path.length > 2;
  assert.ok(!isBadJump, `不应选择反方向的负收益连跳: ${decision.path.join('->')}`);
  // 落点应相对起点更接近目标营地（推进收益 ≥ 0）
  // 注意括号：`??` 优先级低于 `>=`，写成 `decision.gain ?? 0 >= 0` 会解析为
  // `decision.gain ?? (0 >= 0)` 而恒真，使本断言失效。
  assert.ok((decision.gain ?? 0) >= 0, '不应选择负收益走法');
});

test('候选清单按推进收益降序排列（收益最大排最前，已就位勿动排最后）', () => {
  const board = createEmptyBoard();
  // 0,0,0：+q 方向连跳收益最大；-q 方向跳收益为负
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'green';
  board['3,-3,0'] = 'blue';
  board['-1,1,0'] = 'green';
  // 已就位棋子：占目标顶点（settled）→ 勿动排最后
  board['8,-4,-4'] = 'red';

  const list = buildCandidateList(board, 'red');
  const lines = list.text.split('\n').filter(Boolean);
  assert.ok(lines[0].startsWith('0,0,0->4,-4,0'), `收益最大的连跳应排第一: ${lines[0]}`);
  const idxSettled = lines.findIndex((l) => l.includes('已就位勿动'));
  assert.ok(idxSettled > 0, '应存在已就位勿动行');
  // 已就位（勿动）的走法必须排在全部正常收益行之后（收益置 -∞ 排最后）
  for (let i = idxSettled; i < lines.length; i += 1) {
    assert.ok(lines[i].includes('已就位勿动'), `第 ${i + 1} 行之后应全部为已就位勿动: ${lines[i]}`);
  }
});

console.log('\n=== 11. 铺路前瞻（未来 1 回合） ===');

test('futureMaxGain：走一步后本方可获得的最大下一手收益', () => {
  const board = createEmptyBoard();
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'red'; // 跳板（己方棋子也可作跳板）
  board['3,-3,0'] = 'blue';
  // 0,0,0 完整链：跳过 1,-1,0 到 2,-2,0，再跳过 3,-3,0 到 4,-4,0（gain 8-4=4）
  assert.equal(futureMaxGain(board, 'red'), 4);
});

test('候选清单标注"后续+N"（铺路潜力）', () => {
  const board = createEmptyBoard();
  board['0,0,0'] = 'red';
  board['1,-1,0'] = 'red';
  board['3,-3,0'] = 'blue';
  const list = buildCandidateList(board, 'red');
  assert.ok(list.text.includes('后续+'), `候选应标注后续潜力: ${list.text.slice(0, 160)}`);
});

test('铺路前瞻：当前收益小但能为下回合创造大收益的走法被选中', () => {
  const state = newWatchState();
  for (const k of Object.keys(state.board)) {
    if (state.board[k] === 'red') state.board[k] = null;
  }
  // A 在 0,0,0（当前无跳板，只能单步）；X 在 2,-2,0
  // 铺路走法：A 单步到 1,-1,0（当前收益 1）→ 下回合 A 可跳过 X 到 2,-2,0（收益 2）
  state.board['0,0,0'] = 'red';
  state.board['2,-2,0'] = 'red';

  const decision = fallbackMove(state, 0, 'test-model', '单测');
  assert.deepEqual(
    decision.path,
    ['0,0,0', '1,-1,0'],
    '应选择铺路走法（当前收益小但下回合收益大），而非其它同收益单步',
  );
});

console.log('\n=== 12. 多人数模式（2/4/6 人） ===');

import { MODE_SEAT_COLORS } from '../src/constants.js';

function newStateFor(colors) {
  return createGameState({
    roomId: 'test-room',
    seats: colors.map((color, i) => ({ type: 'ai', color, aiPlayerId: `ai-${i}`, name: `AI-${i}`, model: 'm', modelConfigId: 'c' })),
  });
}

test('6 色营地几何：HOME/TARGET 各 6 组×10 格，home 互不重叠且 target 为对角', () => {
  const colors = ['red', 'green', 'blue', 'yellow', 'purple', 'orange'];
  const seenHome = new Set();
  for (const color of colors) {
    assert.equal(HOME_CELLS[color].length, 10, `${color} home 10 格`);
    assert.equal(TARGET_CELLS[color].length, 10, `${color} target 10 格`);
    for (const cell of HOME_CELLS[color]) {
      assert.ok(!seenHome.has(cell), `home 格 ${cell} 重复`);
      seenHome.add(cell);
    }
  }
  assert.equal(seenHome.size, 60, '六角共 60 个营地格');
  // target 为 home 的对角：red target = yellow home（yellow home 在 POS_Q）
  assert.deepEqual([...TARGET_CELLS.red].sort(), [...HOME_CELLS.yellow].sort());
});

test('2 人局：红黄对角布局（各 10 子，其余角落为空）', () => {
  const state = newStateFor(MODE_SEAT_COLORS[2]);
  assert.equal(state.seatCount, 2);
  assert.deepEqual(state.players.map((p) => p.color), ['red', 'yellow']);
  const pieceCount = Object.values(state.board).filter((v) => v != null).length;
  assert.equal(pieceCount, 20, '2 人局共 20 子');
  for (const cell of HOME_CELLS.red) assert.equal(state.board[cell], 'red');
  for (const cell of HOME_CELLS.yellow) assert.equal(state.board[cell], 'yellow');
  // 未参战角落必须为空
  for (const cell of [...HOME_CELLS.green, ...HOME_CELLS.blue]) {
    assert.equal(state.board[cell], null, `非参战角 ${cell} 应为空`);
  }
  // red 的 target 是 yellow 的 home（POS_Q 对角局）
  assert.equal(countInTarget(state.board, 'red'), 0);
});

test('4 人局：两组对角、座位交替，未用角为空', () => {
  const colors = MODE_SEAT_COLORS[4];
  const state = newStateFor(colors);
  assert.equal(Object.values(state.board).filter((v) => v != null).length, 40);
  for (const color of colors) {
    for (const cell of HOME_CELLS[color]) assert.equal(state.board[cell], color, `${color} home 已填`);
  }
  // 未参战颜色 green/orange 的角落为空
  for (const cell of [...HOME_CELLS.green, ...HOME_CELLS.orange]) {
    assert.equal(state.board[cell], null);
  }
  // 回合一圈回到原座位
  advanceTurn(state);
  advanceTurn(state);
  advanceTurn(state);
  advanceTurn(state);
  assert.equal(state.turnSeat, 0, '4 人回合轮转一圈');
});

test('6 人局：全角落座，回合轮转遍历全部座位', () => {
  const colors = MODE_SEAT_COLORS[6];
  const state = newStateFor(colors);
  assert.equal(state.seatCount, 6);
  assert.equal(Object.values(state.board).filter((v) => v != null).length, 60);
  const visited = new Set([state.turnSeat]);
  for (let i = 0; i < 6; i += 1) visited.add(advanceTurn(state));
  assert.equal(visited.size, 6, '6 个座位都被轮到');
  assert.equal(state.turnSeat, 0);
});

test('2 人局兜底整局收敛：双方向对角推进直至全部入营', () => {
  const state = newStateFor(MODE_SEAT_COLORS[2]);
  let finished = false;
  let guard = 0;
  for (; guard < 6000; guard += 1) {
    if (state.status === 'finished') {
      finished = true;
      break;
    }
    const seat = state.turnSeat;
    const player = state.players[seat];
    if (player.finishTime != null) {
      advanceTurn(state);
      continue;
    }
    if (!colorHasAnyLegalMove(state.board, player.color)) {
      // 该座位无合法走法 → 记一条空跳过并轮转（与调度器 skipTurn 语义一致）
      advanceTurn(state);
      continue;
    }
    const decision = fallbackMove(state, seat, 'test', '兜底');
    if (!decision.path) {
      advanceTurn(state);
      continue;
    }
    state.board = applyMove(state.board, decision.path);
    recordMove(state, seat, decision.path, true);
    const progress = evaluateProgress(state);
    if (!progress.finished) advanceTurn(state);
  }
  assert.ok(finished, `2 人局应在上限内完成（guard=${guard}, 手数=${state.history.length}）`);
  assert.equal(state.endReason, 'all_finished');
  assert.ok(state.scores.length === 2 && state.scores[0].rank === 1);
});

/**
 * 用兜底算法跑完整局，并返回「连续无入营」的最大间隔。
 * maxGap 用于校验 stall 阈值不会被正常对局触及（阈值过小会把正常对局误杀）。
 * @param {readonly string[]} colors
 * @param {number} [maxGuard]
 */
function runFallbackGame(colors, maxGuard = 6000) {
  const state = newStateFor(colors);
  let guard = 0;
  let lastProgressPly = 0;
  let maxGap = 0;
  let prevTotal = 0;
  for (; guard < maxGuard; guard += 1) {
    if (state.status === 'finished') break;
    const seat = state.turnSeat;
    const player = state.players[seat];
    if (player.finishTime != null) {
      advanceTurn(state);
      continue;
    }
    if (!colorHasAnyLegalMove(state.board, player.color)) {
      advanceTurn(state);
      continue;
    }
    const decision = fallbackMove(state, seat, 'test', '兜底');
    if (!decision.path) {
      advanceTurn(state);
      continue;
    }
    state.board = applyMove(state.board, decision.path);
    recordMove(state, seat, decision.path, true);
    const finished = evaluateProgress(state).finished;
    const total = state.players.reduce((s, p) => s + p.inTarget, 0);
    if (total > prevTotal) {
      maxGap = Math.max(maxGap, state.history.length - lastProgressPly);
      lastProgressPly = state.history.length;
      prevTotal = total;
    }
    if (!finished) advanceTurn(state);
  }
  return { state, guard, maxGap };
}

test('4 人局兜底整局收敛，且不触及 stall 阈值', () => {
  const { state, guard, maxGap } = runFallbackGame(MODE_SEAT_COLORS[4]);
  assert.equal(
    state.status,
    'finished',
    `4 人局应在上限内完成（guard=${guard}, 手数=${state.history.length}）`,
  );
  assert.equal(state.endReason, 'all_finished', `不应被误杀（实际 ${state.endReason}）`);
  assert.equal(state.scores.length, 4);
  assert.ok(
    maxGap < STALL_WITHOUT_PROGRESS_PLIES,
    `正常对局最大无入营间隔 ${maxGap} 手必须小于阈值 ${STALL_WITHOUT_PROGRESS_PLIES} 手`,
  );
});

test('6 人局兜底整局收敛：不会被无进展停滞误杀（回归）', () => {
  // 回归用例：6 人局 60 子，开局约需 48 手才有第一枚棋子入营。
  // 曾因 STALL_WITHOUT_PROGRESS_PLIES=40，导致每局都在第 40 手被 stall 终局
  // 且全部 0 子入营。含次优走法时实测"连续无入营"上界约 71 手，故阈值须留裕度。
  const { state, guard, maxGap } = runFallbackGame(MODE_SEAT_COLORS[6]);
  assert.equal(
    state.status,
    'finished',
    `6 人局应在上限内完成（guard=${guard}, 手数=${state.history.length}）`,
  );
  assert.equal(state.endReason, 'all_finished', `不应被 stall 误杀（实际 ${state.endReason}）`);
  assert.equal(state.scores.length, 6);
  for (const p of state.players) {
    assert.equal(p.inTarget, PIECES_PER_COLOR, `座位 ${p.seat}(${p.color}) 应全部入营`);
  }
  assert.ok(
    maxGap < STALL_WITHOUT_PROGRESS_PLIES,
    `正常对局最大无入营间隔 ${maxGap} 手必须小于阈值 ${STALL_WITHOUT_PROGRESS_PLIES} 手`,
  );
});

test('createGameState 拒绝非法颜色、重复颜色与不支持的人数', () => {
  // 非法色：曾导致 [...TARGET_CELLS[color]] 抛 TypeError（500 且无有效信息）
  assert.throws(
    () =>
      createGameState({
        roomId: 'r',
        seats: [{ type: 'ai', color: 'gold' }, { type: 'ai', color: 'blue' }],
      }),
    /颜色非法/,
  );
  // 同色：两个座位共控同 10 子，countInTarget 与胜负判定完全串台
  assert.throws(
    () =>
      createGameState({
        roomId: 'r',
        seats: [{ type: 'ai', color: 'red' }, { type: 'ai', color: 'red' }],
      }),
    /颜色重复/,
  );
  // 5 人不在 PLAYER_COUNTS(2/3/4/6) 内，必须拒绝而非静默接受
  assert.throws(
    () =>
      createGameState({
        roomId: 'r',
        seats: [1, 2, 3, 4, 5].map((i) => ({ type: 'ai', aiPlayerId: `a${i}` })),
      }),
    /座位数必须是/,
  );
});

test('托管恢复：连续失败进入托管 → 每 N 手重试一次 → 成功移出托管', () => {
  const state = newWatchState();
  const seat = 0;
  let res = null;
  for (let i = 0; i < AUTO_PILOT_FAIL_THRESHOLD; i += 1) res = registerFailure(state, seat);
  assert.equal(res.autoPilot, true, '连续 3 次失败应进入托管');
  assert.ok(isAutoPilot(state, seat));
  assert.equal(shouldRetryAutoPilot(state, seat), false, '刚进入托管不应立即重试');
  // 推进 N-1 手仍不重试，第 N 手允许
  for (let i = 0; i < AUTO_PILOT_RETRY_INTERVAL_PLIES - 1; i += 1) recordMove(state, 1, ['a', 'b']);
  assert.equal(shouldRetryAutoPilot(state, seat), false, '不足 N 手不重试');
  recordMove(state, 1, ['a', 'b']);
  assert.equal(shouldRetryAutoPilot(state, seat), true, '满 N 手允许重试');
  markAutoPilotRetry(state, seat);
  assert.equal(shouldRetryAutoPilot(state, seat), false, '重试后重新计时（失败也不会每手打 LLM）');
  // 重试成功 → 移出托管并清零失败计数；对未托管座位是空操作
  unmarkAutoPilot(state, seat);
  assert.ok(!isAutoPilot(state, seat), '恢复成功应移出托管');
  assert.equal(state.failCounts[seat] ?? 0, 0, '恢复成功应清零连续失败计数');
  resetFailure(state, seat);
  unmarkAutoPilot(state, seat);
  assert.ok(!isAutoPilot(state, seat));
});

test('让位：外族棋子被困于我方目标营地 → 检测/解困/兜底让位/sanity 豁免', () => {
  // 2 人局几何：yellow 的目标营地 = red 的出发营地（对角）。
  // 构造"满营困子"：营地 10 格 = 己方 9 枚 + 对方 1 枚困在顶点（无任何出口）。
  const buildApex = (cells) =>
    cells.reduce((a, b) => (cubeDistance(b, '0,0,0') > cubeDistance(a, '0,0,0') ? b : a));
  const yellowCamp = CORNER_CELLS[COLOR_TARGET.yellow];
  const yellowApex = buildApex(yellowCamp);
  const redCamp = CORNER_CELLS[COLOR_TARGET.red];
  const redApex = buildApex(redCamp);
  const board = createEmptyBoard();
  for (const c of yellowCamp) board[c] = c === yellowApex ? 'red' : 'yellow';
  for (const c of redCamp) board[c] = c === redApex ? 'yellow' : 'red';

  // ① 被困检测：双方各有一枚对方棋子被困在自己目标营地的顶点
  assert.deepEqual(findCampBlockedForeigners(board, 'yellow'), [yellowApex]);
  assert.deepEqual(findCampBlockedForeigners(board, 'red'), [redApex]);

  // ② 让位选路：走一步即可让对方顶点棋子恢复脱困能力
  const blocked = findCampBlockedForeigners(board, 'yellow');
  const unblock = findUnblockMove(board, 'yellow', blocked);
  assert.ok(unblock, '应存在让位走法');
  assert.ok(countFreedAfterMove(board, 'yellow', unblock.path, blocked) >= 1);
  assert.ok(isUnblockMove(board, 'yellow', unblock.path));

  // ③ 兜底走让位分支（seat1 = yellow）
  const state = createGameState({
    roomId: 'test-unblock',
    seats: [
      { type: 'ai', aiPlayerId: 'a0', name: 'R', model: 'm', modelConfigId: 'c' },
      { type: 'ai', aiPlayerId: 'a1', name: 'Y', model: 'm', modelConfigId: 'c' },
    ],
  });
  state.board = board;
  const decision = fallbackMove(state, 1, 'm', 'test');
  assert.ok(decision.path, '让位分支应产出走法');
  assert.ok(countFreedAfterMove(board, 'yellow', decision.path, blocked) >= 1, '兜底应选择让位走法');
  assert.ok(String(decision.log.reason).includes('让位'));

  // ④ sanity 豁免：让位走法放行，非让位的已就位走法仍拒绝
  const campMoves = [];
  for (const c of yellowCamp) {
    if (board[c] === 'yellow') campMoves.push(...getLegalMoves(board, c));
  }
  const freeing = campMoves.find((p) => countFreedAfterMove(board, 'yellow', p, blocked) > 0);
  const nonFreeing = campMoves.find((p) => countFreedAfterMove(board, 'yellow', p, blocked) === 0);
  assert.ok(freeing && nonFreeing, '场景应同时包含让位与非让位的营地走法');
  assert.equal(sanityCheck(state, 1, freeing).ok, true);
  assert.equal(sanityCheck(state, 1, nonFreeing).ok, false);
});

test('无进展停滞：连续 STALL_WITHOUT_PROGRESS_PLIES 手无棋子入营 → 以 stall 终局（不再拖到手数上限）', () => {
  const state = createGameState({
    roomId: 'test-stall',
    seats: [
      { type: 'ai', aiPlayerId: 'a0', name: 'R', model: 'm', modelConfigId: 'c' },
      { type: 'ai', aiPlayerId: 'a1', name: 'Y', model: 'm', modelConfigId: 'c' },
    ],
  });
  // 放一枚红子入营：第一手产生进展，此后再无任何入营
  state.board[TARGET_CELLS.red[0]] = 'red';
  recordMove(state, 0, ['a', 'b']);
  assert.equal(evaluateProgress(state).finished, false, '刚有进展不应终局');
  let finished = false;
  for (let guard = 0; guard < STALL_WITHOUT_PROGRESS_PLIES + 5 && !finished; guard += 1) {
    recordMove(state, 1, ['c', 'd']);
    finished = evaluateProgress(state).finished;
  }
  assert.ok(finished, '应在停滞上限内终局');
  assert.equal(state.endReason, 'stall');
  assert.ok(
    state.history.length <= STALL_WITHOUT_PROGRESS_PLIES + 2,
    `不应拖到手数上限（实际 ${state.history.length} 手）`,
  );
});

test('让位 prompt：候选标注"让位"置顶 + 硬约束条件放宽（开局不误报）', () => {
  const mkSeats = () => [
    { type: 'ai', aiPlayerId: 'a0', name: 'R', model: 'm', modelConfigId: 'c' },
    { type: 'ai', aiPlayerId: 'a1', name: 'Y', model: 'm', modelConfigId: 'c' },
  ];
  const apex = (cells) =>
    cells.reduce((a, b) => (cubeDistance(b, '0,0,0') > cubeDistance(a, '0,0,0') ? b : a));
  const yellowCamp = CORNER_CELLS[COLOR_TARGET.yellow];

  // 满营困子场景：yellow 目标营地 9 黄 + 红 1（困在顶点）
  const yApex = apex(yellowCamp);
  const board = createEmptyBoard();
  for (const c of yellowCamp) board[c] = c === yApex ? 'red' : 'yellow';
  const rApex = apex(CORNER_CELLS[COLOR_TARGET.red]);
  for (const c of CORNER_CELLS[COLOR_TARGET.red]) board[c] = c === rApex ? 'yellow' : 'red';
  const state = createGameState({ roomId: 'test-unblock-prompt', seats: mkSeats() });
  state.board = board;

  // 候选清单：让位走法置顶并带"让位"标注
  const { text } = buildCandidateList(board, 'yellow');
  const firstLine = text.slice(0, text.indexOf('\n'));
  assert.ok(firstLine.includes('让位'), `首条候选应为让位走法：${firstLine}`);

  // prompt：让位场景下硬约束被替换为让位指引
  const { messages } = buildPrompt(state, 1, {});
  const userMsg = messages[1].content;
  assert.ok(userMsg.includes('让位'), 'user 消息应包含让位指引');
  assert.ok(!userMsg.includes('已进入目标营地的棋子不得离开营地'), '原营地约束应被替换');

  // 开局初始棋盘（营地被对方满员占据但其队友可自解）不触发让位口径
  const normal = createGameState({ roomId: 'test-normal-prompt', seats: mkSeats() });
  const normalPrompt = buildPrompt(normal, 1, {});
  assert.ok(
    normalPrompt.messages[1].content.includes('已进入目标营地的棋子不得离开营地'),
    '无困子时应维持原硬约束',
  );
});

console.log('');
console.log(`=== 汇总：PASS ${passed} / FAIL ${failed} ===`);
if (failed > 0) process.exit(1);
