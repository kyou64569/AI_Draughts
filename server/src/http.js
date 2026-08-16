/**
 * 统一响应包工具：`{code, data, message}`，code=0 成功（architecture.md §10）。
 *
 * 说明（对架构文件清单的唯一新增文件）：三个 routes 模块都要用同样的响应封装，
 * 抽到此处避免三处重复实现；不含任何业务逻辑。
 */
import { ERROR_CODES } from './constants.js';

/**
 * 业务异常：带 HTTP/业务错误码，routes 内 throw，由 index.js 错误中间件统一转响应。
 */
export class ApiError extends Error {
  /**
   * @param {number} code 错误码（见 ERROR_CODES）
   * @param {string} message 可展示给用户的错误说明（绝不包含 apiKey）
   */
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** @param {string} message */
export const badRequest = (message) => new ApiError(ERROR_CODES.BAD_REQUEST, message);
/** @param {string} message */
export const notFound = (message) => new ApiError(ERROR_CODES.NOT_FOUND, message);
/** @param {string} message */
export const conflict = (message) => new ApiError(ERROR_CODES.CONFLICT, message);
/** @param {string} message */
export const unprocessable = (message) => new ApiError(ERROR_CODES.UNPROCESSABLE, message);
/** @param {string} message */
export const llmUnavailable = (message) => new ApiError(ERROR_CODES.LLM_UNAVAILABLE, message);

/**
 * 成功响应。
 * @param {import('express').Response} res
 * @param {any} data
 * @returns {import('express').Response}
 */
export function sendOk(res, data = null) {
  return res.status(200).json({ code: ERROR_CODES.OK, data, message: 'ok' });
}

/**
 * 失败响应。HTTP 状态码与业务 code 保持一致（4xx/5xx）。
 * @param {import('express').Response} res
 * @param {number} code
 * @param {string} message
 * @returns {import('express').Response}
 */
export function sendErr(res, code, message) {
  const httpStatus = code >= 400 && code <= 599 ? code : 400;
  return res.status(httpStatus).json({ code, data: null, message });
}

/**
 * 包装 async 路由处理器，把 rejection 转交 Express 错误中间件。
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} fn
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 校验必填字符串字段。
 * @param {any} value
 * @param {string} field 字段名（用于报错信息）
 * @returns {string} 去空格后的值
 */
export function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`参数 ${field} 缺失或非法`);
  }
  return value.trim();
}
