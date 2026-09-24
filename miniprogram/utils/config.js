/**
 * 服务器地址配置
 *   小程序没有「同源」概念：wx.request 必须使用完整地址，且线上必须是 HTTPS + 已在小程序后台配置为合法域名。
 *   开发者工具里可勾选「不校验合法域名」以便本地联调（http://电脑IP:8787）。
 */
const BASE_KEY = 'fundwatch_api_base';
const DEFAULT_BASE = ''; // 可在打包前写死，例如 'https://your-app.vercel.app'

function getBaseUrl() {
  const saved = wx.getStorageSync(BASE_KEY);
  return (saved || DEFAULT_BASE || '').replace(/\/+$/, '');
}

function setBaseUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) wx.setStorageSync(BASE_KEY, clean);
  else wx.removeStorageSync(BASE_KEY);
  return clean;
}

function hasBaseUrl() {
  return Boolean(getBaseUrl());
}

module.exports = { BASE_KEY, DEFAULT_BASE, getBaseUrl, setBaseUrl, hasBaseUrl };
