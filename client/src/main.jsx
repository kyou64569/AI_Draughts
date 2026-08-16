import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';

import App from './App.jsx';
import { AppProvider } from './context/AppContext.jsx';
import { buildTheme } from './theme.js';
import { sound } from './utils/sound.js';
import './index.css';

/** 应用根：固定深色主题（仅深色模式）+ 全局按钮点击音效。 */
function Root() {
  const theme = buildTheme();

  // 全局按钮音效：点击任意按钮/链接触发（棋盘格是 svg，不在选择器内，不受影响）
  useEffect(() => {
    const handler = (e) => {
      const btn = e.target?.closest?.(
        'button, [role="button"], .MuiButtonBase-root, .MuiIconButton-root, a[href], [data-sound="click"]',
      );
      if (btn) sound.click();
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </AppProvider>
  </React.StrictMode>,
);
