import { useEffect, useState } from 'react';
import { Box, Button, Typography, Stack, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

import { listAiPlayers, listModelConfigs, deleteAiPlayer } from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import AIPlayerList from '../components/AIPlayer/AIPlayerList.jsx';
import AIPlayerForm from '../components/AIPlayer/AIPlayerForm.jsx';

export default function AIPlayerPage() {
  const app = useApp();
  const [players, setPlayers] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [ps, cs] = await Promise.all([listAiPlayers(), listModelConfigs()]);
      setPlayers(ps);
      setConfigs(cs);
    } catch (e) {
      app.error(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (p) => {
    setEditing(p);
    setFormOpen(true);
  };

  const handleDelete = async (p) => {
    if (!window.confirm(`确认删除 AI 玩家「${p.name}」？`)) return;
    try {
      await deleteAiPlayer(p.id);
      app.success('已删除');
      refresh();
    } catch (e) {
      // 被房间占用 → 后端 409，message 已含提示
      app.error(e.message || '删除失败');
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h4">AI 玩家</Typography>
          <Typography variant="body2" color="text.secondary">
            为对局配置 AI 棋手（模型绑定）
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          disabled={configs.length === 0}
        >
          新增玩家
        </Button>
      </Stack>

      {configs.length === 0 && (
        <Typography color="warning.main">
          尚未创建任何模型配置，请先到「模型配置」页建立配置后再来绑定 AI 玩家。
        </Typography>
      )}

      {loading ? (
        <CircularProgress />
      ) : (
        <AIPlayerList players={players} onEdit={openEdit} onDelete={handleDelete} />
      )}

      <AIPlayerForm
        open={formOpen}
        initial={editing}
        configs={configs}
        onClose={() => setFormOpen(false)}
        onSaved={refresh}
      />
    </Box>
  );
}
