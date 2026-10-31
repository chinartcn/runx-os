/**
 * 文档站主题定制。
 *
 * 只做一件事：配色与字体换成 RunX 的那一套（见 custom.css）。
 * 布局、搜索、侧边栏都用 VitePress 自带的 —— 不跟它较劲。
 */

import DefaultTheme from 'vitepress/theme';
import './custom.css';

export default {
  extends: DefaultTheme,
};
