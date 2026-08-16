import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
} from '@mui/material';
import { createAiPlayer, updateAiPlayer } from '../../api/client.js';
import { useModels } from '../../hooks/useModels.js';
import { useApp } from '../../context/AppContext.jsx';

/** 思考强度选项（语义：模型自身是否经过思考做决策；越高越慢越准、token 越多）。 */
const THINKING_OPTIONS = [
  { value: 'default', label: '跟随模型默认', hint: '不额外传参，用模型自带默认' },
  { value: 'off', label: '关闭', hint: '几乎不思考，最快最省' },
  { value: 'low', label: '低', hint: '轻量思考' },
  { value: 'medium', label: '中', hint: '标准思考' },
  { value: 'high', label: '高', hint: '深度思考，最慢但最准' },
];

/**
 * 新增/编辑 AI 玩家表单：名称 + 绑定模型配置 + 选择具体模型 + 思考强度。
 * 模型下拉来自所选配置的 GET /:id/models；若无可拉取模型则退回文本输入。
 *
 * @param {boolean} open
 * @param {()=>void} onClose
 * @param {object|null} initial
 * @param {object[]} configs 模型配置列表
 * @param {()=>void} onSaved
 */
export default function AIPlayerForm({ open, onClose, initial, configs, onSaved }) {
  const app = useApp();
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState({ name: '', modelConfigId: '', model: '', thinkingLevel: 'default' });
  const [saving, setSaving] = useState(false);

  const activeConfigId = form.modelConfigId || (isEdit ? initial?.modelConfigId : configs[0]?.id);
  const { models, loading: modelsLoading } = useModels(activeConfigId);

  useEffect(() => {
    if (open) {
      setForm({
        name: initial?.name ?? '',
        modelConfigId: initial?.modelConfigId ?? (configs[0]?.id ?? ''),
        model: initial?.model ?? '',
        thinkingLevel: initial?.thinkingLevel ?? 'default',
      });
    }
  }, [open, initial, configs]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // 选项包含当前已选模型（即使不在拉取列表中，也保证可回显/可保留）。
  const modelOptions = useMemo(() => {
    if (!form.model) return models;
    return models.includes(form.model) ? models : [form.model, ...models];
  }, [models, form.model]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      app.error('名称不能为空');
      return;
    }
    if (!form.modelConfigId) {
      app.error('请选择模型配置');
      return;
    }
    if (!form.model.trim()) {
      app.error('请选择或填写模型名');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        modelConfigId: form.modelConfigId,
        model: form.model.trim(),
        thinkingLevel: form.thinkingLevel,
      };
      if (isEdit) {
        await updateAiPlayer(initial.id, payload);
        app.success('AI 玩家已更新');
      } else {
        await createAiPlayer(payload);
        app.success('AI 玩家已创建');
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      app.error(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isEdit ? '编辑 AI 玩家' : '新增 AI 玩家'}</DialogTitle>
      <DialogContent dividers>
        <TextField
          label="玩家名称"
          fullWidth
          margin="normal"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
        />

        <FormControl fullWidth margin="normal">
          <InputLabel id="cfg-label">模型配置</InputLabel>
          <Select
            labelId="cfg-label"
            label="模型配置"
            value={form.modelConfigId}
            onChange={(e) => {
              set('modelConfigId', e.target.value);
              set('model', '');
            }}
          >
            {configs.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {activeConfigId ? (
          modelsLoading ? (
            <Box sx={{ mt: 1 }}>
              <CircularProgress size={18} />
            </Box>
          ) : modelOptions.length > 0 ? (
            <FormControl fullWidth margin="normal">
              <InputLabel id="model-label">模型（来自配置拉取）</InputLabel>
              <Select
                labelId="model-label"
                label="模型（来自配置拉取）"
                value={form.model}
                onChange={(e) => set('model', e.target.value)}
              >
                {modelOptions.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : (
            <TextField
              label="模型名（该配置暂无可拉取模型，请手动填写）"
              fullWidth
              margin="normal"
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
            />
          )
        ) : (
          <TextField
            label="模型名"
            fullWidth
            margin="normal"
            helperText="也可直接填写具体模型名"
            value={form.model}
            onChange={(e) => set('model', e.target.value)}
          />
        )}

        <FormControl fullWidth margin="normal">
          <InputLabel id="thinking-label">思考强度</InputLabel>
          <Select
            labelId="thinking-label"
            label="思考强度"
            value={form.thinkingLevel}
            onChange={(e) => set('thinkingLevel', e.target.value)}
          >
            {THINKING_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
          <Box component="p" sx={{ mt: 0.5, mb: 0, typography: 'caption', color: 'text.secondary' }}>
            {THINKING_OPTIONS.find((o) => o.value === form.thinkingLevel)?.hint}
            {' 思考强度越高，决策越慢、消耗 token 越多、通常越准确。'}
          </Box>
        </FormControl>
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
