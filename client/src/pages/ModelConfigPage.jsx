import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Typography,
  Stack,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  List,
  ListItem,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

import {
  listModelConfigs,
  deleteModelConfig,
  fetchModels,
  testModelConfig,
} from '../api/client.js';
import { useApp } from '../context/AppContext.jsx';
import ModelConfigList from '../components/ModelConfig/ModelConfigList.jsx';
import ModelConfigForm from '../components/ModelConfig/ModelConfigForm.jsx';

export default function ModelConfigPage() {
  const app = useApp();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [modelsDialog, setModelsDialog] = useState({ open: false, name: '', items: [] });
  const [modelsLoading, setModelsLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setConfigs(await listModelConfigs());
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
  const openEdit = (c) => {
    setEditing(c);
    setFormOpen(true);
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`确认删除模型配置「${c.name}」？`)) return;
    try {
      await deleteModelConfig(c.id);
      app.success('已删除');
      refresh();
    } catch (e) {
      app.error(e.message || '删除失败');
    }
  };

  const handleFetchModels = async (c) => {
    setModelsDialog({ open: true, name: c.name, items: [] });
    setModelsLoading(true);
    try {
      const m = await fetchModels(c.id);
      setModelsDialog((d) => ({ ...d, items: Array.isArray(m) ? m : [] }));
    } catch (e) {
      setModelsDialog((d) => ({ ...d, items: [`拉取失败：${e.message || '未知错误'}`] }));
    } finally {
      setModelsLoading(false);
    }
  };

  const handleTest = async (c) => {
    try {
      const r = await testModelConfig(c.id);
      if (r?.ok) app.success(`「${c.name}」连通成功，耗时 ${r.latencyMs}ms`);
      else app.error(`「${c.name}」连接失败：${r?.message || '未知原因'}`);
    } catch (e) {
      app.error(e.message || '测试失败');
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h4">模型配置</Typography>
          <Typography variant="body2" color="text.secondary">
            管理 LLM 服务商连接与模型列表
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          新增配置
        </Button>
      </Stack>

      {loading ? (
        <CircularProgress />
      ) : (
        <ModelConfigList
          configs={configs}
          onEdit={openEdit}
          onDelete={handleDelete}
          onFetchModels={handleFetchModels}
          onTest={handleTest}
        />
      )}

      <ModelConfigForm
        open={formOpen}
        initial={editing}
        onClose={() => setFormOpen(false)}
        onSaved={refresh}
      />

      <Dialog
        open={modelsDialog.open}
        onClose={() => setModelsDialog((d) => ({ ...d, open: false }))}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>可用模型 · {modelsDialog.name}</DialogTitle>
        <DialogContent dividers>
          {modelsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress />
            </Box>
          ) : (
            <List dense>
              {modelsDialog.items.length === 0 ? (
                <ListItem>无可用模型</ListItem>
              ) : (
                modelsDialog.items.map((m, i) => <ListItem key={i}>{m}</ListItem>)
              )}
            </List>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
