/**
 * 后端入口：创建 Express 应用、挂载路由、启动监听（默认 3001）。
 * 运行：`node src/index.js`（无编译步骤）。
 */
import { pathToFileURL } from 'node:url';

import cors from 'cors';
import express from 'express';

import config from './config.js';
import { ERROR_CODES } from './constants.js';
import { ApiError, sendErr, sendOk } from './http.js';
import aiPlayersRouter from './routes/aiPlayers.js';
import historyRouter from './routes/history.js';
import modelConfigsRouter from './routes/modelConfigs.js';
import roomsRouter from './routes/rooms.js';
import tournamentsRouter from './routes/tournaments.js';
import store from './store.js';
import rateLimiter from './middleware/rateLimiter.js';
import contentTypeValidator from './middleware/contentTypeValidator.js';

/**
 * 兜底：任何未被链路捕获的 Promise rejection 只记录、不退出进程。
 * 否则在 Node 15+ 默认模式下，单个未处理的 rejection（例如一次失败的
 * 持久化写）会直接终止整个后端，使所有在线对局/SSE 连接全部断开。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

/**
 * 创建并配置 Express 应用（便于测试直接引入）。
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();

  // 反向代理后部署时按 TRUST_PROXY（层数或 true）开启，使 req.ip/限流取真实客户端 IP；
  // 直连部署保持关闭，防止伪造 X-Forwarded-For。
  app.set('trust proxy', config.trustProxy);

  app.use(cors({ origin: config.corsOrigin, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  // SSE 需要禁用 ETag/压缩缓冲；这里全局关掉 ETag 即可（无 compression 中间件）。
  app.set('etag', false);

  // 应用 Content-Type 验证中间件
  app.use(contentTypeValidator);

  // 应用速率限制中间件（健康检查除外）
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') {
      return next();
    }
    return rateLimiter(req, res, next);
  });

  /** 健康检查。 */
  app.get('/api/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const activeGames = store.listGames();
    
    sendOk(res, {
      ok: true,
      time: new Date().toISOString(),
      uptime: process.uptime(),
      activeGames: activeGames.length,
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024), // MB
      },
      nodeVersion: process.version,
      platform: process.platform,
    });
  });

  app.use('/api/model-configs', modelConfigsRouter);
  app.use('/api/ai-players', aiPlayersRouter);
  app.use('/api/rooms', roomsRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/tournaments', tournamentsRouter);

  /** 404 兜底。 */
  app.use((req, res) => {
    sendErr(res, ERROR_CODES.NOT_FOUND, `接口不存在: ${req.method} ${req.originalUrl}`);
  });

  /** 统一错误处理：ApiError → 对应错误码；其他 → 500。 */
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ApiError) {
      sendErr(res, err.code, err.message);
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      sendErr(res, ERROR_CODES.BAD_REQUEST, '请求体不是合法 JSON');
      return;
    }
    console.error('[unhandled]', err);
    // 500：开发环境返回真实错误信息（截断），便于前端/用户定位（如"写入 xxx 失败：文件被锁定"）；
    // 生产环境只回通用文案，避免泄露文件路径/堆栈等内部结构，完整错误始终走上面的日志。
    const isDev = process.env.NODE_ENV !== 'production';
    const detail = isDev
      ? String(err?.message ?? err ?? '未知错误').slice(0, 300)
      : '服务内部错误，请稍后重试';
    sendErr(res, ERROR_CODES.INTERNAL, detail);
  });

  return app;
}

/**
 * 启动 HTTP 服务。
 * @returns {Promise<import('node:http').Server>}
 */
export async function start() {
  await store.ensureDataDir();
  // 清理旧"tmp+rename"策略遗留的残留 .tmp（会成为文件锁诱因）
  await store.cleanupStaleTmp();
  // 预热五个集合文件，保证首次请求前文件已存在。
  await Promise.all([
    store.loadCollection('modelConfigs'),
    store.loadCollection('aiPlayers'),
    store.loadCollection('rooms'),
    store.loadCollection('games'),
    store.loadCollection('tournaments'),
  ]);
  // 启动自愈：重启后"playing 但无内存对局"的孤儿房间标记回 setup，避免进入牌桌无对局。
  await store.repairOrphanRooms();
  // 锦标赛自愈：running 锦标赛中断掉的场次回退 pending 并继续调度（非阻塞）。
  const { resumeRunningTournaments } = await import('./services/tournament.js');
  resumeRunningTournaments()
    .then((n) => {
      if (n > 0) console.log(`[ai-draughts] 锦标赛自愈：回退 ${n} 场中断场次并继续调度`);
    })
    .catch(() => {});

  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`[ai-draughts] 后端已启动: http://localhost:${config.port}`);
      console.log(`[ai-draughts] 数据目录: ${config.dataDir}`);
      resolve(server);
    });
    // SSE 是长连接：必须关掉 Node 默认 5 分钟 requestTimeout，否则会被强制断开。
    server.requestTimeout = 0;
    server.headersTimeout = 0;
  });
}

/** 是否为「node src/index.js」直接运行（被 import 时不自动启动）。 */
const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun || process.env.AI_DRAUGHTS_AUTOSTART === '1') {
  start().catch((err) => {
    console.error('[ai-draughts] 启动失败:', err);
    process.exit(1);
  });
}

export default { createApp, start };
