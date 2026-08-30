/**
 * REST 封装：统一解析 {code,data,message}，非 0 抛带 message 的错误。
 * 所有请求走 VITE_API_BASE（默认 http://localhost:3001）。
 */

const RAW_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:3001').toString().replace(/\/+$/, '');
export const API_BASE = RAW_BASE;

/** 统一 API 错误（携带 HTTP 状态码与业务 code）。 */
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 底层请求封装。
 * @param {string} method GET/POST/PUT/DELETE
 * @param {string} path 以 '/' 开头的接口路径（不含 /api 前缀）
 * @param {any} [body] 请求体（仅 method 带 body 时使用）
 * @returns {Promise<any>} 解析后的 data
 */
async function request(method, path, body) {
  const url = `${API_BASE}/api${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
  const opts = { method, headers: {}, signal: controller.signal };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (['POST', 'PUT', 'PATCH'].includes(method)) {
    // 无 body 的写请求（如 startRoom / testModelConfig）也显式声明 JSON，
    // 与后端 contentTypeValidator 的校验保持一致
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new ApiError('请求超时（30秒）', 0, 0);
    }
    throw new ApiError(`网络请求失败：${e?.message || e}`, 0, 0);
  }
  clearTimeout(timeoutId);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    console.warn('[API] JSON parse error:', e);
    json = null;
  }
  // 统一响应包：{ code, data, message }
  if (json && typeof json === 'object' && 'code' in json) {
    if (json.code !== 0) {
      throw new ApiError(json.message || `请求失败(${res.status})`, res.status, json.code);
    }
    return json.data;
  }
  // 兜底：非标准包按 HTTP 状态码处理
  if (!res.ok) throw new ApiError(`请求失败(${res.status})`, res.status, res.status);
  return json;
}

// ---- 模型配置 ----
export const listModelConfigs = () => request('GET', '/model-configs');
export const createModelConfig = (body) => request('POST', '/model-configs', body);
export const updateModelConfig = (id, body) => request('PUT', `/model-configs/${id}`, body);
export const deleteModelConfig = (id) => request('DELETE', `/model-configs/${id}`);
export const fetchModels = (id) => request('GET', `/model-configs/${id}/models`);
export const testModelConfig = (id) => request('POST', `/model-configs/${id}/test`);

// ---- AI 玩家 ----
export const listAiPlayers = () => request('GET', '/ai-players');
export const createAiPlayer = (body) => request('POST', '/ai-players', body);
export const updateAiPlayer = (id, body) => request('PUT', `/ai-players/${id}`, body);
export const deleteAiPlayer = (id) => request('DELETE', `/ai-players/${id}`);

// ---- 房间 ----
export const listRooms = () => request('GET', '/rooms');
export const createRoom = (body) => request('POST', '/rooms', body);
export const getRoom = (id) => request('GET', `/rooms/${id}`);
export const assignSeat = (roomId, seatIndex, aiPlayerId) =>
  request('PUT', `/rooms/${roomId}/seats`, { seatIndex, aiPlayerId });
export const startRoom = (roomId) => request('POST', `/rooms/${roomId}/start`);
export const deleteRoom = (roomId) => request('DELETE', `/rooms/${roomId}`);

// ---- 对局 ----
export const humanMove = (roomId, from, to) => request('POST', `/rooms/${roomId}/move`, { from, to });
export const getLegalMoves = (roomId) => request('GET', `/rooms/${roomId}/legal-moves`);

// ---- 历史 ----
export const getHistory = () => request('GET', '/history');
/** 单局详情（完整棋谱 history + 每座位决策质量 stats）。 */
export const getHistoryGame = (id) => request('GET', `/history/${id}`);
/** 棋谱文本导出下载地址（GET 直链，浏览器下载）。 */
export const historyExportUrl = (id) => `${API_BASE}/api/history/${id}/export`;

// ---- 锦标赛 ----
export const listTournaments = () => request('GET', '/tournaments');
export const createTournament = (body) => request('POST', '/tournaments', body);
export const getTournament = (id) => request('GET', `/tournaments/${id}`);
export const startTournament = (id) => request('POST', `/tournaments/${id}/start`);
export const abortTournament = (id) => request('POST', `/tournaments/${id}/abort`);
export const deleteTournament = (id) => request('DELETE', `/tournaments/${id}`);
