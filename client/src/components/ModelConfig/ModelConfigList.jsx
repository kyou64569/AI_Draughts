import { Table, TableHead, TableBody, TableRow, TableCell, Button, Stack, Chip, Typography, Paper } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ListAltIcon from '@mui/icons-material/ListAlt';
import CableIcon from '@mui/icons-material/Cable';

/**
 * 模型配置列表表格（2026-08 重构：卡片容器）。
 * @param {object[]} configs 公开模型配置（含 modelCount / hasApiKey）
 * @param {(c:object)=>void} onEdit
 * @param {(c:object)=>void} onDelete
 * @param {(c:object)=>void} onFetchModels
 * @param {(c:object)=>void} onTest
 */
export default function ModelConfigList({ configs, onEdit, onDelete, onFetchModels, onTest }) {
  if (!configs.length) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', borderRadius: 4 }}>
        <Typography color="text.secondary">暂无模型配置，点击右上角「新增配置」。</Typography>
      </Paper>
    );
  }
  return (
    <Paper variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>名称</TableCell>
            <TableCell>Base URL</TableCell>
            <TableCell>模型数</TableCell>
            <TableCell>API Key</TableCell>
            <TableCell align="right">操作</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {configs.map((c) => (
            <TableRow key={c.id} hover>
              <TableCell sx={{ fontWeight: 700 }}>{c.name}</TableCell>
              <TableCell sx={{ maxWidth: 280, wordBreak: 'break-all' }}>{c.baseUrl}</TableCell>
              <TableCell>{c.modelCount ?? 0}</TableCell>
              <TableCell>
                {c.hasApiKey ? (
                  <Chip size="small" label="已配置" color="success" />
                ) : (
                  <Chip size="small" label="未配置" variant="outlined" />
                )}
              </TableCell>
              <TableCell align="right">
                <Stack direction="row" spacing={0.8} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                  <Button size="small" startIcon={<ListAltIcon />} onClick={() => onFetchModels(c)}>
                    拉取模型
                  </Button>
                  <Button size="small" startIcon={<CableIcon />} onClick={() => onTest(c)}>
                    测试连通
                  </Button>
                  <Button size="small" startIcon={<EditIcon />} onClick={() => onEdit(c)}>
                    编辑
                  </Button>
                  <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => onDelete(c)}>
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
