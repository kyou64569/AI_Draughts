/**
 * SSE 连接管理：按 roomId 维护连接注册表，向房间广播事件。
 * 事件名固定为 `state` / `log` / `room` / `finished`（architecture.md §3.4）。
 */
import config from '../config.js';

/** @type {Map<string, Set<import('express').Response>>} roomId → 响应流集合。 */
const clients = new Map();

/** @type {NodeJS.Timeout|null} 全局心跳定时器（懒启动）。 */
let heartbeatTimer = null;

/**
 * 启动心跳（15s 一次注释帧，防代理断流）。
 * @returns {void}
 */
function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const [roomId, set] of clients) {
      for (const res of set) {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          set.delete(res);
        }
      }
      if (set.size === 0) clients.delete(roomId);
    }
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, config.sseHeartbeatMs);
  // 不阻止进程退出
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

/**
 * 注册一个 SSE 客户端。
 * @param {string} roomId
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function addClient(roomId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`: connected ${roomId}\n\n`);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!clients.has(roomId)) clients.set(roomId, new Set());
  clients.get(roomId).add(res);
  ensureHeartbeat();

  const cleanup = () => removeClient(roomId, res);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

/**
 * 移除客户端。
 * @param {string} roomId
 * @param {import('express').Response} res
 * @returns {void}
 */
export function removeClient(roomId, res) {
  const set = clients.get(roomId);
  if (!set) return;
  set.delete(res);
  try {
    res.end();
  } catch {
    /* 已断开 */
  }
  if (set.size === 0) clients.delete(roomId);
}

/**
 * 向房间广播事件。
 * @param {string} roomId
 * @param {'state'|'log'|'room'|'finished'} event
 * @param {any} data JSON 可序列化负载
 * @returns {number} 实际写出的连接数
 */
export function broadcast(roomId, event, data) {
  const set = clients.get(roomId);
  if (!set || set.size === 0) return 0;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
  let sent = 0;
  const failed = [];
  for (const res of [...set]) {
    try {
      res.write(payload);
      sent += 1;
    } catch {
      failed.push(res);
    }
  }
  // 统一清理失败的连接：交由 removeClient（delete + res.end()），避免只从集合
  // 移除却不结束响应，导致 socket 残留直到超时（与 removeClient 自身保持一致）。
  for (const res of failed) {
    removeClient(roomId, res);
  }
  if (set.size === 0) clients.delete(roomId);
  return sent;
}

/**
 * 某房间当前连接数。
 * @param {string} roomId
 * @returns {number}
 */
export function countClients(roomId) {
  return clients.get(roomId)?.size ?? 0;
}

/**
 * 关闭某房间的全部连接。
 * @param {string} roomId
 * @returns {void}
 */
export function closeRoom(roomId) {
  const set = clients.get(roomId);
  if (!set) return;
  for (const res of [...set]) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  clients.delete(roomId);
}

export default { addClient, removeClient, broadcast, countClients, closeRoom };
