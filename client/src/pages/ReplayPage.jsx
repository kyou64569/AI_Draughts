import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Button,
  CircularProgress,
  Alert,
  Slider,
  IconButton,
  Chip,
  Stack,
  Tooltip,
  Divider,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DownloadIcon from '@mui/icons-material/Download';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';

import { getHistoryGame, historyExportUrl } from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import Board from '../components/Game/Board.jsx';
import { BOARD_CELLS } from '../utils/boardGeometry.js';
import { COLOR_DEEP, COLOR_FILL, colorLabel, PIECES_PER_COLOR } from '../utils/colors.js';

/** 播放速度档位（每手间隔毫秒）。 */
const SPEEDS = [
  { label: '0.5x', ms: 1400 },
  { label: '1x', ms: 700 },
  { label: '2x', ms: 350 },
  { label: '4x', ms: 150 },
];

/** 结束原因中文名。 */
const END_REASON_LABEL = {
  all_finished: '全部入营',
  deadlock: '对局死锁',
  stall: '无进展停滞',
  ply_limit: '达到手数上限',
};

/**
 * 棋谱回放页：从归档棋谱逐手重建棋盘，配合决策理由 / 质量统计观看 AI 如何思考。
 * 路由：/history/:id（id 为归档对局 id）。
 */
export default function ReplayPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const app = useApp();

  const [loading, setLoading] = useState(true);
  const [record, setRecord] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecord(null);
    setLoadError(null);
    setIdx(0);
    setPlaying(false);
    getHistoryGame(id)
      .then((data) => {
        if (!cancelled) setRecord(data);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e.message || '加载棋谱失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, app]);

  const moves = useMemo(() => (Array.isArray(record?.history) ? record.history : []), [record]);
  const total = moves.length;
  const replayable = record != null && Array.isArray(record.history) && total > 0;

  // 本局在场颜色（2/3/4/6 人局），初始棋盘只摆放这些颜色的 home 棋子
  const activeColors = useMemo(
    () => new Set((record?.players ?? []).map((p) => p.color).filter(Boolean)),
    [record],
  );

  // 初始棋盘：本局颜色的 home 格放子，其余为空（与后端 createInitialBoard 一致）
  const initialBoard = useMemo(() => {
    const b = {};
    for (const c of BOARD_CELLS.cells) b[c.key] = null;
    for (const c of BOARD_CELLS.cells) {
      if (c.homeColor && activeColors.has(c.homeColor)) b[c.key] = c.homeColor;
    }
    return b;
  }, [activeColors]);

  // 目标营地格（按颜色，动态覆盖 2~6 人局的全部颜色），用于回放进度统计
  const targetCellKeys = useMemo(() => {
    const map = {};
    for (const c of BOARD_CELLS.cells) {
      if (c.targetColor) (map[c.targetColor] ??= []).push(c.key);
    }
    return map;
  }, []);

  // 应用前 idx 手后的棋盘。
  // 任一手不合法（起点无子）说明归档棋谱与规则不符，必须**中断并提示**：
  // 原来的 `continue` 会静默跳过，使棋盘从该手起永久偏离真实对局，
  // 而界面上看不出任何异常（入营数统计也会同步失真）。
  const { board, badMoveIdx } = useMemo(() => {
    const b = { ...initialBoard };
    let bad = null;
    for (let i = 0; i < idx && i < total; i += 1) {
      const m = moves[i];
      if (b[m.from] == null) {
        bad = i;
        break;
      }
      b[m.to] = b[m.from];
      b[m.from] = null;
    }
    return { board: b, badMoveIdx: bad };
  }, [initialBoard, idx, total, moves]);

  // 各颜色当前入营数（按本局在场颜色初始化）
  const inTargetByColor = useMemo(() => {
    const counts = {};
    for (const color of activeColors) counts[color] = 0;
    for (const k of Object.keys(board)) {
      const color = board[k];
      if (color && targetCellKeys[color]?.includes(k)) counts[color] = (counts[color] ?? 0) + 1;
    }
    return counts;
  }, [board, targetCellKeys, activeColors]);

  const currentMove = idx > 0 ? moves[idx - 1] : null;
  const nextSeat = idx < total ? moves[idx]?.seat ?? null : null;

  // 播放：每到手数上限自动停
  useEffect(() => {
    if (!playing) return undefined;
    if (idx >= total) {
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setIdx((v) => Math.min(v + 1, total)), SPEEDS[speedIdx].ms);
    return () => clearTimeout(timer);
  }, [playing, idx, total, speedIdx]);

  // 键盘左右方向键逐步
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // 必须让目标元素优先处理：MUI Slider 聚焦后自身也响应方向键，不跳过就会
      // "一次按键走两手"（Slider onChange 走一手 + 本监听器再走一手）。
      // 注意 Slider 的可聚焦元素是 role="slider" 的 span 而非 INPUT，
      // 因此只判断 tagName 抓不到，必须一并判断 role。
      if (e.defaultPrevented) return;
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (el?.getAttribute?.('role') === 'slider' || el?.closest?.('[role="slider"]')) return;
      setIdx((v) => (e.key === 'ArrowLeft' ? Math.max(0, v - 1) : Math.min(total, v + 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (loadError || !record) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/history')} sx={{ mb: 1.5 }}>
          返回历史
        </Button>
        <Alert severity="error">{loadError || '对局记录不存在'}</Alert>
      </Box>
    );
  }

  const players = record.players ?? [];
  const playerOf = (seat) => players.find((p) => p.seat === seat) ?? null;

  const stepBy = (delta) => {
    setPlaying(false);
    setIdx((v) => Math.min(total, Math.max(0, v + delta)));
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/history')} sx={{ borderRadius: 10 }}>
          返回历史
        </Button>
        <Typography variant="subtitle1" fontWeight={800}>
          棋谱回放
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {record.finishedAt ? new Date(record.finishedAt).toLocaleString() : ''}
          {record.endReason ? ` · ${END_REASON_LABEL[record.endReason] ?? record.endReason}` : ''}
          {` · 共 ${total} 手`}
        </Typography>
        <Button
          sx={{ ml: 'auto' }}
          variant="outlined"
          size="small"
          startIcon={<DownloadIcon />}
          href={historyExportUrl(record.id)}
        >
          导出棋谱
        </Button>
      </Box>

      {!replayable && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          该对局归档较早，未保存棋谱明细，无法逐手回放。以下仅展示对局信息与结算，可导出棋谱头信息。
        </Alert>
      )}

      {/* 玩家进度条 */}
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 3 }}>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap divider={<Divider flexItem orientation="vertical" />}>
          {players.map((p) => (
            <Box key={p.seat} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 180 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[p.color]}, ${COLOR_DEEP[p.color] ?? COLOR_FILL[p.color]})`,
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" fontWeight={700} noWrap>
                {colorLabel(p.color)}方 · {p.name ?? '-'}
              </Typography>
              {p.kind === 'human' ? (
                <PersonIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              ) : (
                <SmartToyIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              )}
              <Chip
                size="small"
                label={`${inTargetByColor[p.color] ?? 0} / ${PIECES_PER_COLOR}`}
                sx={{ ml: 'auto', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
              />
              {p.finishRank ? (
                <Chip size="small" color="warning" label={`第 ${p.finishRank} 名`} sx={{ fontWeight: 700 }} />
              ) : null}
            </Box>
          ))}
        </Stack>
      </Paper>

      {badMoveIdx !== null && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          棋谱与规则不符：第 {badMoveIdx + 1} 手的起点上没有棋子，重放已在此处停止，
          此后棋盘不再可信。
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 棋盘 */}
        <Paper
          variant="outlined"
          sx={{
            p: { xs: 0.5, md: 1.5 },
            borderRadius: 4,
            flex: '1 1 620px',
            minWidth: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Board
            game={{ board, players }}
            selected={null}
            legalTargets={[]}
            lastMove={currentMove}
            currentSeat={nextSeat}
            interactive={false}
            onCellClick={() => {}}
          />
        </Paper>

        {/* 右侧：决策详情 + 质量统计 */}
        <Box sx={{ flex: '1 1 300px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <PsychologyIcon fontSize="small" color="primary" />
              <Typography variant="subtitle2">当手决策</Typography>
              <Chip size="small" label={`${idx} / ${total}`} sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums' }} />
            </Box>
            {!currentMove ? (
              <Typography variant="body2" color="text.secondary">
                开局初始局面。点击播放或拖动时间轴开始回放（←/→ 键可逐步）。
              </Typography>
            ) : (
              <Stack spacing={1}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    label={`${colorLabel(playerOf(currentMove.seat)?.color ?? 'red')}方`}
                    sx={{ bgcolor: COLOR_FILL[playerOf(currentMove.seat)?.color ?? 'red'], color: '#fff', fontWeight: 700 }}
                  />
                  <Typography variant="body2" fontWeight={700} noWrap>
                    {playerOf(currentMove.seat)?.name ?? '-'}
                  </Typography>
                  {currentMove.isFallback ? (
                    <Chip size="small" color="warning" variant="outlined" label="兜底" />
                  ) : null}
                  {currentMove.failures > 0 ? (
                    <Chip size="small" color="error" variant="outlined" label={`重试 ${currentMove.failures} 次`} />
                  ) : null}
                </Box>
                <Typography variant="body2" sx={{ '& b': { color: 'text.primary', fontWeight: 700 } }}>
                  <b>走子：</b>
                  {currentMove.from} → {currentMove.to}
                  {Array.isArray(currentMove.path) && currentMove.path.length >= 3
                    ? `（连跳x${currentMove.path.length - 1}）`
                    : '（单步）'}
                </Typography>
                {currentMove.reason ? (
                  <Typography variant="body2" color="text.secondary">
                    <b style={{ color: 'text.primary' }}>理由：</b>
                    {currentMove.reason}
                  </Typography>
                ) : null}
                {currentMove.thinking ? (
                  <Typography variant="body2" color="text.secondary">
                    <b style={{ color: 'text.primary' }}>思考：</b>
                    {currentMove.thinking}
                  </Typography>
                ) : null}
                {(currentMove.latencyMs != null || currentMove.usage) && (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {currentMove.latencyMs != null && (
                      <Chip size="small" variant="outlined" label={`延迟 ${currentMove.latencyMs}ms`} />
                    )}
                    {currentMove.usage && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`token ${currentMove.usage.promptTokens}+${currentMove.usage.completionTokens}`}
                      />
                    )}
                  </Stack>
                )}
              </Stack>
            )}
          </Paper>

          {Array.isArray(record.stats) && record.stats.length > 0 && (
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                本局决策质量
              </Typography>
              <Stack spacing={0.75}>
                {record.stats.map((s) => (
                  <Box key={s.seat} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: COLOR_FILL[s.color],
                        flexShrink: 0,
                      }}
                    />
                    <Typography variant="caption" fontWeight={700} sx={{ minWidth: 64 }}>
                      {colorLabel(s.color)}方
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {s.moves} 手 · 兜底 {s.fallbackMoves}
                      {s.fallbackRate != null ? `(${s.fallbackRate}%)` : ''} · LLM 失败 {s.llmFailures}
                      {s.avgLatencyMs != null ? ` · 均延迟 ${s.avgLatencyMs}ms` : ''}
                      {s.completionTokens > 0 ? ` · token ${s.promptTokens}/${s.completionTokens}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}
        </Box>
      </Box>

      {/* 时间轴控制 */}
      {replayable && (
        <Paper variant="outlined" sx={{ p: 2, mt: 1.5, borderRadius: 3 }}>
          <Slider
            value={idx}
            min={0}
            max={total}
            step={1}
            onChange={(_, v) => {
              setPlaying(false);
              setIdx(v);
            }}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => `第 ${v} / ${total} 手`}
            sx={{ mb: 1 }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Tooltip title="回到开局">
              <IconButton onClick={() => { setPlaying(false); setIdx(0); }}>
                <RestartAltIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="上一手（←）">
              <IconButton onClick={() => stepBy(-1)}>
                <SkipPreviousIcon />
              </IconButton>
            </Tooltip>
            <IconButton
              color="primary"
              onClick={() => {
                if (idx >= total) setIdx(0);
                setPlaying((v) => !v);
              }}
              sx={{ border: '1px solid', borderColor: 'divider' }}
            >
              {playing ? <PauseIcon /> : <PlayArrowIcon />}
            </IconButton>
            <Tooltip title="下一手（→）">
              <IconButton onClick={() => stepBy(1)}>
                <SkipNextIcon />
              </IconButton>
            </Tooltip>
            <Button size="small" variant="outlined" onClick={() => { setPlaying(false); setIdx(total); }}>
              跳到终局
            </Button>
            <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {SPEEDS.map((s, i) => (
                <Chip
                  key={s.label}
                  size="small"
                  label={s.label}
                  color={speedIdx === i ? 'primary' : 'default'}
                  variant={speedIdx === i ? 'filled' : 'outlined'}
                  onClick={() => setSpeedIdx(i)}
                />
              ))}
            </Box>
          </Box>
        </Paper>
      )}
    </Box>
  );
}
