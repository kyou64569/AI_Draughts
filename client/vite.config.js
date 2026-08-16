import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev server 端口可经 VITE_PORT 设置（默认 5173）。
const port = Number(process.env.VITE_PORT) || 5173;

// 前端统一通过 VITE_API_BASE（默认 http://localhost:3001）访问后端，跨域时
// 由后端 CORS 放行全部来源；此处保留 /api 代理作为本地调试兜底（未启用绝对 URL 时使用）。
export default defineConfig({
  plugins: [react()],
  server: {
    port,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  preview: {
    port,
    host: true,
  },
});
