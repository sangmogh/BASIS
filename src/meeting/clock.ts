// 새 화면(설계변경 목록 · 회의 화면)의 시연 시계.
//   데이터셋은 dataset.as_of(지금은 2026-10-29) 시점의 스냅숏이다. 화면은 실제 오늘(한국 시간)을 쓰고,
//   받은 값의 날짜를 as_of → 오늘만큼 옮겨서 D-0 · 지연 일수 같은 관계는 매일 그대로 둔다.
//   주소에 ?today=YYYY-MM-DD를 붙이면 그 날로 고정 (발표일 미리 보기 · 점검용)
//   기록 시각(at · recorded_at 같은 실제 UTC 시각)은 옮기지 않는다. 서버로 날짜를 보낼 때는 같은 만큼 되돌려야 한다
import { addDays, daysBetween } from "../engine/dates.js"
import { clockToday, isIsoDate, shiftLabel } from "../data/clock"

const EMBEDDED = /\b(\d{4}-\d{2}-\d{2})(?!T|\d)/g
const BUSINESS_TIME = new Set(["asOf", "receivedAt"])

// 화면 기준 오늘 (?today= 고정이 있으면 그 날)
export function screenToday() {
  const pinned = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("today")
  return clockToday(pinned)
}

// 데이터셋 기준일(as_of) → 화면 오늘까지 며칠
export function offsetFrom(asOf?: string | null) {
  const base = asOf?.slice(0, 10)
  return base && isIsoDate(base) ? daysBetween(base, screenToday()) : 0
}

// 값 안의 업무 날짜를 모두 옮긴다: "YYYY-MM-DD" 값, 글 안의 YYYY-MM-DD · 11/7 · '27 1/5, 기준 시각 asOf
export function shiftView<T>(value: T, days: number): T {
  if (!days) return value
  const text = (v: string) =>
    shiftLabel(
      v.replace(EMBEDDED, (whole, d: string) => (isIsoDate(d) ? addDays(d, days) : whole)),
      days,
    )
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (isIsoDate(v)) return addDays(v, days)
      // 업무 시각(데이터셋 시계)인 날짜+시각: 기준 시각 · 접수 시각. 실제 기록 시각(at 등)은 옮기지 않는다
      if (BUSINESS_TIME.has(key) && isIsoDate(v.slice(0, 10))) return `${addDays(v.slice(0, 10), days)}${v.slice(10)}`
      return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : text(v)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(value, "") as T
}
