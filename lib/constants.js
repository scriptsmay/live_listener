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
  TOGGLE_DANMAKU: 'toggle_danmaku',
  CLEAR_COUNT: 'clear_count',
  TOGGLE_MONITOR: 'toggle_monitor',
  RECHECK_FOLLOWING: 'recheck_following',
  // background → content
  START_DANMAKU: 'start_danmaku',
  STOP_DANMAKU: 'stop_danmaku',
  // background → popup
  RECORDING_REJECTED: 'recording_rejected',
};

export const STORAGE_KEYS = {
  STREAMS: 'streams',
  NOTIFIED_ROOMS: 'notifiedRooms',
  ACTIVE_RECORDING_ROOM: 'activeRecordingRoomUrl',
  MONITOR_ENABLED: 'monitorEnabled',
  DANMAKU_ENABLED: 'danmakuEnabled',
  KUAISHOU_VISITED: 'kuaishouVisited',
  LAST_REQ_STATUS: 'lastReqStatus',
};
