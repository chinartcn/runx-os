import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'RunX OS',
  description: '跑在浏览器里的网页桌面操作系统',
  lang: 'zh-CN',
  base: '/',
  lastUpdated: true,
  cleanUrls: true,
  // 死链检查：README 里的相对链接指向仓库（站点上不存在），
  // localhost 链接是本地开发地址 —— 这两类不该算死链。
  ignoreDeadLinks: [
    /\.\.\/\.\.\/\.js\//,
    /\.\.\/README/,
    /^http:\/\/localhost/,
  ],
  themeConfig: {
    nav: [
      { text: '指南', link: '/' },
      { text: '能力', link: '/reference/capabilities' },
      { text: 'SDK', link: '/reference/sdk' },
      { text: 'UI 库', link: '/reference/ui' },
      { text: '商店', link: '/reference/store' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '介绍', link: '/' },
            { text: '安装与启动', link: '/guide/install' },
            { text: '写第一个应用', link: '/guide/first-app' },
            { text: '扩展模型', link: '/guide/extensions' },
          ],
        },
        {
          text: '深入',
          items: [
            { text: '权限与围栏', link: '/guide/security' },
            { text: '设计文档', link: '/guide/design' },
          ],
        },
      ],
      '/reference/': [
        {
          text: '参考',
          items: [
            { text: '能力清单', link: '/reference/capabilities' },
            { text: '@runx/sdk', link: '/reference/sdk' },
            { text: '@runx/host', link: '/reference/host' },
            { text: '@runx/ui', link: '/reference/ui' },
            { text: '应用商店', link: '/reference/store' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/chinartcn/runx-os' },
    ],
    search: {
      provider: 'local',
    },
    footer: {
      message: 'MIT 开源 · RunX OS',
      copyright: 'RunX OS',
    },
  },
});
