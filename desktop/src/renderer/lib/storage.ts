/** 从 localStorage 读取 JSON，失败时返回 fallback */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** 将值序列化为 JSON 写入 localStorage */
export function saveJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

/** 生成唯一消息 ID */
let _seq = 0
export function uid() {
  return `m${Date.now()}-${++_seq}`
}

/** 将时间戳格式化为相对时间（刚刚 / 3m / 2h / 1d） */
export function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}
