import { Component } from 'react';
import { Box, Paper, Typography, Button, Stack } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

/**
 * 全局错误边界：捕获子树渲染异常，避免单个页面崩溃导致整站白屏。
 * 必须是 class 组件（React 目前仅支持 class 的 componentDidCatch）。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6, px: 2 }}>
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 560, borderRadius: 4 }}>
          <Stack spacing={1.5}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <ErrorOutlineIcon color="error" />
              <Typography variant="h6" fontWeight={800}>
                页面出了点问题
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              页面渲染时发生异常，已阻止崩溃扩散。可尝试重试或返回房间列表。
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                bgcolor: 'action.hover',
                p: 1,
                borderRadius: 1,
                wordBreak: 'break-all',
                maxHeight: 120,
                overflow: 'auto',
              }}
            >
              {String(error?.message ?? error)}
            </Typography>
            <Stack direction="row" spacing={1.5}>
              <Button variant="contained" onClick={this.handleReset}>
                重试
              </Button>
              <Button variant="outlined" onClick={() => window.location.assign('/rooms')}>
                返回房间列表
              </Button>
            </Stack>
          </Stack>
        </Paper>
      </Box>
    );
  }
}
