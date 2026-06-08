// core/event-bus.js
// 事件总线 — 用事件驱动替代模块间的直接函数调用
// 使上游模块不需要知道下游有哪些消费者

const listeners = new Map(); // event -> Set<callback>

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
}

export function off(event, callback) {
  listeners.get(event)?.delete(callback);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((cb) => {
    try { cb(payload); } catch (err) {
      console.warn(`[EventBus] handler error on '${event}':`, err);
    }
  });
}

// 事件名称常量
export const EVENTS = {
  STREAM_DETECTED: 'stream_detected',
  RECORDING_STARTED: 'recording_started',
  RECORDING_STOPPED: 'recording_stopped',
  RECORDING_REJECTED: 'recording_rejected',
  DANMAKU_SESSION_CREATED: 'danmaku_session_created',
  DANMAKU_SENDING_STARTED: 'danmaku_sending_started',
  DANMAKU_SENDING_STOPPED: 'danmaku_sending_stopped',
};
