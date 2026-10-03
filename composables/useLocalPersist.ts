export function readLocal<T>(key: string, fallback: T): T {
  if (!import.meta.client) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

/** 置为 true 后下一次写入会抛错，用于演练“写盘失败后重试且号码不被占用” */
let failNextWrite = false;

export function armWriteFailure() {
  failNextWrite = true;
}

export function writeLocal<T>(key: string, value: T) {
  if (!import.meta.client) return;
  if (failNextWrite) {
    failNextWrite = false;
    throw new Error('模拟写盘失败：存储不可用');
  }
  localStorage.setItem(key, JSON.stringify(value));
}
