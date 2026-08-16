import { useEffect, useRef, useState } from 'react';
import { openRoomStream } from '../api/sse.js';
import { useApp } from '../context/AppContext.jsx';

/**
 * 订阅房间 SSE，维护 room / game / logs / finished 状态。
 * 连接即推 room 快照 +（已开局）state 快照 + 最近 ~20 条 log；
 * 之后分别按 state / log / room / finished 事件增量更新。
 *
 * 重连容错：EventSource 断流后会按 `retry:3000` 自动重连，服务端 /stream 在每次
 * （重）连接时都会补发最近 ~20 条 log。为避免日志重复：
 *  - 用 seenLogKeys 记录已收到的 log 指纹（timestamp|seat|from|to|reason），重复的不追加；
 *  - 断流 toast 只在"本次断开周期"内提示一次，重连成功（open 事件）后复位标记，
 *    避免每 3s 重连尝试都弹一次"连接断开"。
 *
 * @param {string|null} roomId
 */
export function useRoomStream(roomId) {
  const [room, setRoom] = useState(null);
  const [game, setGame] = useState(null);
  const [logs, setLogs] = useState([]);
  const [finished, setFinished] = useState(false);
  const app = useApp();
  const seenLogKeys = useRef(new Set());
  const errorShownRef = useRef(false);

  useEffect(() => {
    if (!roomId) return undefined;

    // 切换房间时重置本地状态与去重集合
    setRoom(null);
    setGame(null);
    setLogs([]);
    setFinished(false);
    seenLogKeys.current = new Set();
    errorShownRef.current = false;

    const appendLog = (l) => {
      if (!l) return;
      // 指纹去重：重连补发的 log 与已收到的 log 内容一致则跳过
      const key = `${l.timestamp}|${l.seat}|${l.from}|${l.to}|${l.reason}`;
      if (seenLogKeys.current.has(key)) return;
      seenLogKeys.current.add(key);
      setLogs((prev) => [...prev, l]);
    };

    const es = openRoomStream(roomId, {
      onState: (g) => {
        if (g) setGame(g);
      },
      onLog: appendLog,
      onRoom: (r) => {
        if (r) setRoom(r);
      },
      onFinished: (f) => {
        setFinished(true);
        setGame((prev) => {
          if (!prev) return prev;
          const scores = f?.scores ?? prev.scores;
          return { ...prev, status: 'finished', scores };
        });
      },
      onError: (e) => {
        // 同一次断开周期只提示一次，避免每 3s 重连尝试都弹 toast
        if (errorShownRef.current) return;
        errorShownRef.current = true;
        app.error('实时连接断开，正在自动重连…');
        console.error('[SSE] Connection error:', e);
      },
    });

    // 重连成功后复位标记，使下次断开可再次提示
    es.addEventListener('open', () => {
      errorShownRef.current = false;
    });

    return () => {
      if (es) es.close();
    };
  }, [roomId, app]);

  return { room, game, logs, finished };
}
