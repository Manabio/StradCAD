import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // import '../../core.js' を '@core' と書けるようにする
      '@core': path.resolve(__dirname, 'src/core.js'),
    },
  },
});
