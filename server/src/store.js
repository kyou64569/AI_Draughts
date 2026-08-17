/**
 * 持久化层：内存缓存（高速读写）+ 项目内 JSON 文件（server/data/*.json）异步弹性持久化 + 活跃对局内存 Map。
 *
 * 架构设计：
 * 1. 内存常驻缓存（In-Memory Cache）：
 *    - 读操作（loadCollection / findById）直接从内存高速返回，完全避免频繁打开磁盘文件句柄；
 *    - 彻底根除 Windows 下"后端自身并发读写竞争文件锁"的问题。
 * 2. 内存优先写 + 弹性异步刷盘：
 *    - 写操作（insertItem / updateItem / removeItem / saveCollection）先原子更新内存缓存；
 *    - 随后异步将最新快照串行刷写到磁盘文件（带有指数退避重试与原子重命名/直接覆盖多重容灾）；
 *    - 即使外部进程（如杀毒软件、IDE 文件监视器、系统索引）瞬时锁定文件，也不会阻断业务或丢失内存状态。
 * 3. `toPublicModelConfig()` 是 API Key 不外泄的唯一出口（architecture.md §3.2）。
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

/** @type {Map<string, object[]>} 内存缓存：集合名 -> 数据项数组。 */
const memoryCache = new Map();

/** @type {Map<string, boolean>} 标记集合是否已从磁盘预热/初始化。 */
const initialized = new Map();

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
 * 清理数据目录中的残留 *.tmp（启动时调用）。
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
 */
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * 在指定集合的串行队列上执行任务。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
function enqueue(name, fn) {
  const prev = queues.get(name) ?? Promise.resolve();
  const task = prev.then(fn);
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
 * 磁盘读取文件内容。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {Promise<object[]>}
 */
async function readDiskFileItems(name) {
  const fp = filePathOf(name);
  try {
    const text = await fs.readFile(fp, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      try {
        await fs.writeFile(fp, '[]\n', 'utf8');
      } catch {
        /* 忽略写入失败 */
      }
      return [];
    }
    if (err instanceof SyntaxError) {
      console.error(`[store] JSON 文件损坏，已重置为空数组: ${fp}`, err.message);
      await ensureDataDir();
      try {
        await fs.writeFile(fp, '[]\n', 'utf8');
      } catch {
        /* 忽略写入失败 */
      }
      return [];
    }
    throw err;
  }
}

/**
 * 初始化集合缓存（如果尚未初始化）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {Promise<object[]>}
 */
async function ensureLoaded(name) {
  if (initialized.get(name)) {
    return memoryCache.get(name) ?? [];
  }
  return enqueue(name, async () => {
    if (initialized.get(name)) {
      return memoryCache.get(name) ?? [];
    }
    const items = await readDiskFileItems(name);
    memoryCache.set(name, items);
    initialized.set(name, true);
    return items;
  });
}

/**
 * Windows 高弹性原子写文件（临时文件 + 重命名 + 直接写兜底 + 指数退避重试）。
 * @param {string} fp 目标文件路径
 * @param {string} data 待写入文本
 */
async function resilientWriteFile(fp, data) {
  await ensureDataDir();
  const dir = path.dirname(fp);
  const base = path.basename(fp);
  const tmpFp = path.join(dir, `.${base}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`);

  let lastErr = null;
  // 最多重试 8 次，指数退避，覆盖外部程序（杀软/IDE）瞬时占用窗口（总计约 3~5 秒）
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      // 策略 1：写临时文件再 rename
      await fs.writeFile(tmpFp, data, 'utf8');
      try {
        await fs.rename(tmpFp, fp);
        return;
      } catch (renameErr) {
        // Windows 上如果 rename 遇到文件占用 (EPERM / EBUSY / EACCES)，降级为直接覆写目标文件
        try {
          await fs.writeFile(fp, data, 'utf8');
          await fs.unlink(tmpFp).catch(() => {});
          return;
        } catch (directErr) {
          await fs.unlink(tmpFp).catch(() => {});
          throw directErr;
        }
      }
    } catch (err) {
      lastErr = err;
      await fs.unlink(tmpFp).catch(() => {});
      const delayMs = Math.min(1000, Math.floor(50 * Math.pow(1.6, attempt)));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * 将集合内存数据刷盘持久化。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {{throwOnError?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function persistCollection(name, options = {}) {
  const fp = filePathOf(name);
  const items = memoryCache.get(name) ?? [];
  const text = `${JSON.stringify(items, null, 2)}\n`;
  try {
    await resilientWriteFile(fp, text);
  } catch (err) {
    console.error(`[store] 持久化 ${name} 失败 (已保留内存状态):`, err?.code || err?.message);
    if (options?.throwOnError) {
      throw new Error(`写入 ${name} 失败（数据文件可能被其他程序锁定）`);
    }
  }
}

/**
 * 读取集合（直接从内存缓存读取；首次未初始化则预热）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @returns {Promise<object[]>}
 */
export async function loadCollection(name) {
  await ensureLoaded(name);
  const items = memoryCache.get(name) ?? [];
  return [...items];
}

/**
 * 覆盖写入集合（同步更新内存，并入队异步刷盘）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {object[]} items
 * @param {{throwOnError?: boolean}} [options]
 * @returns {Promise<object[]>}
 */
export async function saveCollection(name, items, options = {}) {
  await ensureLoaded(name);
  const cloned = Array.isArray(items) ? [...items] : [];
  memoryCache.set(name, cloned);
  initialized.set(name, true);
  return enqueue(name, async () => {
    await persistCollection(name, options);
    return cloned;
  });
}

/**
 * 按 id 查找集合内元素。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(name, id) {
  await ensureLoaded(name);
  const items = memoryCache.get(name) ?? [];
  return items.find((it) => it.id === id) ?? null;
}

/**
 * 向集合追加一条记录（内存立即更新，入队异步刷盘）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {object} item
 * @returns {Promise<object>} 追加的记录
 */
export async function insertItem(name, item) {
  await ensureLoaded(name);
  return enqueue(name, async () => {
    const items = [...(memoryCache.get(name) ?? [])];
    items.push(item);
    memoryCache.set(name, items);
    // 持久化失败不抛错（内存已生效）：创建类操作返回 500 会诱导前端重试产生重复数据；
    // 后续任意写操作都会全量刷盘，最终一致。
    await persistCollection(name);
    return item;
  });
}

/**
 * 更新集合内某条记录（内存立即更新，入队异步刷盘）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>} 更新后的记录；不存在返回 null
 */
export async function updateItem(name, id, patch) {
  await ensureLoaded(name);
  return enqueue(name, async () => {
    const items = [...(memoryCache.get(name) ?? [])];
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const merged = { ...items[idx], ...patch, id: items[idx].id };
    items[idx] = merged;
    memoryCache.set(name, items);
    await persistCollection(name, { throwOnError: true });
    return merged;
  });
}

/**
 * 删除集合内某条记录（内存立即更新，入队异步刷盘）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function removeItem(name, id) {
  await ensureLoaded(name);
  return enqueue(name, async () => {
    const items = [...(memoryCache.get(name) ?? [])];
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    items.splice(idx, 1);
    memoryCache.set(name, items);
    await persistCollection(name, { throwOnError: true });
    return true;
  });
}

/**
 * 条件更新：仅当 predicate(current) 为真时才合并 patch（内存与队列原子执行）。
 * @param {keyof typeof COLLECTION_FILES} name
 * @param {string} id
 * @param {(current:object)=>boolean} predicate 返回 false 则不更新
 * @param {object} patch
 * @returns {Promise<{updated:boolean, item:object|null}>}
 */
export async function updateItemIf(name, id, predicate, patch) {
  await ensureLoaded(name);
  return enqueue(name, async () => {
    const items = memoryCache.get(name) ?? [];
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return { updated: false, item: null };
    const current = items[idx];
    if (!predicate(current)) return { updated: false, item: current };
    const merged = { ...current, ...patch, id: current.id };
    items[idx] = merged;
    memoryCache.set(name, items);
    await persistCollection(name, { throwOnError: true });
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
 * 移除活跃对局。
 * @param {string} gameId
 * @returns {boolean}
 */
export function dropGame(gameId) {
  return activeGames.delete(gameId);
}

/**
 * 启动自愈：把"status=playing 但对应 game 不在内存"的孤儿房间标记回 setup。
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
 * @param {object} state 已 finished 的 GameState
 * @returns {Promise<object>} 归档记录
 */
export async function archiveGame(state) {
  await ensureLoaded('games');
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
    const items = memoryCache.get('games') ?? [];
    const idx = items.findIndex((it) => it.id === record.id);
    if (idx >= 0) items[idx] = record;
    else items.push(record);
    memoryCache.set('games', items);
    await persistCollection('games', { throwOnError: true });
    return record;
  });
}

/**
 * 从归档查找对局记录（按 gameId，其次 roomId）。
 * @param {string|null} gameId
 * @param {string|null} roomId
 * @returns {Promise<object|null>}
 */
export async function findArchivedGame(gameId, roomId) {
  const items = await loadCollection('games');
  if (gameId) {
    const byId = items.find((it) => it.id === gameId);
    if (byId) return byId;
  }
  if (roomId) {
    const byRoom = items.find((it) => it.roomId === roomId);
    if (byRoom) return byRoom;
  }
  return null;
}

export default {
  newId,
  nowIso,
  ensureDataDir,
  cleanupStaleTmp,
  loadCollection,
  saveCollection,
  findById,
  findArchivedGame,
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
