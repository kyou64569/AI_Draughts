import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Chip,
  CircularProgress,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Stack,
  Button,
  IconButton,
  Tooltip,
} from '@mui/material';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import HistoryIcon from '@mui/icons-material/History';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import DownloadIcon from '@mui/icons-material/Download';
import { getHistory, historyExportUrl } from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import { COLOR_DEEP, COLOR_FILL, colorLabel } from '../utils/colors.js';

/** 名次奖牌样式（1金 2银 3铜）。 */
const MEDAL = {
  1: { label: '🥇', color: '#fbbf24' },
  2: { label: '🥈', color: '#cbd5e1' },
  3: { label: '🥉', color: '#f59e0b' },
};

/** 时长格式化。 */
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/** 时间格式化（本地时区）。 */
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 玩家圆点。 */
function ColorDot({ color, size = 12 }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * 历史页面：积分排名 + 对战历史。
 */
export default function HistoryPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [ranking, setRanking] = useState([]);
  const [games, setGames] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getHistory()
      .then((data) => {
        if (cancelled) return;
        setRanking(Array.isArray(data.ranking) ? data.ranking : []);
        setGames(Array.isArray(data.games) ? data.games : []);
      })
      .catch((e) => {
        if (!cancelled) app.error(e.message || '加载历史失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  const empty = games.length === 0 && ranking.length === 0;

  return (
    <Stack spacing={3}>
      {/* ===== 积分排名 ===== */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <EmojiEventsIcon color="warning" />
          <Typography variant="subtitle1" fontWeight={800}>
            积分排名
          </Typography>
        </Box>
        {ranking.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无排名数据，完成一局对局后自动生成。
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {ranking.map((r, i) => {
              const medal = MEDAL[i + 1];
              return (
                <Box
                  key={r.key}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 1.5,
                    py: 1,
                    borderRadius: 2,
                    bgcolor: i % 2 === 1 ? 'action.hover' : 'transparent',
                  }}
                >
                  <Typography sx={{ width: 34, textAlign: 'center', fontWeight: 800, fontSize: 16 }}>
                    {medal ? medal.label : i + 1}
                  </Typography>
                  <Typography sx={{ fontWeight: 700, flex: 1 }} noWrap>
                    {r.name}
                    {r.kind === 'ai' && r.model ? (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        {r.model}
                      </Typography>
                    ) : null}
                  </Typography>
                  <Stack direction="row" spacing={2} sx={{ color: 'text.secondary' }}>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="caption" display="block" color="text.secondary">
                        局数
                      </Typography>
                      <Typography variant="body2" fontWeight={700}>
                        {r.games}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="caption" display="block" color="text.secondary">
                        冠军
                      </Typography>
                      <Typography variant="body2" fontWeight={700} color="#fbbf24">
                        {r.wins}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right', minWidth: 56 }}>
                      <Typography variant="caption" display="block" color="text.secondary">
                        均名次
                      </Typography>
                      <Typography variant="body2" fontWeight={700}>
                        {r.avgRank ?? '—'}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right', minWidth: 64 }}>
                      <Typography variant="caption" display="block" color="text.secondary">
                        总分
                      </Typography>
                      <Typography variant="body2" fontWeight={800} color="primary.main">
                        {r.totalScore}
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>

      {/* ===== 对战历史 ===== */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <HistoryIcon color="info" />
          <Typography variant="subtitle1" fontWeight={800}>
            对战历史
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            共 {games.length} 局
          </Typography>
        </Box>

        {empty ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              暂无对战记录
            </Typography>
            <Button variant="contained" sx={{ mt: 1.5 }} onClick={() => navigate('/rooms')}>
              去对局大厅开始一局
            </Button>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>结束时间</TableCell>
                  <TableCell>玩家（名次）</TableCell>
                  <TableCell align="right">手数</TableCell>
                  <TableCell align="right">时长</TableCell>
                  <TableCell>结束原因</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {games.map((g) => (
                  <TableRow key={g.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(g.finishedAt)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                        {(g.players ?? []).map((p) => (
                          <Box
                            key={p.seat}
                            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6 }}
                          >
                            <ColorDot color={p.color} />
                            <Typography variant="body2">
                              {colorLabel(p.color)}方
                              {p.kind === 'human' ? '（你）' : ''}
                              {p.finishRank ? (
                                <Chip
                                  size="small"
                                  label={`第 ${p.finishRank} 名`}
                                  sx={{
                                    ml: 0.6,
                                    height: 20,
                                    fontSize: 11,
                                    bgcolor: `${MEDAL[p.finishRank]?.color ?? '#64748b'}26`,
                                    color: MEDAL[p.finishRank]?.color ?? '#64748b',
                                    fontWeight: 700,
                                  }}
                                />
                              ) : null}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{g.moveCount}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {fmtDuration(g.durationSec)}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={g.endReasonLabel ?? g.endReason ?? '—'} />
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {g.replayable && (
                          <Button
                            size="small"
                            startIcon={<PlayCircleIcon />}
                            onClick={() => navigate(`/history/${g.id}`)}
                          >
                            回放
                          </Button>
                        )}
                        <Tooltip title="导出棋谱文本">
                          <IconButton
                            size="small"
                            href={historyExportUrl(g.id)}
                            aria-label="导出棋谱"
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Stack>
  );
}
