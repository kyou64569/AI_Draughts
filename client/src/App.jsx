import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';

import NavBar from './components/Layout/NavBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// 代码分割：按页面懒加载，减小首屏包体积（棋盘页/回放页较重）
const ModelConfigPage = lazy(() => import('./pages/ModelConfigPage.jsx'));
const AIPlayerPage = lazy(() => import('./pages/AIPlayerPage.jsx'));
const RoomPage = lazy(() => import('./pages/RoomPage.jsx'));
const GamePage = lazy(() => import('./pages/GamePage.jsx'));
const HistoryPage = lazy(() => import('./pages/HistoryPage.jsx'));
const ReplayPage = lazy(() => import('./pages/ReplayPage.jsx'));
const TournamentPage = lazy(() => import('./pages/TournamentPage.jsx'));

/** 懒加载页面的过渡占位。 */
function PageFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
      <CircularProgress />
    </Box>
  );
}

export default function App() {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <NavBar />
      <Box
        component="main"
        sx={{
          flex: 1,
          width: '100%',
          maxWidth: 1440,
          mx: 'auto',
          px: { xs: 1.5, sm: 2.5, md: 3.5 },
          py: { xs: 2, md: 3 },
        }}
      >
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/rooms" replace />} />
              <Route path="/model-configs" element={<ModelConfigPage />} />
              <Route path="/ai-players" element={<AIPlayerPage />} />
              <Route path="/rooms" element={<RoomPage />} />
              <Route path="/rooms/:id" element={<GamePage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/history/:id" element={<ReplayPage />} />
              <Route path="/tournaments" element={<TournamentPage />} />
              <Route path="*" element={<Navigate to="/rooms" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </Box>
    </Box>
  );
}
