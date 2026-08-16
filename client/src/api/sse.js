import { API_BASE } from './client.js';

/**
 * 打开房间 SSE 流，按事件名分发到回调。
 * 事件名（与后端 SSE_EVENTS 一致）：state / log / room / finished。
 *
 * @param {string} roomId
 * @param {{onState?:Function, onLog?:Function, onRoom?:Function, onFinished?:Function, onError?:Function}} handlers
 * @returns {EventSource}
 */
export function openRoomStream(roomId, handlers = {}) {
  // 跨域需传绝对 URL（后端 CORS 放行全部来源）。
  const url = `${API_BASE}/api/rooms/${roomId}/stream`;
  const es = new EventSource(url);

  const bind = (name, cb) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      let payload = null;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        payload = null;
      }
      cb(payload);
    });
  };

  bind('state', handlers.onState);
  bind('log', handlers.onLog);
  bind('room', handlers.onRoom);
  bind('finished', handlers.onFinished);
  if (handlers.onError) es.onerror = (e) => handlers.onError(e);

  return es;
}
