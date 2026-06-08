// core/danmaku-switch.js
// 弹幕采集开关逻辑

import { getState } from './state.js';
import { getConfig } from './config.js';
import { ACTIONS } from '../lib/constants.js';

/**
 * 设置弹幕采集开关状态，持久化并通知所有直播间标签页
 * @param {boolean} enabled - 是否启用弹幕采集
 */
export async function setDanmakuEnabled(enabled) {
  await chrome.storage.sync.set({ danmakuEnabled: enabled });
  console.log(`[Danmaku] 弹幕采集开关已${enabled ? '开启' : '关闭'}`);

  // 通知所有快手直播间标签页
  try {
    const tabs = await chrome.tabs.query({ url: '*://live.kuaishou.com/*' });
    for (const tab of tabs) {
      chrome.tabs
        .sendMessage(tab.id, {
          action: enabled ? ACTIONS.START_DANMAKU : ACTIONS.STOP_DANMAKU,
        })
        .catch(() => {});
    }
  } catch (_) {}
}

/**
 * 检查是否还有活跃的弹幕发送会话，若无则自动关闭开关
 */
export async function autoDisableDanmakuIfIdle() {
  const state = getState();
  let hasActiveSession = false;
  for (const [, session] of state.danmakuSessions) {
    if (session.isSending && !session.stopping) {
      hasActiveSession = true;
      break;
    }
  }
  if (!hasActiveSession) {
    const config = await getConfig();
    if (config.danmakuEnabled) {
      await setDanmakuEnabled(false);
    }
  }
}
