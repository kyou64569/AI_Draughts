import { useState } from 'react';
import { Box, Button, Typography, Alert, Paper, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import VideogameAssetIcon from '@mui/icons-material/VideogameAsset';
import LiveTvIcon from '@mui/icons-material/LiveTv';
import { createRoom } from '../../api/client.js';
import { useApp } from '../../context/AppContext.jsx';
import { COLOR_DEEP, COLOR_FILL, colorLabel, MODE_SEAT_COLORS, PLAYER_COUNTS } from '../../utils/colors.js';

const MODES = [
  { value: 'human', label: '人机对战', desc: '1 名人类 + AI', icon: <VideogameAssetIcon /> },
  { value: 'watch', label: '观战模式', desc: '全部 AI 自动对局', icon: <LiveTvIcon /> },
];

/**
 * 创建房间：模式选择（人机 / 观战）+ 人机对战可选人类座位 + 创建。
 * @param {number} aiPlayerCount 已建 AI 玩家数（观战模式引导用）
 * @param {(room:object)=>void} onCreated
 */
export default function RoomCreate({ aiPlayerCount, onCreated }) {
  const app = useApp();
  const [mode, setMode] = useState('human');
  const [playerCount, setPlayerCount] = useState(3);
  const [humanSeat, setHumanSeat] = useState(0);
  const [creating, setCreating] = useState(false);
  const seatColors = MODE_SEAT_COLORS[playerCount] ?? [];

  const handleCreate = async () => {
    setCreating(true);
    try {
      const payload =
        mode === 'human'
          ? { mode, playerCount, humanSeat }
          : { mode, playerCount };
      const room = await createRoom(payload);
      app.success('房间已创建');
      onCreated?.(room);
    } catch (e) {
      app.error(e.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 4 }}>
      <Typography variant="subtitle1" fontWeight={800} gutterBottom>
        创建房间
      </Typography>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', my: 1.5 }}>
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <Box
              key={m.value}
              onClick={() => setMode(m.value)}
              sx={{
                flex: '1 1 180px',
                cursor: 'pointer',
                border: `1.5px solid ${active ? 'primary.main' : 'divider'}`,
                borderRadius: 3,
                p: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                bgcolor: active ? 'action.selected' : 'transparent',
                transition: 'all .2s ease',
                '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
              }}
            >
              <Box sx={{ color: active ? 'primary.main' : 'text.secondary', display: 'flex' }}>{m.icon}</Box>
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  {m.label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {m.desc}
                </Typography>
              </Box>
              {active && <Chip size="small" label="已选" color="primary" sx={{ ml: 'auto' }} />}
            </Box>
          );
        })}
      </Box>

      {/* 对局人数（中国跳棋标准 2/3/4/6 人） */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight={700} sx={{ mb: 1 }}>
          对局人数
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {PLAYER_COUNTS.map((n) => (
            <Chip
              key={n}
              label={`${n} 人`}
              color={playerCount === n ? 'primary' : 'default'}
              variant={playerCount === n ? 'filled' : 'outlined'}
              onClick={() => {
                setPlayerCount(n);
                setHumanSeat((s) => Math.min(s, n - 1));
              }}
            />
          ))}
        </Box>
      </Box>

      {mode === 'human' && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" fontWeight={700} sx={{ mb: 1 }}>
            你的座位（颜色）
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {seatColors.map((color, i) => {
              const active = humanSeat === i;
              return (
                <Box
                  key={color}
                  onClick={() => setHumanSeat(i)}
                  sx={{
                    cursor: 'pointer',
                    border: `1.5px solid ${active ? 'primary.main' : 'divider'}`,
                    borderRadius: 2.5,
                    px: 1.5,
                    py: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    bgcolor: active ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
                  }}
                >
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
                    }}
                  />
                  <Typography variant="body2" fontWeight={700}>
                    {colorLabel(color)}方 · 座位 {i + 1}
                  </Typography>
                  {active && <Chip size="small" label="你" color="primary" />}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleCreate}
          disabled={creating}
        >
          {creating ? '创建中…' : '创建房间'}
        </Button>
        {mode === 'watch' && aiPlayerCount < 3 && (
          <Typography variant="body2" color="warning.main">
            观战模式需要至少 3 个 AI 玩家，当前仅 {aiPlayerCount} 个。请先到「AI 玩家」页创建。
          </Typography>
        )}
      </Box>
    </Paper>
  );
}
