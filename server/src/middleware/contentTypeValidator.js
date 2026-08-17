/**
 * Content-Type 验证中间件
 * 确保 POST/PUT/PATCH 请求具有正确的 Content-Type
 */
import { sendErr } from '../http.js';
import { ERROR_CODES } from '../constants.js';

/**
 * 验证 Content-Type 中间件
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function contentTypeValidator(req, res, next) {
  const method = req.method;
  // 只对需要请求体的方法进行验证
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    // 无请求体（如 POST /start、POST /test）无需校验 Content-Type
    const hasBody =
      req.body !== undefined &&
      req.body !== null &&
      (typeof req.body !== 'object' || Object.keys(req.body).length > 0);
    if (!hasBody) return next();

    const contentType = req.get('Content-Type');
    // 允许 application/json 或 multipart/form-data
    if (!contentType || 
        (!contentType.startsWith('application/json') && 
         !contentType.startsWith('multipart/form-data'))) {
      return sendErr(res, ERROR_CODES.BAD_REQUEST, 
        '请求必须使用 Content-Type: application/json 或 multipart/form-data');
    }
  }
  
  next();
}

export default contentTypeValidator;
