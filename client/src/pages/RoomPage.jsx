import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, CircularProgress } from '@mui/material';
import { listRooms, listAiPlayers, deleteRoom } from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import RoomCreate from '../components/Room/RoomCreate.jsx';
import RoomList from '../components/Room/RoomList.jsx';

export default function RoomPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState([]);
  const [aiPlayers, setAiPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [rs, ps] = await Promise.all([listRooms(), listAiPlayers()]);
      setRooms(rs);
      setAiPlayers(ps);
    } catch (e) {
      app.error(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleEnter = (room) => navigate(`/rooms/${room.id}`);

  const handleDelete = async (room) => {
    const tip =
      room.status === 'playing'
        ? '该房间对局正在进行中，删除将中断对局，确定删除？'
        : `确认删除房间 ${room.id.slice(0, 8)}？`;
    if (!window.confirm(tip)) return;
    try {
      await deleteRoom(room.id);
      app.success('已删除');
      refresh();
    } catch (e) {
      app.error(e.message || '删除失败');
    }
  };

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h4">对局大厅</Typography>
        <Typography variant="body2" color="text.secondary">
          创建房间、指派 AI 玩家，或进入牌桌观战
        </Typography>
      </Box>
      <RoomCreate aiPlayerCount={aiPlayers.length} onCreated={refresh} />
      {loading ? (
        <CircularProgress />
      ) : (
        <Box>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            房间列表（{rooms.length}）
          </Typography>
          <RoomList
            rooms={rooms}
            aiPlayers={aiPlayers}
            onChanged={refresh}
            onStarted={refresh}
            onEnter={handleEnter}
            onDelete={handleDelete}
          />
        </Box>
      )}
    </Box>
  );
}
