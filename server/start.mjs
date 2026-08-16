/**
 * 一键启动脚本（跨平台，基于 Node，无需 bash）。
 *
 * 功能：
 *  - 自动探测一个未被占用的端口（从 START_PORT 或 PORT 或 3001 起递增）。
 *  - 若已显式设置 PORT 环境变量，则跳过探测、直接使用该端口。
 *  - 以该端口启动后端服务（node src/index.js），并打印访问地址。
 *  - 监听 Ctrl+C / 终止信号，干净退出子进程。
 *
 * 用法：
 *   node start.mjs              # 自动寻找可用端口（默认从 3001 起）
 *   START_PORT=3100 node start.mjs   # 从 3100 起探测
 *   PORT=3005 node start.mjs    # 强制使用 3005（若被占用会启动失败）
 */

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = path.dirname(__filename);
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');
const MAX_TRIES = 200;
/** 单实例锁文件（Windows 下端口探测因 SO_REUSEADDR 语义不可靠，改用原子锁文件）。 */
const LOCK_FILE = path.join(SERVER_ROOT, 'data', '.backend.lock');

/**
 * 获取单实例锁：`wx` 原子独占创建，失败说明已有实例在运行。
 * 锁文件残留但 PID 已死时自动接管（进程崩溃场景）。
 * @returns {{pid:number, isOwner:boolean}}
 */
function acquireLock() {
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return { pid: process.pid, isOwner: true };
  } catch (err) {
    if (err.code !== 'EEXIST') return { pid: 0, isOwner: false };
    // 已有锁文件：检查其中 PID 是否存活
    try {
      const pid = Number.parseInt(readFileSync(LOCK_FILE, 'utf8'), 10);
      if (pid > 0 && pidAlive(pid)) {
        return { pid, isOwner: false };
      }
    } catch {
      /* 锁文件损坏视为可接管 */
    }
    // 残留锁（PID 已死）：接管
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* 忽略 */
    }
    return acquireLock();
  }
}

/** PID 是否存活（Windows 支持 process.kill(pid, 0) 存在性检查）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** 释放锁文件。 */
function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    /* 忽略 */
  }
}

/**
 * 尝试在 0.0.0.0:port 上占住端口（保持监听），成功返回 server，失败返回 null。
 * 用于「探测 + 抢占」，避免探测到端口后、子进程启动前被其他程序抢走。
 * @param {number} port
 * @returns {Promise<import('node:net').Server|null>}
 */
function holdPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      // 端口被占用（或权限错误）视为不可用。
      resolve(null);
    });
    srv.listen(port, '0.0.0.0', () => resolve(srv));
  });
}

/**
 * 从 startPort 起递增寻找第一个可用端口，并占住它。
 * @param {number} startPort
 * @returns {Promise<{ port: number, srv: import('node:net').Server }|null>}
 */
async function claimFreePort(startPort) {
  for (let p = startPort; p < startPort + MAX_TRIES; p += 1) {
    const srv = await holdPort(p);
    if (srv) return { port: p, srv };
  }
  return null;
}

function parseStartPort() {
  const raw = (process.env.START_PORT ?? '').trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3001;
}

async function main() {
  // 单实例保护（锁文件）：已有后端在跑时直接退出，避免多实例并发写 data
  // 造成 Windows 文件独占锁 EPERM。
  const lock = acquireLock();
  if (!lock.isOwner) {
    console.error(`[start] 已有后端实例在运行（PID ${lock.pid}，锁文件 ${LOCK_FILE}）。`);
    console.error('[start] 若确需重启，请先停止现有后端进程（或删除锁文件后重试）。');
    process.exit(1);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', releaseLock);
  process.on('SIGTERM', releaseLock);

  // 显式指定 PORT 时直接复用（由 config.js 读取），不做探测。
  const forcedPort = (process.env.PORT ?? '').trim();
  let port;
  let holdSrv = null;

  if (forcedPort !== '') {
    const n = Number.parseInt(forcedPort, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`[start] 非法 PORT 值: "${forcedPort}"，应为正整数`);
      process.exit(1);
    }
    port = n;
    console.log(`[start] 使用指定端口 ${port}（跳过探测）`);
  } else {
    const startPort = parseStartPort();
    console.log(`[start] 正在探测可用端口（从 ${startPort} 起）...`);
    const claimed = await claimFreePort(startPort);
    if (!claimed) {
      console.error(`[start] 找不到可用端口（已尝试 ${MAX_TRIES} 个）`);
      process.exit(1);
    }
    port = claimed.port;
    holdSrv = claimed.srv;
    console.log(`[start] 探测到可用端口 ${port}，启动后端服务...`);
  }

  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      holdSrv?.close(() => {});
    } catch {
      /* 忽略关闭异常 */
    }
  }

  // 释放抢占端口的时机：子进程已监听（3 秒内必就绪）、或子进程退出/报错。
  // 增加到 5 秒以适应不同环境下的启动时间差异
  const releaseTimer = setTimeout(release, 5000);
  child.on('exit', (code) => {
    clearTimeout(releaseTimer);
    release();
    if (code != null && code !== 0) process.exit(code);
  });
  child.on('error', (err) => {
    clearTimeout(releaseTimer);
    release();
    console.error('[start] 启动子进程失败:', err);
    process.exit(1);
  });

  // 转发终止信号，保证 Ctrl+C 能干净退出后端。
  const forward = (sig) => () => {
    release();
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
}

main().catch((err) => {
  console.error('[start] 未知错误:', err);
  process.exit(1);
});
