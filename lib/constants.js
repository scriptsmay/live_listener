// lib/constants.js
// 集中管理所有消息 action 名称和 storage key，消除魔法字符串

export const ACTIONS = {
  // content → background
  ADD_MEDIA: 'add_media',
  DANMAKU_READY: 'danmaku_ready',
  DANMAKU_BATCH: 'danmaku_batch',
  DANMAKU_STOP: 'danmaku_stop',
  // popup → background
  GET_DANMAKU_STATUS: 'get_danmaku_status',
  RETRY_DANMAKU_STATUS: 'retry_danmaku_status',
  TOGGLE_DANMAKU: 'toggle_danmaku',
  CLEAR_COUNT: 'clear_count',
  TOGGLE_MONITOR: 'toggle_monitor',
  RECHECK_FOLLOWING: 'recheck_following',
  CHECK_NOW: 'check_now',
  GET_POLL_SCHEDULE: 'get_poll_schedule',
  // background → content
  START_DANMAKU: 'start_danmaku',
  STOP_DANMAKU: 'stop_danmaku',
  DANMAKU_HEALTH_CHECK: 'danmaku_health_check',
  // background → popup
  RECORDING_REJECTED: 'recording_rejected',
};

// 关注列表轮询 alarm 名称（following-poll.js 创建，options 页面只读展示）
export const POLL_ALARM_NAME = 'pollFollowingLivings';

// 自动标签页健康恢复参数（D3）
// - 连续 N 次探测失败才触发恢复，避免网络抖动/单次消息丢失造成误重载
// - 失败计数与冷却锁均持久化：MV3 SW 空闲销毁后仍能跨唤醒累计，
//   否则每次唤醒都从 1/N 重新计数，永远达不到阈值
// - 恢复冷却锁覆盖页面加载阶段，防止消息通道未就绪导致重载风暴
export const DANMAKU_HEALTH = {
  PROBE_FAILURE_THRESHOLD: 2,
  RECOVERY_COOLDOWN_MS: 30 * 1000,
  PROBE_INTERVAL_MS: 30 * 1000,
  PROBE_TIMEOUT_MS: 3000,
  // 重载/新建标签页后等待 content script 就绪并补发 start_danmaku 的重试参数
  RESUME_RETRY_DELAY_MS: 2000,
  RESUME_MAX_ATTEMPTS: 10,
  // 恢复后在该时间窗内的健康探测会补发 start_danmaku（防止 SW 在重载后被回收）
  RESUME_RESEND_WINDOW_MS: 2 * 60 * 1000,
  // "本次 reload 由扩展发起"的标记有效期：页面 unload 的 danmaku_stop 只在该窗口内被忽略。
  // 只需覆盖 reload 到 unload 消息到达的几秒钟，取值偏小以缩小误忽略真实离开的窗口。
  RELOAD_EXPECTED_TTL_MS: 60 * 1000,
  // 恢复相关持久化记录的清理阈值（失败计数 / 冷却时间戳 / 重载标记）
  RECOVERY_RECORD_MAX_AGE_MS: 10 * 60 * 1000,
};

export const STORAGE_KEYS = {
  STREAMS: 'streams',
  NOTIFIED_ROOMS: 'notifiedRooms',
  ACTIVE_RECORDING_ROOM: 'activeRecordingRoomUrl',
  MONITOR_ENABLED: 'monitorEnabled',
  DANMAKU_ENABLED: 'danmakuEnabled',
  KUAISHOU_VISITED: 'kuaishouVisited',
  LAST_REQ_STATUS: 'lastReqStatus',
  AUTO_OPENED_TABS: 'autoOpenedTabs',
  DANMAKU_LAST_RECOVERY: 'danmakuLastRecoveryAt',
  DANMAKU_PROBE_FAILURES: 'danmakuProbeFailures',
  DANMAKU_RELOAD_EXPECTED: 'danmakuReloadExpected',
};
