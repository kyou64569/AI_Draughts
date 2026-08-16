import { createContext, useContext, useMemo, useState } from 'react';
import { Snackbar, Alert } from '@mui/material';

const AppCtx = createContext(null);

/** 获取全局 toast 方法：show / success / error / info。 */
export function useApp() {
  return useContext(AppCtx);
}

/**
 * 全局上下文：统一错误/成功 snackbar。
 */
export function AppProvider({ children }) {
  const [toast, setToast] = useState({ open: false, severity: 'info', msg: '' });

  const api = useMemo(
    () => ({
      show: (severity, msg) => setToast({ open: true, severity, msg: String(msg ?? '') }),
      success: (msg) => setToast({ open: true, severity: 'success', msg: String(msg ?? '') }),
      error: (msg) => setToast({ open: true, severity: 'error', msg: String(msg ?? '') }),
      info: (msg) => setToast({ open: true, severity: 'info', msg: String(msg ?? '') }),
    }),
    [],
  );

  const handleClose = () => setToast((t) => ({ ...t, open: false }));

  return (
    <AppCtx.Provider value={api}>
      {children}
      <Snackbar
        open={toast.open}
        autoHideDuration={4000}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{ mt: 1 }}
      >
        <Alert onClose={handleClose} severity={toast.severity} variant="filled" sx={{ width: '100%' }}>
          {toast.msg}
        </Alert>
      </Snackbar>
    </AppCtx.Provider>
  );
}
