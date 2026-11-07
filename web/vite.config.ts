import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
/** 功能：配置独立Vue开发代理及静态构建；参数：mode为Vite模式；返回值：配置，不修改运行中的服务。 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return { plugins:[vue()], base:'./', server:{ port:5173, strictPort:true, proxy:{ '/api':{ target:env.VITE_API_TARGET || 'http://127.0.0.1:8787', changeOrigin:false } } }, build:{ outDir:'dist', chunkSizeWarningLimit:1100, rollupOptions:{output:{manualChunks(id){if(id.includes('/node_modules/echarts/')||id.includes('/node_modules/zrender/'))return 'charts';if(id.includes('/node_modules/element-plus/')||id.includes('/node_modules/@element-plus/'))return 'element-plus';if(id.includes('/node_modules/vue/')||id.includes('/node_modules/@vue/')||id.includes('/node_modules/vue-router/')||id.includes('/node_modules/pinia/'))return 'vue-core';}}} } };
});
