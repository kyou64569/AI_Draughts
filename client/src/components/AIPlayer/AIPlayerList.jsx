import { Table, TableHead, TableBody, TableRow, TableCell, Button, Stack, Chip, Typography, Paper } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import SmartToyIcon from '@mui/icons-material/SmartToy';

/** 思考强度展示名。 */
const THINKING_LABEL = {
  default: '模型默认',
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
};

/**
 * AI 玩家列表表格（2026-08 重构：卡片容器）。
 * @param {object[]} players 公开 AI 玩家（含 modelConfigName）
 * @param {(p:object)=>void} onEdit
 * @param {(p:object)=>void} onDelete
 */
export default function AIPlayerList({ players, onEdit, onDelete }) {
  if (!players.length) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', borderRadius: 4 }}>
        <SmartToyIcon sx={{ fontSize: 44, color: 'text.disabled', mb: 1 }} />
        <Typography color="text.secondary">暂无 AI 玩家，请先建立模型配置。</Typography>
      </Paper>
    );
  }
  return (
    <Paper variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>名称</TableCell>
            <TableCell>绑定配置</TableCell>
            <TableCell>模型</TableCell>
            <TableCell>思考强度</TableCell>
            <TableCell align="right">ELO</TableCell>
            <TableCell align="right">操作</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {players.map((p) => (
            <TableRow key={p.id} hover>
              <TableCell sx={{ fontWeight: 700 }}>{p.name}</TableCell>
              <TableCell>
                {p.modelConfigName ?? <Chip size="small" label="已解绑" color="warning" variant="outlined" />}
              </TableCell>
              <TableCell>
                <Chip size="small" variant="outlined" label={p.model} />
              </TableCell>
              <TableCell>
                <Chip size="small" label={THINKING_LABEL[p.thinkingLevel] ?? '模型默认'} />
              </TableCell>
              <TableCell align="right">
                <Chip
                  size="small"
                  color={p.elo >= 1300 ? 'success' : p.elo <= 1100 ? 'default' : 'primary'}
                  label={p.elo ?? 1200}
                  title="ELO 评分：AI 对 AI 对局按名次自动更新"
                />
              </TableCell>
              <TableCell align="right">
                <Stack direction="row" spacing={0.8} justifyContent="flex-end" useFlexGap>
                  <Button size="small" startIcon={<EditIcon />} onClick={() => onEdit(p)}>
                    编辑
                  </Button>
                  <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => onDelete(p)}>
                    删除
                  </Button>
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
