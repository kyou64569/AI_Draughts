import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Chip,
  Stack,
  CircularProgress,
  TextField,
  MenuItem,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Divider,
} from '@mui/material';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import SportsScoreIcon from '@mui/icons-material/SportsScore';

import {
  listTournaments,
  createTournament,
  getTournament,
  startTournament,
  abortTournament,
  deleteTournament,
  listAiPlayers,
} from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import { useNavigate } from 'react-router-dom';

/** 锦标赛状态展示。 */
const STATUS_META = {
  pending: { label: '待开赛', color: 'default' },
  running: { label: '进行中', color: 'success' },
  finished: { label: '已结束', color: 'info' },
  aborted: { label: '已中止', color: 'warning' },
};

/** 名次奖牌。 */
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

/**
 * 锦标赛页（建议 2.3）：创建（≥3 个 AI 循环对战）→ 启动自动逐场进行 → 积分榜。
 */
export default function TournamentPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [tournaments, setTournaments] = useState([]);
  const [aiPlayers, setAiPlayers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  // 创建表单
  const [name, setName] = useState('模型争霸赛');
  const [picked, setPicked] = useState([]);
  const [rounds, setRounds] = useState(1);
  const [creating, setCreating] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      const data = await listTournaments();
      setTournaments(Array.isArray(data) ? data : []);
      return data;
    } catch (e) {
      app.error(e.message || '加载锦标赛失败');
      return [];
    }
  }, [app]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([refreshList(), listAiPlayers().catch(() => [])])
      .then(([, players]) => {
        if (!cancelled) setAiPlayers(Array.isArray(players) ? players : []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshList]);

  // 详情轮询（running 时自动刷新赛程进度；已结束/已中止后只拉一次数据，不再轮询）
  const detailStatus = detail?.status;
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      getTournament(selectedId)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch((e) => {
          if (!cancelled) app.error(e.message || '加载详情失败');
        });
    };
    load();
    if (detailStatus === 'finished' || detailStatus === 'aborted') {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId, app, detailStatus]);

  const togglePick = (id) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      app.error('请填写锦标赛名称');
      return;
    }
    if (picked.length < 3) {
      app.error('至少选择 3 个 AI 玩家');
      return;
    }
    setCreating(true);
    try {
      const created = await createTournament({ name: name.trim(), aiPlayerIds: picked, roundsPerPairing: rounds });
      app.success(`锦标赛已创建（${created.totalMatches} 场）`);
      setPicked([]);
      await refreshList();
      setSelectedId(created.id);
    } catch (e) {
      app.error(e.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleStart = async (id) => {
    try {
      await startTournament(id);
      app.success('锦标赛已启动，将自动逐场进行');
      refreshList();
    } catch (e) {
      app.error(e.message || '启动失败');
    }
  };

  const handleAbort = async (id) => {
    if (!window.confirm('确认中止该锦标赛？进行中的场次将自然结束，之后不再开新场。')) return;
    try {
      await abortTournament(id);
      app.success('锦标赛已中止（进行中的场次自然结束）');
      refreshList();
    } catch (e) {
      app.error(e.message || '中止失败');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确认删除该锦标赛？仅删除赛程与积分记录，不影响对局归档。')) return;
    try {
      await deleteTournament(id);
      app.success('已删除');
      if (selectedId === id) setSelectedId(null);
      refreshList();
    } catch (e) {
      app.error(e.message || '删除失败');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={2.5}>
      {/* ===== 创建 ===== */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <EmojiEventsIcon color="warning" />
          <Typography variant="subtitle1" fontWeight={800}>
            创建锦标赛
          </Typography>
          <Typography variant="caption" color="text.secondary">
            3 个 AI 一组循环对战，自动逐场进行并统计积分
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <TextField
            label="名称"
            size="small"
            sx={{ width: 220 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="轮数（同组合重复轮换座位）"
            size="small"
            select
            sx={{ width: 230 }}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <MenuItem key={n} value={n}>
                {n} 轮
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" onClick={handleCreate} disabled={creating} sx={{ mt: 0.5 }}>
            {creating ? '创建中…' : '创建赛程'}
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
          {aiPlayers.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没有 AI 玩家，请先到「AI 玩家」页创建至少 3 个。
            </Typography>
          ) : (
            aiPlayers.map((p) => (
              <Chip
                key={p.id}
                label={`${p.name}（${p.model}）`}
                color={picked.includes(p.id) ? 'primary' : 'default'}
                variant={picked.includes(p.id) ? 'filled' : 'outlined'}
                onClick={() => togglePick(p.id)}
              />
            ))
          )}
        </Box>
        {picked.length > 0 && picked.length < 3 && (
          <Typography variant="caption" color="warning.main" sx={{ mt: 1, display: 'block' }}>
            已选 {picked.length} 个，至少需要 3 个。
          </Typography>
        )}
      </Paper>

      {/* ===== 列表 ===== */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <SportsScoreIcon color="primary" />
          <Typography variant="subtitle1" fontWeight={800}>
            锦标赛列表
          </Typography>
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => refreshList()} sx={{ ml: 'auto' }}>
            刷新
          </Button>
        </Box>
        {tournaments.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无锦标赛，选择 3 个以上 AI 玩家创建一届。
          </Typography>
        ) : (
          <Stack spacing={1}>
            {tournaments.map((t) => {
              const meta = STATUS_META[t.status] ?? STATUS_META.pending;
              return (
                <Box
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    flexWrap: 'wrap',
                    px: 1.5,
                    py: 1,
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: selectedId === t.id ? 'primary.main' : 'divider',
                    cursor: 'pointer',
                    bgcolor: selectedId === t.id ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Typography fontWeight={700}>{t.name}</Typography>
                  <Chip size="small" color={meta.color} label={meta.label} />
                  <Typography variant="caption" color="text.secondary">
                    {t.finishedMatches}/{t.totalMatches} 场 · {t.aiPlayerIds?.length ?? 0} 名参赛
                  </Typography>
                  <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                    {t.status === 'pending' && (
                      <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => handleStart(t.id)}>
                        启动
                      </Button>
                    )}
                    {t.status === 'running' && (
                      <Button size="small" color="warning" startIcon={<StopCircleIcon />} onClick={() => handleAbort(t.id)}>
                        中止
                      </Button>
                    )}
                    {t.status !== 'running' && (
                      <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => handleDelete(t.id)}>
                        删除
                      </Button>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>

      {/* ===== 详情 ===== */}
      {detail && (
        <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="subtitle1" fontWeight={800}>
              {detail.name} · 积分榜
            </Typography>
            <Chip
              size="small"
              color={(STATUS_META[detail.status] ?? STATUS_META.pending).color}
              label={(STATUS_META[detail.status] ?? STATUS_META.pending).label}
            />
          </Box>

          <Box sx={{ overflowX: 'auto', mt: 1.5 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>AI 玩家</TableCell>
                  <TableCell>模型</TableCell>
                  <TableCell align="right">ELO</TableCell>
                  <TableCell align="right">场次</TableCell>
                  <TableCell align="right">🥇</TableCell>
                  <TableCell align="right">🥈</TableCell>
                  <TableCell align="right">🥉</TableCell>
                  <TableCell align="right">均名次</TableCell>
                  <TableCell align="right">总分</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(detail.standings ?? []).map((s, i) => (
                  <TableRow key={s.aiPlayerId} hover>
                    <TableCell>{MEDAL[i + 1] ?? i + 1}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{s.name}</TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={s.model ?? '-'} />
                    </TableCell>
                    <TableCell align="right">{s.elo}</TableCell>
                    <TableCell align="right">{s.played}</TableCell>
                    <TableCell align="right">{s.first}</TableCell>
                    <TableCell align="right">{s.second}</TableCell>
                    <TableCell align="right">{s.third}</TableCell>
                    <TableCell align="right">{s.avgRank ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800, color: 'primary.main' }}>
                      {s.totalScore}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" fontWeight={800} gutterBottom>
            赛程（{detail.totalMatches ?? (detail.matches ?? []).length} 场）
          </Typography>
          <Stack spacing={0.75}>
            {(detail.matches ?? []).map((m) => {
              // 名次展示：result 按名次排序并映射到 AI 名字（result 可能无记录，需守卫空数组）
              const nameById = new Map((m.seats ?? []).map((s) => [s.aiPlayerId, s.name]));
              const ranked =
                m.status === 'finished' && Array.isArray(m.result) && m.result.length > 0
                  ? [...m.result].sort((a, b) => a.rank - b.rank)
                  : [];
              return (
                <Box
                  key={m.id}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', px: 1.5, py: 0.75, borderRadius: 2, bgcolor: 'action.hover' }}
                >
                  <Typography variant="body2" fontWeight={700} sx={{ minWidth: 32 }}>
                    {m.id}
                  </Typography>
                  {(m.seats ?? []).map((s) => (
                    <Chip key={s.aiPlayerId} size="small" variant="outlined" label={`${s.name}·${s.model ?? ''}`} />
                  ))}
                  {ranked.length > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      名次：
                      {ranked
                        .map((r) => {
                          const who = nameById.get(r.aiPlayerId) ?? `座位${(r.seat ?? 0) + 1}`;
                          return `${who} 第${r.rank}名·${r.score ?? 0}分`;
                        })
                        .join('、')}
                    </Typography>
                  )}
                  <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Chip
                      size="small"
                      label={
                        m.status === 'finished' ? '已结束' : m.status === 'running' ? '进行中' : m.status === 'skipped' ? '已跳过' : '待赛'
                      }
                      color={m.status === 'running' ? 'success' : 'default'}
                      variant={m.status === 'running' ? 'filled' : 'outlined'}
                    />
                    {m.status === 'finished' && m.gameId && (
                      <Button
                        size="small"
                        startIcon={<PlayCircleIcon />}
                        onClick={() => navigate(`/history/${m.gameId}`)}
                      >
                        回放
                      </Button>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
