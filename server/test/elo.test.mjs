/**
 * ELO 评分单测（建议 3.2）：成对比较法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeEloChanges, DEFAULT_ELO } from '../src/services/elo.js';

test('同分对局：胜者加分、负者减分，总量守恒', () => {
  const changes = computeEloChanges([
    { aiPlayerId: 'a', elo: 1200, rank: 1 },
    { aiPlayerId: 'b', elo: 1200, rank: 2 },
    { aiPlayerId: 'c', elo: 1200, rank: 3 },
  ]);
  const a = changes.get('a');
  const b = changes.get('b');
  const c = changes.get('c');
  assert.ok(a.delta > 0 && c.delta < 0, '胜者加分、季军减分');
  // 两两配对守恒：delta 总和 ≈ 0
  const sum = a.delta + b.delta + c.delta;
  assert.ok(Math.abs(sum) < 0.001, `delta 总和应≈0，实际 ${sum}`);
  assert.ok(a.delta > b.delta, '冠军加分多于亚军');
  assert.equal(a.after, 1200 + Math.round(a.delta));
});

test('以弱胜强：低分胜者收益大于高分胜者', () => {
  const upset = computeEloChanges([
    { aiPlayerId: 'weak', elo: 1000, rank: 1 },
    { aiPlayerId: 'strong', elo: 1400, rank: 2 },
  ]);
  const normal = computeEloChanges([
    { aiPlayerId: 'weak', elo: 1000, rank: 2 },
    { aiPlayerId: 'strong', elo: 1400, rank: 1 },
  ]);
  assert.ok(
    upset.get('weak').delta > normal.get('strong').delta,
    '爆冷净收益应大于强强对话的常规收益',
  );
  // 二人局配对守恒
  assert.ok(
    Math.abs(upset.get('weak').delta + upset.get('strong').delta) < 0.001,
  );
});

test('同名次（如同时未完成）记和局', () => {
  const changes = computeEloChanges([
    { aiPlayerId: 'x', elo: 1200, rank: 2 },
    { aiPlayerId: 'y', elo: 1200, rank: 2 },
  ]);
  assert.equal(changes.get('x').delta, 0);
  assert.equal(changes.get('y').delta, 0);
});

test('非法条目被过滤；单条不变动', () => {
  const one = computeEloChanges([{ aiPlayerId: 'only', elo: 1200, rank: 1 }]);
  assert.equal(one.get('only').delta, 0);
  const filtered = computeEloChanges([
    { aiPlayerId: 'ok', elo: 1200, rank: 1 },
    { aiPlayerId: 'bad', elo: Number.NaN, rank: 2 },
  ]);
  assert.equal(filtered.size, 1);
});

test('DEFAULT_ELO 常量', () => {
  assert.equal(DEFAULT_ELO, 1200);
});

console.log('=== elo 单测全部通过 ===');
