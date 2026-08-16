/**
 * 简单的内存速率限制中间件
 * 防止 API 滥用和 DoS 攻击
 */
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from '../constants.js';

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

// 每分钟清理一次过期记录
setInterval(cleanupExpired, 60000);

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
    return res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: `请求过于频繁，请在 ${resetAfter} 秒后重试`,
    });
  }

  record.count += 1;
  next();
}

export default rateLimiter;
