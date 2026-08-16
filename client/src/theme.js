import { createTheme } from '@mui/material/styles';

/**
 * AI 中国跳棋 · 设计系统（2026-08 重构；仅深色模式，2026-08-16 移除浅色）
 *
 *  - 品牌主色：紫罗兰（violet）→ 深色背景取亮紫；
 *  - 背景：slate 深蓝灰（默认页 + 卡片）；
 *  - 形状：大圆角（16/12）营造现代游戏质感；
 *  - 组件覆盖：Button/Card/Paper/Chip/Table/Dialog 等统一视觉语言。
 */

const FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

/** 品牌色。 */
const BRAND = {
  violet: { light: '#8b5cf6', dark: '#7c3aed', deep: '#6d28d9' },
  cyan: '#22d3ee',
};

/** 棋子配色（与 utils/colors.js 保持一致的语义，但视觉更鲜亮）。 */
export const PIECE_COLORS = {
  red: '#f43f5e',
  green: '#10b981',
  blue: '#38bdf8',
};

/** 深色模式 tokens。 */
const darkPalette = {
  mode: 'dark',
  primary: { main: BRAND.violet.light, dark: BRAND.violet.deep },
  secondary: { main: BRAND.cyan },
  background: { default: '#0b1220', paper: '#121a2d' },
  text: { primary: '#e6edf7', secondary: '#93a4bd' },
  divider: 'rgba(148, 163, 184, 0.16)',
  success: { main: '#22c55e' },
  warning: { main: '#f59e0b' },
  error: { main: '#f87171' },
  info: { main: '#38bdf8' },
  action: { hover: 'rgba(139, 92, 246, 0.08)', selected: 'rgba(139, 92, 246, 0.14)' },
  grey: {
    100: '#1e293b',
    200: '#26344c',
    300: '#334155',
    400: '#475569',
    500: '#64748b',
    600: '#94a3b8',
    700: '#cbd5e1',
    800: '#e2e8f0',
    900: '#f1f5f9',
  },
};

/**
 * 构建深色主题（仅深色模式）。
 * @returns {import('@mui/material').Theme}
 */
export function buildTheme() {
  const palette = darkPalette;

  return createTheme({
    palette,
    typography: {
      fontFamily: FONT,
      h4: { fontWeight: 800, letterSpacing: '-0.02em' },
      h5: { fontWeight: 800, letterSpacing: '-0.02em' },
      h6: { fontWeight: 700 },
      subtitle1: { fontWeight: 700 },
      subtitle2: { fontWeight: 700 },
      button: { fontWeight: 600, textTransform: 'none' },
    },
    shape: { borderRadius: 12 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundImage:
              'radial-gradient(1200px 600px at 15% -10%, rgba(139,92,246,0.16), transparent 55%), radial-gradient(1000px 500px at 110% 0%, rgba(34,211,238,0.08), transparent 50%)',
            backgroundAttachment: 'fixed',
          },
          '::-webkit-scrollbar': { width: 10, height: 10 },
          '::-webkit-scrollbar-thumb': {
            background: '#334155',
            borderRadius: 8,
          },
          '::-webkit-scrollbar-track': { background: 'transparent' },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            transition: 'box-shadow .25s ease, border-color .25s ease',
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 16,
            border: `1px solid ${palette.divider}`,
            boxShadow: '0 4px 20px rgba(0,0,0,0.28)',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            paddingInline: 14,
          },
          containedPrimary: {
            backgroundImage: `linear-gradient(135deg, ${BRAND.violet.light}, ${BRAND.violet.dark})`,
            boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
            '&:hover': {
              backgroundImage: `linear-gradient(135deg, ${BRAND.violet.light}, ${BRAND.violet.deep})`,
              boxShadow: '0 6px 18px rgba(124,58,237,0.45)',
            },
          },
          outlined: {
            borderColor: palette.divider,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderBottom: `1px solid ${palette.divider}`,
          },
          head: {
            fontWeight: 700,
            color: palette.text.secondary,
            textTransform: 'uppercase',
            fontSize: '0.72rem',
            letterSpacing: '0.05em',
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 18, backgroundImage: 'none' },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: 'rgba(11,18,32,0.82)',
            color: palette.text.primary,
            backdropFilter: 'blur(14px) saturate(1.4)',
            borderBottom: `1px solid ${palette.divider}`,
            boxShadow: 'none',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            fontSize: '0.75rem',
            borderRadius: 8,
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 12 },
        },
      },
      MuiSnackbar: {
        defaultProps: {
          anchorOrigin: { vertical: 'top', horizontal: 'center' },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: { borderRadius: 10 },
        },
      },
    },
  });
}

/** 默认导出（深色主题）。 */
export default buildTheme();
