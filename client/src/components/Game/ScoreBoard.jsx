import { useEffect, useState } from 'react';
import {
  Paper,
  Typography,
  Box,
  Stack,
  LinearProgress,
  Chip,
  Modal,
  Fade,
  Button,
  Divider,
} from '@mui/material';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import { COLOR_DEEP, COLOR_FILL, colorLabel } from '../../utils/colors.js';

const RANK_META = {
  1: { label: '冠军', color: '#fbbf24' },
  2: { label: '亚军', color: '#cbd5e1' },
  3: { label: '季军', color: '#f59e0b' },
};

/**
 * 实时积分榜（在营数）+ 终局排名覆盖层。
 * 改用 Stack + 进度条的自定义行（避免 MUI Table 在窄栏折行）。
 * @param {object|null} game GameState
 * @param {boolean} finished 是否已终局
 */
export default function ScoreBoard({ game, finished }) {
  const [open, setOpen] = useState(false);

  // 终局时自动弹出排名覆盖层（finished 由 false→true 时触发，而非仅初始化时）
  useEffect(() => {
    if (finished && game?.scores?.length) setOpen(true);
  }, [finished, game?.scores?.length]);

  if (!game) {
    return (
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          尚未开始
        </Typography>
      </Paper>
    );
  }

  const players = game.players;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25 }}>
        <EmojiEventsIcon fontSize="small" color="warning" />
        <Typography variant="subtitle2">实时进度（在营数）</Typography>
      </Box>

      <Stack divider={<Divider flexItem />} spacing={1.25}>
        {players.map((p) => {
          const inTarget = p.inTarget ?? 0;
          const progress = Math.round((inTarget / 10) * 100);
          return (
            <Box key={p.seat}>
              {/* 第一行：色点 + 名称 + 状态徽标 */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, mb: 0.5 }}>
                <Box
                  sx={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[p.color]}, ${COLOR_DEEP[p.color] ?? COLOR_FILL[p.color]})`,
                    boxShadow: `0 1px 4px ${COLOR_FILL[p.color]}88`,
                    flexShrink: 0,
                  }}
                />
                <Typography variant="body2" sx={{ fontWeight: 700, flex: 1 }} noWrap>
                  {colorLabel(p.color)}方{p.kind === 'human' ? '（你）' : ''}
                </Typography>
                {p.finishRank ? (
                  <Chip
                    size="small"
                    label={`第 ${p.finishRank} 名`}
                    sx={{
                      bgcolor: `${RANK_META[p.finishRank]?.color ?? '#64748b'}26`,
                      color: RANK_META[p.finishRank]?.color ?? '#64748b',
                      fontWeight: 700,
                    }}
                  />
                ) : game.turnSeat === p.seat ? (
                  <Chip size="small" color="warning" label="行动中" />
                ) : (
                  <Chip size="small" variant="outlined" label="等待" />
                )}
              </Box>
              {/* 第二行：进度条 + 数字 */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={progress}
                  sx={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    bgcolor: 'action.hover',
                    '& .MuiLinearProgress-bar': {
                      borderRadius: 3,
                      background: `linear-gradient(90deg, ${COLOR_FILL[p.color]}, ${COLOR_DEEP[p.color] ?? COLOR_FILL[p.color]})`,
                    },
                  }}
                />
                <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, textAlign: 'right' }}>
                  {inTarget} / 10
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Stack>

      {finished && game.scores?.length > 0 && (
        <FinalOverlay
          open={open}
          scores={game.scores}
          endReason={game.endReason}
          onClose={() => setOpen(false)}
        />
      )}
    </Paper>
  );
}

/**
 * 终局排名覆盖层（Modal）。
 */
function FinalOverlay({ open, scores, endReason, onClose }) {
  return (
    <Modal open={open} onClose={onClose} closeAfterTransition>
      <Fade in={open}>
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 400,
            maxWidth: '92vw',
            bgcolor: 'background.paper',
            borderRadius: 4,
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: 24,
            p: 3,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <EmojiEventsIcon color="warning" />
            <Typography variant="h6" fontWeight={800}>
              对局结束
            </Typography>
          </Box>
          {endReason && (
            <Typography variant="body2" color="text.secondary" gutterBottom>
              结束原因：{endReason}
            </Typography>
          )}
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {scores.map((s) => (
              <Box
                key={s.seat}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  py: 0.6,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography sx={{ minWidth: 56, fontWeight: 700 }}>
                  {RANK_META[s.rank]?.label ?? `第 ${s.rank} 名`}
                </Typography>
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[s.color]}, ${COLOR_DEEP[s.color] ?? COLOR_FILL[s.color]})`,
                  }}
                />
                <Typography sx={{ flex: 1 }}>
                  {colorLabel(s.color)}方{s.name ? `·${s.name}` : ''}
                </Typography>
                <Typography sx={{ fontWeight: 800, minWidth: 36, textAlign: 'right' }}>
                  {s.score}
                </Typography>
              </Box>
            ))}
          </Stack>
          <Button fullWidth sx={{ mt: 2.5 }} variant="contained" onClick={onClose}>
            关闭
          </Button>
        </Box>
      </Fade>
    </Modal>
  );
}