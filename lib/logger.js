// lib/logger.js
// 统一日志封装，支持 debug 开关

let debugEnabled = false;

export function setDebugMode(enabled) { debugEnabled = enabled; }
export function debug(tag, ...args) { if (debugEnabled) console.log(tag, ...args); }
export function info(tag, ...args) { console.log(tag, ...args); }
export function warn(tag, ...args) { console.warn(tag, ...args); }
