import assert from 'node:assert/strict';
import store from '../src/store.js';

async function testStore() {
  console.log('=== 测试 Store 内存缓存与持久化 ===');

  // 1. 读取集合
  const initial = await store.loadCollection('modelConfigs');
  assert(Array.isArray(initial), 'loadCollection 应当返回数组');
  console.log('  PASS loadCollection 成功');

  // 2. 插入记录
  const testId = store.newId();
  const testItem = {
    id: testId,
    name: 'test-config-' + Date.now(),
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test',
    models: ['model-a', 'model-b'],
    createdAt: store.nowIso(),
    updatedAt: store.nowIso(),
  };

  await store.insertItem('modelConfigs', testItem);
  const found = await store.findById('modelConfigs', testId);
  assert.equal(found?.id, testId, '插入后应当能被 findById 查到');
  console.log('  PASS insertItem & findById 成功');

  // 3. 更新记录
  const updated = await store.updateItem('modelConfigs', testId, {
    models: ['model-a', 'model-b', 'model-c'],
  });
  assert.equal(updated?.models?.length, 3, '更新后的 models 长度应为 3');
  const foundUpdated = await store.findById('modelConfigs', testId);
  assert.equal(foundUpdated?.models?.length, 3, 'findById 应拿到更新后的 models');
  console.log('  PASS updateItem 成功');

  // 4. 条件更新
  const condRes = await store.updateItemIf(
    'modelConfigs',
    testId,
    (curr) => curr.models.length === 3,
    { name: 'renamed-test' }
  );
  assert.equal(condRes.updated, true, '条件满足应当更新成功');
  assert.equal(condRes.item.name, 'renamed-test', '名称应当更新');
  console.log('  PASS updateItemIf 成功');

  // 5. 并发快速更新
  const concurrentP = Array.from({ length: 10 }).map((_, i) =>
    store.updateItem('modelConfigs', testId, {
      testSeq: i,
      updatedAt: store.nowIso(),
    })
  );
  await Promise.all(concurrentP);
  const finalItem = await store.findById('modelConfigs', testId);
  assert(finalItem != null, '并发更新后数据应当存在');
  console.log('  PASS 并发写入排队防冲突 成功');

  // 6. 删除测试记录
  const removed = await store.removeItem('modelConfigs', testId);
  assert.equal(removed, true, '应当删除成功');
  const afterRemove = await store.findById('modelConfigs', testId);
  assert.equal(afterRemove, null, '删除后应当查不到');
  console.log('  PASS removeItem 成功');

  console.log('=== Store 全部测试通过 ===');
}

testStore().catch((err) => {
  console.error('Store 测试失败:', err);
  process.exit(1);
});
