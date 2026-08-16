import { useEffect, useRef } from 'react';
import {
  Paper,
  Typography,
  Box,
  List,
  ListItem,
  ListItemText,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PsychologyIcon from '@mui/icons-material/Psychology';
import { COLOR_FILL, colorLabel } from '../../utils/colors.js';

function timeStr(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

/**
 * 决策理由日志侧栏（可滚动，新日志自动滚到底）。
 * @param {Array} logs LogEntry[]（seat/color/model/thinking/reason/from/to/isFallback/timestamp）
 * @param {'panel'|'drawer'} [variant='panel'] 桌面用 panel，移动端用抽屉式 Accordion
 */
export default function DecisionLog({ logs, variant = 'panel' }) {
  const endRef = useRef(null);
  const list = logs || [];

  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [list.length]);

  const body = (
    <List dense sx={{ maxHeight: variant === 'panel' ? 560 : 320, overflow: 'auto' }}>
      {list.length === 0 ? (
        <ListItem>
          <ListItemText
            primary={
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                暂无决策日志
              </Typography>
            }
          />
        </ListItem>
      ) : (
        list.map((l, i) => (
          <ListItem key={i} alignItems="flex-start" divider sx={{ px: 1.5 }}>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    label={l.color ? `${colorLabel(l.color)}方` : `座位${l.seat + 1}`}
                    sx={{
                      bgcolor: l.color ? COLOR_FILL[l.color] : 'grey.400',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  />
                  {l.isFallback && <Chip size="small" color="warning" variant="outlined" label="兜底" />}
                  <Typography variant="caption" color="text.secondary">
                    {timeStr(l.timestamp)}
                  </Typography>
                </Box>
              }
              secondary={
                <Box sx={{ mt: 0.5, '& b': { color: 'text.primary', fontWeight: 700 } }}>
                  {l.thinking ? (
                    <div>
                      <b>思考：</b>
                      {l.thinking}
                    </div>
                  ) : null}
                  {l.reason ? (
                    <div>
                      <b>理由：</b>
                      {l.reason}
                    </div>
                  ) : null}
                  {l.from && l.to ? (
                    <div>
                      <b>走子：</b>
                      {l.from} → {l.to}
                    </div>
                  ) : null}
                </Box>
              }
            />
          </ListItem>
        ))
      )}
      <div ref={endRef} />
    </List>
  );

  if (variant === 'drawer') {
    return (
      <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', mt: 1, borderRadius: 3 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PsychologyIcon fontSize="small" color="primary" />
            <Typography variant="subtitle2">决策日志（{list.length}）</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>{body}</AccordionDetails>
      </Accordion>
    );
  }

  return (
    <Paper variant="outlined" sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <PsychologyIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2">决策日志（{list.length}）</Typography>
      </Box>
      {body}
    </Paper>
  );
}
