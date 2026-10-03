// 测试垫片：用内存 Map 模拟 localStorage，并让写盘失败开关可控
const mem = new Map();
let failNext = false;

export function readLocal(key, fallback) {
  const raw = mem.get(key);
  return raw ? JSON.parse(raw) : fallback;
}
export function writeLocal(key, value) {
  if (failNext) {
    failNext = false;
    throw new Error('模拟写盘失败：存储不可用');
  }
  mem.set(key, JSON.stringify(value));
}
export function armWriteFailure() { failNext = true; }
export function __resetPersist() { mem.clear(); failNext = false; }
