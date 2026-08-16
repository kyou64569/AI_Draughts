/**
 * 持久化层：项目内 JSON 文件（server/data/*.json）+ 活跃对局内存 Map。
 *
 * - 低频写数据（模型配置 / AI 玩家 / 房间元数据 / 终局历史）→ JSON 文件；
 * - 活跃对局 GameState（每步高频变更）→ 内存 Map，终局后归档进 games.json。
 * - 所有写操作按文件串行化（简单 promise 链），避免并发写导致 JSON 截断。
 * - `toPublicModelConfig()` 是 API Key 不外泄的唯一出口（architecture.md §3.2）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import config from './config.js';

/** 支持的集合名 → 文件名。 */
const COLLECTION_FILES = Object.freeze({
  modelConfigs: 'modelConfigs.json',
  aiPlayers: 'aiPlayers.json',
  rooms: 'rooms.json',
  games: 'games.json',
});

/** @type {Map<string, object>} 活跃对局：gameId → GameState（内存态）。 */
const activeGames = new Map();

/**
 * 生成唯一 id（Node 22 内置 crypto.randomUUID）。
 * @returns {string}
 */
export function newId() {
  return randomUUID();
}

/**
 * 当前时间的 ISO 字符串。
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 取集合对应的绝对文件路径。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {string}
 */
function filePathOf(name) {
  const file = COLLECTION_FILES[name];
  if (!file) throw new Error(`未知集合: ${name}`);
  return path.join(config.dataDir, file);
}

/**
 * 确保数据目录存在。
 * @returns {Promise<void>}
 */
export async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/**
 * 清理数据目录中的残留 *.tmp（旧"tmp+rename"策略遗留；残留 tmp 会成为
 * 文件锁的诱因）。启动时调用一次即可。
 * @returns {Promise<number>} 清理数量
 */
export async function cleanupStaleTmp() {
  const dir = config.dataDir;
  try {
    const names = await fs.readdir(dir);
    let removed = 0;
    for (const n of names) {
      if (n.endsWith('.tmp')) {
        try {
          await fs.unlink(path.join(dir, n));
          removed += 1;
        } catch {
          /* 单个失败忽略 */
        }
      }
    }
    if (removed > 0) console.log(`[store] 已清理 ${removed} 个残留 .tmp 文件`);
    return removed;
  } catch {
    return 0;
  }
}

/**
 * 集合级串行队列（每集合一条 promise 链）。
 *
 * 为什么读也要排队：Windows 下 Node fs 打开文件的共享模式**不含 FILE_SHARE_DELETE**，
 * 若 `rename(tmp, fp)` 时目标文件 fp 恰好被另一个 readFile 句柄打开，会直接 EPERM——
 * 这就是"后端自身并发读写"制造文件锁的根源（拉取模型写 modelConfigs 与前端轮询读
 * modelConfigs 并发时必现）。读写走同一队列后，rename 时不再有并发读句柄。
 */
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * 在指定集合的串行队列上执行任务。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>} 原始任务（错误向调用方传播）
 */
function enqueue(name, fn) {
  const prev = queues.get(name) ?? Promise.resolve();
  const task = prev.then(fn);
  // 队列链始终存"已捕获"的哨兵，避免一个失败任务让后续所有读写断链；
  // 调用方 await 的是原始 task，仍能感知并处理错误。
  queues.set(
    name,
    task.then(
      () => {},
      () => {},
    ),
  );
  return task;
}

/**
 * 裸读文件（不排队；由调用方保证已入队或单次使用）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {Promise<object[]>}
 */
async function readFileItems(name) {
  const fp = filePathOf(name);
  try {
    const text = await fs.readFile(fp, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      await fs.writeFile(fp, '[]\n', 'utf8');
      return [];
    }
    if (err instanceof SyntaxError) {
      // 文件损坏：记录错误并重置为空集合，避免整个服务不可用。
      console.error(`[store] JSON 文件损坏，已重置为空数组: ${fp}`, err.message);
      await ensureDataDir();
      await fs.writeFile(fp, '[]\n', 'utf8');
      return [];
    }
    throw err;
  }
}

/**
 * 读取集合（与写入共用同一串行队列，避免并发读写造成 Windows 文件锁）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {Promise<object[]>}
 */
export function loadCollection(name) {
  return enqueue(name, () => readFileItems(name));
}

/**
 * 覆盖写入文件（直接 writeFile，退避重试）。
 *
 * 为什么放弃"tmp + rename"原子写：Windows 上 `rename` 要求目标文件**无任何打开句柄
 *（包括读句柄）**，而杀毒/防护软件的实时扫描正是"短暂打开读句柄"——rename 必然 EPERM，
 * 这是本项目"经常被锁定"而其他项目（直接 writeFile）从不失败的根因。
 * 直接覆盖写只要求目标具有 WRITE 共享（读句柄不挡），与本项目单进程串行写、小文件
 * （<10KB）场景匹配，失败率大幅降低。
 * @param {string} fp 目标文件路径
 * @param {string} data 待写入内容
 */
async function atomicWriteFile(fp, data) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.writeFile(fp, data, 'utf8');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); // 150/300/450ms
    }
  }
  throw lastErr;
}

/**
 * 覆盖写入集合（与读取共用同一串行队列，串行化 + 临时文件原子替换 + Windows 文件锁兜底）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {object[]} items
 * @param {{throwOnError?:boolean}} [options] throwOnError=true 时写失败直接抛错（供删除/更新等
 *   "用户显式操作"感知失败并返回 500）；默认 false 保持向后兼容（写失败仅记日志、不拖垮进程）。
 * @returns {Promise<object[]>} 写入的集合
 */
export function saveCollection(name, items, options = {}) {
  return enqueue(name, () => writeFileItems(name, items, options));
}

/**
 * 裸写文件（不排队；由调用方保证已入队）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {object[]} items
 * @param {{throwOnError?:boolean}} options
 * @returns {Promise<object[]>}
 */
async function writeFileItems(name, items, options) {
  const fp = filePathOf(name);
  try {
    await ensureDataDir();
    await atomicWriteFile(fp, `${JSON.stringify(items, null, 2)}\n`);
  } catch (err) {
    console.error(`[store] 写入 ${name} 失败:`, err?.code || err?.message);
    if (options?.throwOnError) {
      throw new Error(`写入 ${name} 失败（数据文件可能被其他程序锁定）`);
    }
  }
  return items;
}

/**
 * 按 id 查找集合内元素。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(name, id) {
  const items = await loadCollection(name);
  return items.find((it) => it.id === id) ?? null;
}

/**
 * 向集合追加一条记录（读-改-写在队列内原子执行）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {object} item
 * @returns {Promise<object>} 追加的记录
 */
export function insertItem(name, item) {
  return enqueue(name, async () => {
    const items = await readFileItems(name);
    items.push(item);
    await writeFileItems(name, items, { throwOnError: true });
    return item;
  });
}

/**
 * 更新集合内某条记录（浅合并，读-改-写在队列内原子执行）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>} 更新后的记录；不存在返回 null
 */
export function updateItem(name, id, patch) {
  return enqueue(name, async () => {
    const items = await readFileItems(name);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const merged = { ...items[idx], ...patch, id: items[idx].id };
    items[idx] = merged;
    await writeFileItems(name, items, { throwOnError: true });
    return merged;
  });
}

/**
 * 删除集合内某条记录（读-改-写在队列内原子执行）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @returns {Promise<boolean>} 是否删除成功
 */
export function removeItem(name, id) {
  return enqueue(name, async () => {
    const items = await readFileItems(name);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    items.splice(idx, 1);
    await writeFileItems(name, items, { throwOnError: true });
    return true;
  });
}

/**
 * 条件更新：仅当 predicate(current) 为真时才合并 patch（读-改-写在队列内原子执行）。
 *
 * 用于「检查前置条件 + 写入」必须原子的场景——例如开赛：必须在同一队列任务内
 * 确认 room.status 仍为 setup 才翻转为 playing，否则两个并发的 /start 请求会各自
 * 通过外层的只读检查、各自创建对局，最后一个 updateItem 覆盖 gameId，留下孤儿对局。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @param {(current:object)=>boolean} predicate 返回 false 则不更新
 * @param {object} patch
 * @returns {Promise<{updated:boolean, item:object|null}>} updated=false 时 item 为当前记录（供调用方判断冲突原因）；记录不存在时 item 为 null
 */
export function updateItemIf(name, id, predicate, patch) {
  return enqueue(name, async () => {
    const items = await readFileItems(name);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return { updated: false, item: null };
    const current = items[idx];
    if (!predicate(current)) return { updated: false, item: current };
    const merged = { ...current, ...patch, id: current.id };
    items[idx] = merged;
    await writeFileItems(name, items, { throwOnError: true });
    return { updated: true, item: merged };
  });
}

/* ------------------------------------------------------------------ *
 * ModelConfig 专用
 * ------------------------------------------------------------------ */

/**
 * 转为可安全下发前端的对象：**剔除 apiKey**，仅暴露 modelCount。
 * @param {object} cfg 内部 ModelConfig
 * @returns {{id:string,name:string,baseUrl:string,modelCount:number,createdAt:string,updatedAt:string,hasApiKey:boolean}}
 */
export function toPublicModelConfig(cfg) {
  const models = Array.isArray(cfg?.models) ? cfg.models : [];
  return {
    id: cfg.id,
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    modelCount: models.length,
    createdAt: cfg.createdAt ?? null,
    updatedAt: cfg.updatedAt ?? null,
    hasApiKey: Boolean(cfg.apiKey),
  };
}

/* ------------------------------------------------------------------ *
 * 活跃对局（内存）
 * ------------------------------------------------------------------ */

/**
 * 写入/更新活跃对局。
 * @param {object} state GameState
 * @returns {object} 同一个 state 引用
 */
export function putGame(state) {
  activeGames.set(state.id, state);
  return state;
}

/**
 * 取活跃对局。
 * @param {string} gameId
 * @returns {object|null}
 */
export function getGame(gameId) {
  return activeGames.get(gameId) ?? null;
}

/**
 * 移除活跃对局（一般在归档后调用；本项目保留以便前端复看，故默认不调用）。
 * @param {string} gameId
 * @returns {boolean}
 */
export function dropGame(gameId) {
  return activeGames.delete(gameId);
}

/**
 * 启动自愈：把"status=playing 但对应 game 不在内存"的孤儿房间标记回 setup。
 *
 * 背景：对局状态（GameState）仅存内存，服务重启即丢失；而房间元数据持久化在
 * rooms.json。若不加自愈，重启后会出现"房间显示进行中、但进入牌桌无对局"
 * 的不一致（用户视角：查看牌桌 → 游戏尚未开始）。
 *
 * 处理：状态改回 setup、清空 gameId/startedAt（座位配置保留，可直接重新开赛）。
 * @returns {Promise<number>} 修复的房间数
 */
export async function repairOrphanRooms() {
  const rooms = await loadCollection('rooms');
  let repaired = 0;
  const fixed = rooms.map((room) => {
    if (room.status === 'playing' && (room.gameId == null || !activeGames.has(room.gameId))) {
      repaired += 1;
      return {
        ...room,
        status: 'setup',
        gameId: null,
        startedAt: null,
        updatedAt: nowIso(),
      };
    }
    return room;
  });
  if (repaired > 0) {
    await saveCollection('rooms', fixed);
    console.log(`[store] 启动自愈：${repaired} 个孤儿 playing 房间已标记回 setup`);
  }
  return repaired;
}

/**
 * 列出全部活跃对局。
 * @returns {object[]}
 */
export function listGames() {
  return [...activeGames.values()];
}

/**
 * 终局归档到 games.json（P2-2 历史对局）。
 *
 * 读-改-写在同一条队列任务内原子执行（与 insertItem/updateItem/removeItem 一致）：
 * 此前用「loadCollection 读 → saveCollection 写」两次独立入队，两个对局同时归档时
 * 各自读到旧快照，后写覆盖前写会丢掉其中一条归档记录。
 * @param {object} state 已 finished 的 GameState
 * @returns {Promise<object>} 归档记录
 */
export function archiveGame(state) {
  const record = {
    id: state.id,
    roomId: state.roomId ?? null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? nowIso(),
    status: state.status,
    players: state.players.map((p) => ({
      seat: p.seat,
      color: p.color,
      kind: p.kind,
      aiPlayerId: p.aiPlayerId ?? null,
      name: p.name ?? null,
      model: p.model ?? null,
      finishRank: p.finishRank ?? null,
      finishTime: p.finishTime ?? null,
    })),
    scores: state.scores ?? [],
    endReason: state.endReason ?? null,
    moveCount: Array.isArray(state.history) ? state.history.length : 0,
    autoPilotSeats: state.autoPilotSeats ?? [],
  };
  return enqueue('games', async () => {
    const items = await readFileItems('games');
    const idx = items.findIndex((it) => it.id === record.id);
    if (idx >= 0) items[idx] = record;
    else items.push(record);
    await writeFileItems('games', items);
    return record;
  });
}

export default {
  newId,
  nowIso,
  ensureDataDir,
  cleanupStaleTmp,
  loadCollection,
  saveCollection,
  findById,
  insertItem,
  updateItem,
  updateItemIf,
  removeItem,
  toPublicModelConfig,
  putGame,
  getGame,
  dropGame,
  listGames,
  archiveGame,
  repairOrphanRooms,
};
