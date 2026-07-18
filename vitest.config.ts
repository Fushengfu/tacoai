import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // renderer 代码使用 jsdom 环境（模拟浏览器 DOM）
    // SDK 共享代码使用 node 环境
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 全局超时 10 秒
    testTimeout: 10000,
  },
})
