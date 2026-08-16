import { Routes, Route, Navigate } from 'react-router-dom';
import { Box } from '@mui/material';

import NavBar from './components/Layout/NavBar.jsx';
import ModelConfigPage from './pages/ModelConfigPage.jsx';
import AIPlayerPage from './pages/AIPlayerPage.jsx';
import RoomPage from './pages/RoomPage.jsx';
import GamePage from './pages/GamePage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';

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
        <Routes>
          <Route path="/" element={<Navigate to="/rooms" replace />} />
          <Route path="/model-configs" element={<ModelConfigPage />} />
          <Route path="/ai-players" element={<AIPlayerPage />} />
          <Route path="/rooms" element={<RoomPage />} />
          <Route path="/rooms/:id" element={<GamePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="*" element={<Navigate to="/rooms" replace />} />
        </Routes>
      </Box>
    </Box>
  );
}
