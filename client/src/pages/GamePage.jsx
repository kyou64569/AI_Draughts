import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Typography, Button, CircularProgress, Alert, Paper, Chip } from '@mui/material';
import { useMediaQuery, useTheme } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';

import { getLegalMoves, humanMove } from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import { useRoomStream } from '../hooks/useSSE.js';
import Board from '../components/Game/Board.jsx';
import SeatInfoCard from '../components/Game/SeatInfoCard.jsx';
import DecisionLog from '../components/Game/DecisionLog.jsx';
import ScoreBoard from '../components/Game/ScoreBoard.jsx';
import { colorLabel, COLOR_DEEP, COLOR_FILL } from '../utils/colors.js';
import { sound } from '../utils/sound.js';

const END_REASON_LABEL = {
  all_finished: '三色全部入营',
  deadlock: '对局死锁',
  stall: '无进展停滞',
  ply_limit: '达到手数上限',
};

/** 音效增量同步上限：超过该值视为重连补发快照，静默重置基线（不连播一串旧音）。 */
const SOUND_SYNC_LIMIT = 3;

export default function GamePage() {
  const { id: roomId } = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const { room, game, logs, finished, thinking } = useRoomStream(roomId);

  const [selected, setSelected] = useState(null);
  const [legalMoves, setLegalMoves] = useState([]);
  const [moving, setMoving] = useState(false);

  const currentPlayer = game ? game.players[game.turnSeat] : null;
  const isHumanTurn = Boolean(
    game && game.status === 'playing' && currentPlayer && currentPlayer.kind === 'human',
  );

  // 落子音效：监听 history 增量（单步 → 移动音；连跳 → 按跳数连奏连跳音）。
  // 初始快照不播；两次 state 广播被 React 合并渲染时（AI 托管秒回时会发生）
  // prevLen 一次前进多手 —— 逐条补播，不漏掉人类玩家的连跳音；
  // 增量超过 SOUND_SYNC_LIMIT（重连补发快照）或长度回退时静默重置基线。
  const initedRef = useRef(false);
  const prevLenRef = useRef(0);
  useEffect(() => {
    const h = game?.history ?? [];
    const len = h.length;
    if (len === 0) {
      prevLenRef.current = 0;
      return;
    }
    if (!initedRef.current) {
      // 首次拿到快照：只记录基线，不播音
      initedRef.current = true;
      prevLenRef.current = len;
      return;
    }
    const prev = prevLenRef.current;
    if (len > prev && len - prev <= SOUND_SYNC_LIMIT) {
      let cursor = 0; // AudioContext 时间轴偏移：连播时按序排队
      for (let i = prev; i < len; i += 1) {
        const m = h[i];
        const jumpSteps = Array.isArray(m?.path) && m.path.length > 0 ? m.path.length - 1 : 1;
        if (jumpSteps >= 2) {
          sound.multiJump(jumpSteps, cursor);
          cursor += jumpSteps * 0.085 + 0.12;
        } else {
          sound.move(cursor);
          cursor += 0.12;
        }
      }
    }
    prevLenRef.current = len;
  }, [game]);

  // 轮到人类时拉取合法走法（用于高亮落点）
  useEffect(() => {
    if (!isHumanTurn) {
      setLegalMoves([]);
      setSelected(null);
      return undefined;
    }
    let cancelled = false;
    getLegalMoves(roomId)
      .then((m) => {
        if (!cancelled) setLegalMoves(Array.isArray(m) ? m : []);
      })
      .catch(() => {
        if (cancelled) return;
        setLegalMoves([]);
        // 不能静默吞错：否则用户看到"轮到你了"却点不动，且无法区分
        // 是网络问题还是本就无合法走法。
        app.error('获取合法走法失败，请检查网络后重试');
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, game?.turnSeat, game?.status, isHumanTurn, app]);

  const legalTargets = useMemo(() => {
    if (!selected) return [];
    return legalMoves.filter((m) => m.from === selected).map((m) => m.to);
  }, [selected, legalMoves]);

  const lastMove =
    game && game.history && game.history.length
      ? game.history[game.history.length - 1]
      : null;

  // 人类座位自己的上一手：AI 托管秒回时"最新一手"高亮会被立刻覆盖，
  // 人类自己的虚线保留到自己再次落子，连跳路径才看得清。
  const ownLastMove = useMemo(() => {
    const h = game?.history;
    if (!h || h.length === 0) return null;
    const humanSeat = game.players?.find((p) => p.kind === 'human')?.seat;
    if (humanSeat == null) return null;
    for (let i = h.length - 1; i >= 0; i -= 1) {
      if (h[i].seat === humanSeat) return h[i];
    }
    return null;
  }, [game]);

  const currentSeat = game && game.status === 'playing' ? game.turnSeat : null;

  // submitMove 需先于 handleCellClick 声明：后者依赖数组在渲染期即求值，引用后声明
  // 的 const 会触发 TDZ（Cannot access before initialization）。
  const submitMove = useCallback(
    async (from, to) => {
      setMoving(true);
      try {
        await humanMove(roomId, from, to);
        setSelected(null);
      } catch (e) {
        app.error(e.message || '落子失败');
      } finally {
        setMoving(false);
      }
    },
    [roomId, app],
  );

  // useCallback + Board memo：仅日志/房间等旁路更新时跳过棋盘 SVG 重渲染
  const handleCellClick = useCallback(
    (key) => {
      // moving 为提交中的互斥锁：连点会在第一手尚未返回时再发一请求，
      // 服务端会按已推进的 turnSeat 拒绝并弹「落子失败」，属误导性报错。
      if (!isHumanTurn || !game || moving) return;
      const color = currentPlayer.color;
      if (!selected) {
        if (game.board[key] === color) setSelected(key);
        return;
      }
      if (key === selected) {
        setSelected(null);
        return;
      }
      if (legalTargets.includes(key)) {
        submitMove(selected, key);
        return;
      }
      if (game.board[key] === color) setSelected(key);
      else setSelected(null);
    },
    [isHumanTurn, game, moving, currentPlayer, selected, legalTargets, submitMove],
  );

  if (!room && !game) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  /* ---------- 状态横幅 ---------- */
  let statusEl = null;
  if (finished || game?.status === 'finished') {
    statusEl = (
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          mb: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Chip color="success" label="对局已结束" />
        <Typography variant="body2" color="text.secondary">
          {game?.endReason ? END_REASON_LABEL[game.endReason] ?? game.endReason : ''}
        </Typography>
        {game?.id && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<PlayCircleIcon />}
            onClick={() => navigate(`/history/${game.id}`)}
            sx={{ ml: 'auto' }}
          >
            查看回放
          </Button>
        )}
      </Paper>
    );
  } else if (game && game.status === 'playing' && currentPlayer) {
    const c = currentPlayer.color;
    statusEl = (
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          mb: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          borderColor: `${COLOR_FILL[c]}66`,
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontSize: 12,
            fontWeight: 800,
            background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[c]}, ${COLOR_DEEP[c] ?? COLOR_FILL[c]})`,
          }}
        >
          {colorLabel(c)}
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2" fontWeight={700}>
            {currentPlayer.kind === 'human' ? (
              <>
                <PersonIcon sx={{ fontSize: 15, verticalAlign: '-3px', mr: 0.5 }} />
                轮到你了！请选择棋子并落子
              </>
            ) : (
              <>
                <SmartToyIcon sx={{ fontSize: 15, verticalAlign: '-3px', mr: 0.5 }} />
                {currentPlayer.name ?? 'AI'}（{colorLabel(c)}方）正在思考
                <Box component="span" sx={{ ml: 1, color: 'text.secondary', fontWeight: 400 }}>
                  {lastMove && `上一手 ${lastMove.from} → ${lastMove.to}`}
                </Box>
              </>
            )}
          </Typography>
          {/* 流式思考：AI 决策期间实时展示推理片段（模型支持 reasoning 时才有内容） */}
          {currentPlayer.kind === 'ai' && thinking?.seat === game.turnSeat && thinking.text && (
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                mt: 0.25,
                fontStyle: 'italic',
                color: 'text.secondary',
                maxHeight: 42,
                overflow: 'hidden',
                wordBreak: 'break-all',
              }}
            >
              {thinking.text}
            </Typography>
          )}
        </Box>
        <CircularProgress size={16} thickness={5} />
      </Paper>
    );
  }

  const archivedGame = game?.archived !== undefined;

  const notStarted = !game && room?.status !== 'finished' && (
    <Alert severity="info" sx={{ mb: 2 }}>
      对局尚未开始。请返回房间页，满员后点击「开始对局」。
    </Alert>
  );

  const backBtn = (
    // 直接导航到房间列表：书签/刷新/分享链接进入时 history.back() 会离开应用
    <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/rooms')} sx={{ mb: 1.5, borderRadius: 10 }}>
      返回房间
    </Button>
  );

  const seatCards = game ? (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {game.players.map((p) => (
        <SeatInfoCard
          key={p.seat}
          player={p}
          isCurrentTurn={game.turnSeat === p.seat && game.status === 'playing'}
          isAutoPilot={game.autoPilotSeats?.includes(String(p.seat))}
        />
      ))}
    </Box>
  ) : null;

  // 归档摘要（服务重启后）：显示对局结果而非空棋盘
  const boardEl = archivedGame ? (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        borderRadius: 4,
        bgcolor: 'background.paper',
        width: '100%',
        borderColor: 'divider',
      }}
    >
      <Typography variant="subtitle1" fontWeight={800} gutterBottom>
        对局结果（历史归档）
      </Typography>
      {game.archived === false ? (
        <Alert severity="warning" sx={{ mt: 1 }}>
          该对局的棋谱记录在服务重启前已丢失，仅保留房间信息。今后对局记录会持久保存。
        </Alert>
      ) : (
        <>
          <ScoreBoard game={game} finished />
          <Box sx={{ display: 'flex', gap: 2.5, mt: 1.5, color: 'text.secondary', flexWrap: 'wrap' }}>
            <Typography variant="body2">手数：{game.moveCount ?? '—'}</Typography>
            <Typography variant="body2">
              结束时间：{game.finishedAt ? new Date(game.finishedAt).toLocaleString() : '—'}
            </Typography>
            {game.endReason ? (
              <Typography variant="body2">
                结束原因：{END_REASON_LABEL[game.endReason] ?? game.endReason}
              </Typography>
            ) : null}
          </Box>
        </>
      )}
    </Paper>
  ) : (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 0.5, md: 1.5 },
        borderRadius: 4,
        bgcolor: 'background.paper',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        borderColor: 'divider',
      }}
    >
      <Board
        game={game}
        selected={selected}
        legalTargets={legalTargets}
        lastMove={lastMove}
        ownLastMove={ownLastMove}
        currentSeat={currentSeat}
        interactive={isHumanTurn && !moving}
        onCellClick={handleCellClick}
      />
    </Paper>
  );

  // 移动端：状态 → 积分 → 棋盘 → 座位（横向滚动）→ 日志抽屉
  if (!isDesktop) {
    return (
      <Box>
        {backBtn}
        {statusEl}
        {notStarted}
        <ScoreBoard game={game} finished={finished} />
        {boardEl}
        {seatCards && <Box sx={{ mt: 1.5 }}>{seatCards}</Box>}
        <DecisionLog logs={logs} variant="drawer" />
      </Box>
    );
  }

  // 桌面端：三栏（左座位/积分，中棋盘，右决策日志）
  return (
    <Box>
      {backBtn}
      {statusEl}
      {notStarted}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Box sx={{ width: { md: 250, lg: 260 }, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <ScoreBoard game={game} finished={finished} />
          {seatCards}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>{boardEl}</Box>
        <Box sx={{ width: { md: 300, lg: 320 }, flexShrink: 0, alignSelf: 'stretch' }}>
          <DecisionLog logs={logs} variant="panel" />
        </Box>
      </Box>
    </Box>
  );
}
