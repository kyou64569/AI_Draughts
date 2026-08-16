import { Card, CardContent, Typography, Box, IconButton, Tooltip, Chip } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import SeatPanel from './SeatPanel.jsx';

const STATUS_META = {
  setup: { label: '布置中', color: 'default' },
  playing: { label: '进行中', color: 'success' },
  finished: { label: '已结束', color: 'default' },
};

/**
 * 房间列表（2026-08 重构：卡片化 + 状态徽标）。
 * @param {object[]} rooms
 * @param {object[]} aiPlayers
 * @param {()=>void} onChanged
 * @param {()=>void} onStarted
 * @param {(room:object)=>void} onEnter
 * @param {(room:object)=>void} onDelete
 */
export default function RoomList({ rooms, aiPlayers, onChanged, onStarted, onEnter, onDelete }) {
  if (!rooms.length) {
    return (
      <Box sx={{ py: 6, textAlign: 'center' }}>
        <MeetingRoomIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 1 }} />
        <Typography color="text.secondary">暂无房间，请创建。</Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rooms.map((room) => {
        const meta = STATUS_META[room.status] ?? { label: room.status, color: 'default' };
        return (
          <Card key={room.id} variant="outlined" sx={{ borderRadius: 4 }}>
            <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
                <Box
                  sx={{
                    width: 34,
                    height: 34,
                    borderRadius: 2.5,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                    color: '#fff',
                  }}
                >
                  <MeetingRoomIcon fontSize="small" />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography fontWeight={800}>
                    房间 {room.id.slice(0, 8)}
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {room.mode === 'human' ? '人机对战' : '观战模式'}
                    </Typography>
                  </Typography>
                </Box>
                <Chip size="small" label={meta.label} color={meta.color} variant={room.status === 'playing' ? 'filled' : 'outlined'} />
                <Tooltip title={room.status === 'playing' ? '删除房间（将中断进行中的对局）' : '删除房间'}>
                  <span>
                    <IconButton edge="end" onClick={() => onDelete?.(room)} size="small" color="error">
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
              <SeatPanel
                room={room}
                aiPlayers={aiPlayers}
                onChanged={onChanged}
                onStarted={onStarted}
                onEnter={onEnter}
              />
            </CardContent>
          </Card>
        );
      })}
    </Box>
  );
}
