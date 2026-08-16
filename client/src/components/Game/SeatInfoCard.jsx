import { Box, Typography, Chip, LinearProgress } from '@mui/material';
import { COLOR_DEEP, COLOR_FILL, COLOR_LABELS, colorLabel } from '../../utils/colors.js';

/**
 * 座位 / 玩家信息卡（2026-08 重构）。
 * 左色条 + 头像 + 名称；当前回合高亮边框与光晕；营地进度条。
 * @param {object} player GameState.players[i]
 * @param {boolean} isCurrentTurn 是否当前回合
 * @param {boolean} isAutoPilot 是否托管（auto-pilot）
 */
export default function SeatInfoCard({ player, isCurrentTurn, isAutoPilot }) {
  const color = player.color;
  const typeLabel = player.kind === 'human' ? '人类' : `AI · ${player.name || '未命名'}`;
  const modelLabel = player.kind === 'ai' && player.model ? ` · ${player.model}` : '';
  const inTarget = player.inTarget ?? 0;
  const progress = Math.round((inTarget / 10) * 100);

  return (
    <Box
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 3,
        border: `1px solid ${isCurrentTurn ? COLOR_FILL[color] : 'divider'}`,
        borderWidth: isCurrentTurn ? 2 : 1,
        bgcolor: 'background.paper',
        boxShadow: isCurrentTurn ? `0 0 0 3px ${COLOR_FILL[color]}22` : 'none',
        transition: 'all .25s ease',
      }}
    >
      {/* 左侧色条 */}
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 5,
          background: `linear-gradient(180deg, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
        }}
      />
      <Box sx={{ p: 1.5, pl: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Box
            sx={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              color: '#fff',
              fontWeight: 800,
              fontSize: 13,
              background: `radial-gradient(circle at 35% 30%, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
              boxShadow: `0 2px 8px ${COLOR_FILL[color]}66`,
            }}
          >
            {COLOR_LABELS[color]}
          </Box>
          <Typography fontWeight={700} sx={{ flex: 1 }}>
            {colorLabel(color)}方
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
              (座位 {player.seat + 1})
            </Typography>
          </Typography>
          {isCurrentTurn && (
            <Chip size="small" label="行动中" sx={{ bgcolor: COLOR_FILL[color], color: '#fff', fontWeight: 700 }} />
          )}
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {typeLabel}
          {modelLabel}
        </Typography>

        <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{
              flex: 1,
              height: 7,
              borderRadius: 4,
              bgcolor: 'action.hover',
              '& .MuiLinearProgress-bar': {
                borderRadius: 4,
                background: `linear-gradient(90deg, ${COLOR_FILL[color]}, ${COLOR_DEEP[color] ?? COLOR_FILL[color]})`,
              },
            }}
          />
          <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, textAlign: 'right' }}>
            {inTarget} / 10
          </Typography>
        </Box>

        {isAutoPilot && (
          <Chip size="small" sx={{ mt: 1 }} label="托管(auto-pilot)" variant="outlined" color="warning" />
        )}
      </Box>
    </Box>
  );
}
