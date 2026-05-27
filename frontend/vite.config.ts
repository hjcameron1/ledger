import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        timeout: 120000,      // 120s socket timeout on the proxy connection
        proxyTimeout: 120000, // 120s for the upstream response
      },
    },
  },
});
