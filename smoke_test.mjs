// End-to-end smoke test for AI-Draughts (backend + frontend)
const B = 'http://localhost:3001';
const F = 'http://localhost:5180';

async function waitFor(url, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok || r.status < 500) { console.log(`  [ok] ${label} reachable (HTTP ${r.status})`); return true; }
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  [FAIL] ${label} not reachable at ${url}`);
  return false;
}

function j(res) { return res.json().catch(() => null); }

/** 清理 smoke-model 测试配置（含历史残留），避免测试数据留在 server/data。 */
async function cleanupSmokeModel() {
  try {
    const list = await fetch(`${B}/api/model-configs`).then(j);
    const items = Array.isArray(list?.data) ? list.data : [];
    const targets = items.filter((c) => c?.name === 'smoke-model');
    for (const t of targets) {
      const r = await fetch(`${B}/api/model-configs/${t.id}`, { method: 'DELETE' });
      console.log(`  [cleanup] DELETE smoke-model (${t.id}) => HTTP ${r.status}`);
    }
    if (targets.length === 0) console.log('  [cleanup] 无 smoke-model 残留');
  } catch (e) {
    console.log(`  [cleanup] 清理失败（可手动删除）: ${e?.message || e}`);
  }
}

(async () => {
  console.log('--- Backend readiness ---');
  const beOk = await waitFor(`${B}/api/rooms`, 'backend /api/rooms');
  if (!beOk) { console.log('BACKEND NOT UP — aborting'); process.exit(2); }

  console.log('--- Backend REST checks ---');
  const rooms = await fetch(`${B}/api/rooms`).then(j);
  console.log('  GET /api/rooms =>', JSON.stringify(rooms));

  const mc = await fetch(`${B}/api/model-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-model', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' })
  }).then(j);
  console.log('  POST /api/model-configs =>', JSON.stringify(mc));

  const players = await fetch(`${B}/api/ai-players`).then(j);
  console.log('  GET /api/ai-players =>', JSON.stringify(players));

  console.log('--- Frontend readiness ---');
  const feOk = await waitFor(F + '/', 'frontend /');
  if (feOk) {
    const html = await fetch(F + '/').then(r => r.text());
    const hasRoot = html.includes('id="root"') || html.toLowerCase().includes('<div id=root');
    console.log('  frontend HTML length:', html.length, '| has #root mount:', hasRoot);
  }

  console.log('--- Smoke test done ---');
  await cleanupSmokeModel();
})().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
