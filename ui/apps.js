/**
 * App 注册表 —— 全项目唯一需要改的地方。
 *
 * 加一个 App 就是加一行 + 建一个目录。别的地方都不用动。
 * 这条约束不是洁癖：上一代同类项目把"App 在哪注册"和"App 在哪释放"
 * 写在两个地方，不同步之后内存只涨不掉，还不报错。
 *
 * load 是动态 import —— 手机启动只加载桌面，点进去才拉代码。
 */

export const APPS = [
  {
    id: 'chat',
    name: '消息',
    icon: '💬',
    accent: '#4f8cff',
    badge: 'chat',           // 未读数从哪来
    load: () => import('./apps/chat/index.js'),
  },
  {
    id: 'moments',
    name: '朋友圈',
    icon: '🖼️',
    accent: '#ff7a59',
    badge: 'moments',
    load: () => import('./apps/moments/index.js'),
  },
  {
    id: 'settings',
    name: '设置',
    icon: '⚙️',
    accent: '#8c93a8',
    load: () => import('./apps/settings/index.js'),
  },
];

/** 桌面第一页摆哪几个（顺序即位置） */
export const HOME = ['chat', 'moments', 'settings'];

export const findApp = (id) => APPS.find(a => a.id === id) ?? null;
