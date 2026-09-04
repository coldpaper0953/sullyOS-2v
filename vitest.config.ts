import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Workers 运行时自带的虚拟模块，node 上解析不到（不给别名的话，import 到它的
      // 测试文件整个加载失败）。打包侧的对应处理是 build-workers.mjs 里的 external。
      // 注意必须用 fileURLToPath：URL.pathname 在 Windows 上是 "/D:/..." 带前导斜杠，
      // vitest 解析不到（Linux 上 pathname 碰巧可用，CI 全绿掩盖了这个坑）。
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test-setup.ts'],
    include: [
      'utils/**/*.test.ts',
      'worker/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    // 排除 React 组件 / 浏览器集成测 (没装 jsdom)
    exclude: ['node_modules', '**/node_modules/**', '.worktrees', 'dist'],
  },
});
