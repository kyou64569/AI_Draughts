import { useState } from 'react';
import { Box, FormControl, InputLabel, Select, MenuItem, Button, Stack, Chip, Typography, Divider } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PersonIcon from '@mui/icons-material/Person';
import { assignSeat, startRoom } from '../../api/client.js';
import { useApp } from '../../context/AppContext.jsx';
import { SEAT_COLORS, COLOR_LABELS, COLOR_DEEP, COLOR_FILL } from '../../utils/colors.js';
/**
 * 房间座位指派面板：为每个 AI 座位下拉指派 AI 玩家；满员显示「开始对局」。
 * @param {object} room 装饰后房间（含 seats/status/isFull）
 * @param {object[]} aiPlayers
 * @param {()=>void} onChanged 座位变更后回调（刷新列表）
 * @param {()=>void} onStarted 开赛后回调
 * @param {(room:object)=>void} onEnter 进入牌桌
 */
export default function SeatPanel({ room, aiPlayers, onChanged, onStarted, onEnter }) {
  const app = useApp();
  const isSetup = room.status === 'setup';
  const [starting, setStarting] = useState(false);
  const [assigningSeat, setAssigningSeat] = useState(null);

  const handleAssign = async (seatIndex, aiPlayerId) => {
    setAssigningSeat(seatIndex);
    try {
      await assignSeat(room.id, seatIndex, aiPlayerId || null);
      app.success('座位已更新');
      onChanged?.();
    } catch (e) {
      app.error(e.message || '指派失败');
    } finally {
      setAssigningSeat(null);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    try {
      await startRoom(room.id);
      app.success('对局已开始');
      onStarted?.();
    } catch (e) {
      app.error(e.message || '开赛失败');
    } finally {
      setStarting(false);
    }
  };

  const emptySeats = room.seats.filter((s) => s.type === 'ai' && !s.aiPlayerId).length;

  return (
    <Box>
      <Stack spacing={1.2}>
        {room.seats.map((seat) => {
          const color = seat.color ?? SEAT_COLORS[seat.index] ?? 'red';
          return (
            <Box key={seat.index} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              {/* 座位色点 + 编号 */}
              <Box
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.7,
                  minWidth: 96,
                }}
              >
                <Box
                  sx={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
                    boxShadow: `0 1px 4px ${COLOR_FILL[color]}88`,
                  }}
                />
                <Typography variant="body2" fontWeight={700}>
                  #{seat.index + 1} {COLOR_LABELS[color]}方
                </Typography>
              </Box>

              {seat.type === 'human' ? (
                <Chip size="small" variant="outlined" icon={<PersonIcon />} label="人类座位" />
              ) : (
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel id={`seat-${room.id}-${seat.index}`}>指派 AI</InputLabel>
                  <Select
                    labelId={`seat-${room.id}-${seat.index}`}
                    label="指派 AI"
                    value={seat.aiPlayerId ?? ''}
                    disabled={!isSetup || assigningSeat === seat.index}
                    onChange={(e) => handleAssign(seat.index, e.target.value)}
                  >
                    <MenuItem value="">
                      <em>未指派</em>
                    </MenuItem>
                    {aiPlayers.map((p) => (
                      <MenuItem key={p.id} value={p.id}>
                        {p.name}（{p.model}）
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              {seat.aiPlayerName && (
                <Typography variant="caption" color="text.secondary">
                  已绑：{seat.aiPlayerName}
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>

      <Divider sx={{ my: 1.5 }} />

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {room.status === 'setup' && room.isFull && (
          <Button
            variant="contained"
            color="success"
            startIcon={<PlayArrowIcon />}
            onClick={handleStart}
            disabled={starting}
          >
            {starting ? '开赛中…' : '开始对局'}
          </Button>
        )}
        {room.status === 'setup' && !room.isFull && (
          <Chip color="warning" label={`未满员（还差 ${emptySeats} 个 AI 座位）`} />
        )}
        {room.status === 'playing' && <Chip color="success" label="进行中" />}
        {room.status === 'finished' && <Chip label="已结束" />}
        <Button variant="outlined" onClick={() => onEnter?.(room)}>
          {room.status === 'setup' ? '进入对局' : '查看牌桌'}
        </Button>
      </Stack>
    </Box>
  );
}
