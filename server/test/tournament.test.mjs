/**
 * 锦标赛单测（建议 2.3）：赛程生成与积分榜聚合。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeStandings, generateMatches } from '../src/services/tournament.js';

test('generateMatches：3 人 1 轮 → 恰好 1 场', () => {
  const m = generateMatches(['a', 'b', 'c'], 1);
  assert.equal(m.length, 1);
  assert.deepEqual([...m[0].seatAiPlayerIds].sort(), ['a', 'b', 'c']);
  assert.equal(m[0].status, 'pending');
});

test('generateMatches：4 人 1 轮 → C(4,3)=4 场，全员覆盖', () => {
  const m = generateMatches(['a', 'b', 'c', 'd'], 1);
  assert.equal(m.length, 4);
  const counts = Object.fromEntries(['a', 'b', 'c', 'd'].map((x) => [x, 0]));
  for (const match of m) {
    assert.equal(new Set(match.seatAiPlayerIds).size, 3, '每场三人不重复');
    for (const id of match.seatAiPlayerIds) counts[id] += 1;
  }
  assert.deepEqual(counts, { a: 3, b: 3, c: 3, d: 3 }, '每人出场次数均衡');
});

test('generateMatches：2 轮场次翻倍且座位轮换', () => {
  const m = generateMatches(['a', 'b', 'c'], 2);
  assert.equal(m.length, 2);
  assert.notDeepEqual(m[0].seatAiPlayerIds, m[1].seatAiPlayerIds, '第二轮座位应轮换');
});

test('generateMatches：去重与封顶', () => {
  const dup = generateMatches(['a', 'a', 'b', 'c'], 1);
  assert.equal(dup.length, 1);
  const capped = generateMatches(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3);
  assert.ok(capped.length <= 30, `超过封顶: ${capped.length}`);
});

test('computeStandings：按总分/均名次排序，聚合冠亚季', () => {
  const tournament = {
    aiPlayerIds: ['a', 'b', 'c'],
    matches: [
      {
        status: 'finished',
        result: [
          { aiPlayerId: 'a', rank: 1, score: 1000 },
          { aiPlayerId: 'b', rank: 2, score: 800 },
          { aiPlayerId: 'c', rank: 3, score: 600 },
        ],
      },
      {
        status: 'finished',
        result: [
          { aiPlayerId: 'b', rank: 1, score: 1100 },
          { aiPlayerId: 'c', rank: 2, score: 700 },
          { aiPlayerId: 'a', rank: 3, score: 500 },
        ],
      },
      { status: 'pending', result: null },
    ],
  };
  const standings = computeStandings(tournament, [
    { id: 'a', name: 'A', model: 'm-a', elo: 1210 },
    { id: 'b', name: 'B', model: 'm-b', elo: 1190 },
    { id: 'c', name: 'C', model: 'm-c', elo: 1200 },
  ]);
  assert.equal(standings.length, 3);
  assert.equal(standings[0].aiPlayerId, 'b', 'B 总分 1900 最高');
  assert.equal(standings[1].aiPlayerId, 'a');
  assert.equal(standings[2].aiPlayerId, 'c');
  const b = standings[0];
  assert.deepEqual({ played: b.played, first: b.first, second: b.second, third: b.third }, {
    played: 2,
    first: 1,
    second: 1,
    third: 0,
  });
  assert.equal(b.totalScore, 1900);
  assert.equal(b.elo, 1190);
  assert.equal(b.avgRank, 1.5);
});

console.log('=== tournament 单测全部通过 ===');
