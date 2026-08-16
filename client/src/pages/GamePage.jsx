import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Typography, Button, CircularProgress, Alert, Paper, Chip } from '@mui/material';
import { useMediaQuery, useTheme } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';

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
  ply_limit: '达到手数上限',
};

export default function GamePage() {
  const { id: roomId } = useParams();
  const app = useApp();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const { room, game, logs, finished } = useRoomStream(roomId);

  const [selected, setSelected] = useState(null);
  const [legalMoves, setLegalMoves] = useState([]);
  const [moving, setMoving] = useState(false);

  const currentPlayer = game ? game.players[game.turnSeat] : null;
  const isHumanTurn = Boolean(
    game && game.status === 'playing' && currentPlayer && currentPlayer.kind === 'human',
  );

  // 落子音效：监听 history 增量（单步 → 移动音；连跳 → 按跳数连奏连跳音）。
  // 初始快照不播；同一 history 长度不重复触发。
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
    if (len > prevLenRef.current) {
      const last = h[len - 1];
      // 连跳：path 含中间落点，跳数 = path.length - 1；单步 path 长度 2 或无 path
      const jumpSteps = Array.isArray(last?.path) && last.path.length > 0 ? last.path.length - 1 : 1;
      if (jumpSteps >= 2) sound.multiJump(jumpSteps);
      else sound.move();
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
        if (!cancelled) setLegalMoves([]);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, game?.turnSeat, game?.status, isHumanTurn]);

  const legalTargets = useMemo(() => {
    if (!selected) return [];
    return legalMoves.filter((m) => m.from === selected).map((m) => m.to);
  }, [selected, legalMoves]);

  const lastMove =
    game && game.history && game.history.length
      ? game.history[game.history.length - 1]
      : null;

  const currentSeat = game && game.status === 'playing' ? game.turnSeat : null;

  const handleCellClick = (key) => {
    if (!isHumanTurn || !game) return;
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
  };

  const submitMove = async (from, to) => {
    setMoving(true);
    try {
      await humanMove(roomId, from, to);
      setSelected(null);
    } catch (e) {
      app.error(e.message || '落子失败');
    } finally {
      setMoving(false);
    }
  };

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
        </Box>
        <CircularProgress size={16} thickness={5} />
      </Paper>
    );
  }

  const notStarted = !game && (
    <Alert severity="info" sx={{ mb: 2 }}>
      对局尚未开始。请返回房间页，满员后点击「开始对局」。
    </Alert>
  );

  const backBtn = (
    <Button startIcon={<ArrowBackIcon />} onClick={() => window.history.back()} sx={{ mb: 1.5, borderRadius: 10 }}>
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

  const boardEl = (
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
        currentSeat={currentSeat}
        interactive={isHumanTurn}
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
