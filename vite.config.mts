import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * 前后端分离开发：
 *   前端 vite dev → 5173（监听局域网，便于手机扫码调试）
 *   后端 node scripts/dev-server.mjs → 8787
 * 开发期把 /api 代理到后端（服务端转发，因此手机只需访问 5173）；
 * 生产环境由 Vercel 的 api/** 函数同源提供，前端代码无需改动。
 * 一键启动前后端：pnpm start
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // 监听 0.0.0.0，手机可通过局域网 IP 访问
    allowedHosts: true, // 允许用局域网 IP / 自定义域名访问（仅开发环境）
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false },
    },
    // 编辑器/工具写文件时常产生临时目录与 .tmp，被监视会触发 EBUSY 崩溃，显式忽略
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/.*.tmpdir/**', '**/*.tmp'],
    },
  },
  // 预览构建产物时同样代理 /api，便于本地按“生产模式”联调与测试
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false },
    },
  },
  // 多页应用：前台 index.html + 后台管理 admin.html（管理员以新标签页打开）
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
});
