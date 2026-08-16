import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  Typography,
  List,
  ListItem,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  fetchModels,
  testModelConfig,
  createModelConfig,
  updateModelConfig,
} from '../../api/client.js';
import { useApp } from '../../context/AppContext.jsx';

/**
 * 新增/编辑模型配置表单（含 拉取模型 与 测试连通）。
 * 安全约束：apiKey 输入框 type=password 且编辑时不回显已有值（留空表示保留原值）。
 *
 * @param {boolean} open
 * @param {()=>void} onClose
 * @param {object|null} initial 编辑时的配置对象（公开字段，无 apiKey）
 * @param {()=>void} onSaved
 */
export default function ModelConfigForm({ open, onClose, initial, onSaved }) {
  const app = useApp();
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '' });
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [test, setTest] = useState(null);

  useEffect(() => {
    if (open) {
      setForm({
        name: initial?.name ?? '',
        baseUrl: initial?.baseUrl ?? '',
        apiKey: '', // 出于安全：编辑时不回显已有 key
      });
      setModels([]);
      setTest(null);
    }
  }, [open, initial]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      app.error('名称与 Base URL 不能为空');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        const patch = { name: form.name.trim(), baseUrl: form.baseUrl.trim() };
        if (form.apiKey.trim() !== '') patch.apiKey = form.apiKey.trim();
        await updateModelConfig(initial.id, patch);
        app.success('模型配置已更新');
      } else {
        await createModelConfig({
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
        });
        app.success('模型配置已创建');
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      app.error(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleFetchModels = async () => {
    if (!isEdit) {
      app.info('请先保存配置再拉取模型');
      return;
    }
    setModelsLoading(true);
    setModels([]);
    try {
      const m = await fetchModels(initial.id);
      setModels(Array.isArray(m) ? m : []);
    } catch (e) {
      app.error(e.message || '拉取模型失败');
    } finally {
      setModelsLoading(false);
    }
  };

  const handleTest = async () => {
    if (!isEdit) {
      app.info('请先保存配置再测试');
      return;
    }
    setTest(null);
    try {
      const r = await testModelConfig(initial.id);
      setTest(r);
    } catch (e) {
      setTest({ ok: false, message: e.message || '测试失败' });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isEdit ? '编辑模型配置' : '新增模型配置'}</DialogTitle>
      <DialogContent dividers>
        <TextField
          label="名称"
          fullWidth
          margin="normal"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <TextField
          label="Base URL"
          fullWidth
          margin="normal"
          placeholder="https://api.openai.com/v1"
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
        <TextField
          label="API Key"
          type="password"
          fullWidth
          margin="normal"
          autoComplete="new-password"
          value={form.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
          helperText={
            isEdit ? '留空表示保留原值（出于安全不回显）' : '仅保存在服务端，前端不可见、不可见网络请求外泄'
          }
        />

        {isEdit && (
          <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button variant="outlined" onClick={handleFetchModels} disabled={modelsLoading}>
              {modelsLoading ? <CircularProgress size={18} /> : '拉取模型'}
            </Button>
            <Button variant="outlined" onClick={handleTest}>
              测试连通
            </Button>
          </Box>
        )}

        {models.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2">可用模型（{models.length}）</Typography>
            <List dense sx={{ maxHeight: 160, overflow: 'auto', bgcolor: 'grey.50', borderRadius: 1 }}>
              {models.map((m) => (
                <ListItem key={m}>{m}</ListItem>
              ))}
            </List>
          </Box>
        )}

        {test && (
          <Alert severity={test.ok ? 'success' : 'error'} sx={{ mt: 1 }}>
            {test.ok ? `连通成功，耗时 ${test.latencyMs}ms` : `连接失败：${test.message}`}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
