import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  IconButton,
  Drawer,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Tooltip,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import ExtensionIcon from '@mui/icons-material/Extension';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import { sound } from '../../utils/sound.js';

const NAV = [
  { to: '/rooms', label: '对局大厅', icon: '♟' },
  { to: '/history', label: '历史战绩', icon: '🏆' },
  { to: '/model-configs', label: '模型配置', icon: '⚙' },
  { to: '/ai-players', label: 'AI 玩家', icon: '🤖' },
];

export default function NavBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.isEnabled());

  const toggleSound = () => {
    const on = sound.toggle();
    setSoundOn(on);
    if (on) sound.click(); // 开启时给一个反馈音
  };

  const isActive = (to) =>
    to === '/rooms' ? location.pathname.startsWith('/rooms') : location.pathname.startsWith(to);

  return (
    <AppBar position="sticky" elevation={0}>
      <Toolbar sx={{ gap: 1, minHeight: 60 }}>
        {/* 品牌 */}
        <Box
          onClick={() => navigate('/rooms')}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            mr: 2,
            flexShrink: 0,
          }}
        >
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
              boxShadow: '0 2px 10px rgba(124,58,237,0.45)',
              color: '#fff',
            }}
          >
            <ExtensionIcon fontSize="small" />
          </Box>
          <Typography
            variant="subtitle1"
            sx={{ fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}
          >
            AI 中国跳棋
          </Typography>
        </Box>

        {/* 桌面导航 */}
        <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'flex' }, gap: 0.5 }}>
          {NAV.map((item) => (
            <Button
              key={item.to}
              component={Link}
              to={item.to}
              sx={{
                borderRadius: 10,
                px: 2,
                color: isActive(item.to) ? 'primary.main' : 'text.secondary',
                bgcolor: isActive(item.to) ? 'action.selected' : 'transparent',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              {item.label}
            </Button>
          ))}
        </Box>

        {/* 音效开关 */}
        <Tooltip title={soundOn ? '关闭音效' : '开启音效'}>
          <IconButton onClick={toggleSound} size="small" sx={{ color: 'text.secondary' }}>
            {soundOn ? <VolumeUpIcon /> : <VolumeOffIcon />}
          </IconButton>
        </Tooltip>

        {/* 移动端汉堡 */}
        <Box sx={{ display: { xs: 'flex', md: 'none' } }}>
          <IconButton color="inherit" edge="end" onClick={() => setOpen(true)} aria-label="菜单">
            <MenuIcon />
          </IconButton>
        </Box>
      </Toolbar>

      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <Box sx={{ width: 240 }} role="presentation">
          <Box sx={{ p: 2, pb: 1 }}>
            <Typography variant="subtitle1" fontWeight={800}>
              AI 中国跳棋
            </Typography>
          </Box>
          <Divider />
          <List>
            {NAV.map((item) => (
              <ListItemButton
                key={item.to}
                selected={isActive(item.to)}
                onClick={() => {
                  setOpen(false);
                  navigate(item.to);
                }}
                sx={{ borderRadius: 2, mx: 1 }}
              >
                <Box component="span" sx={{ mr: 1.5, opacity: 0.9 }}>
                  {item.icon}
                </Box>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ))}
          </List>
        </Box>
      </Drawer>
    </AppBar>
  );
}
