/**
 * 简单的内存速率限制中间件
 * 防止 API 滥用和 DoS 攻击
 */
import { ERROR_CODES, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from '../constants.js';

/** @type {Map<string, {count: number, resetTime: number}>} */
const ipStore = new Map();

/**
 * 清理过期的 IP 记录
 */
function cleanupExpired() {
  const now = Date.now();
  for (const [ip, data] of ipStore.entries()) {
    if (now > data.resetTime) {
      ipStore.delete(ip);
    }
  }
}

// 每分钟清理一次过期记录（unref：不阻止进程自然退出，与 sseManager 心跳一致）
const cleanupTimer = setInterval(cleanupExpired, 60000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

/**
 * 速率限制中间件
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const record = ipStore.get(ip);

  if (!record || now > record.resetTime) {
    // 新窗口或窗口已过期
    ipStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    const resetAfter = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', resetAfter);
    // 与全局统一响应包 {code,data,message} 保持一致（code 为数字错误码）
    return res.status(429).json({
      code: ERROR_CODES.TOO_MANY_REQUESTS,
      data: null,
      message: `请求过于频繁，请在 ${resetAfter} 秒后重试`,
    });
  }

  record.count += 1;
  next();
}

export default rateLimiter;
