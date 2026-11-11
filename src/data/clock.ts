// 시연 시계. 합성 데이터는 series.json의 today(지금은 2026-10-28)를 '오늘'로 놓고 만들었다(DATA_ANCHOR).
// 화면은 실제 오늘(한국 시간)을 쓰고, 합성 데이터의 날짜를 그만큼 옮겨서 마감 D-4 · 빨간 날짜 같은 관계를 매일 그대로 둔다.
// 주소에 ?today=YYYY-MM-DD를 붙이면 그 날로 고정한다 (발표일 미리 보기 · 점검용)
import { BASE_YEAR, addDays, daysBetween, formatShort } from "../engine/dates.js"
import series from "./series.json" with { type: "json" }

// 데이터셋의 "오늘" (series.json의 today). 데이터셋이 바뀌면 같이 바뀐다
export const DATA_ANCHOR: string = series.today

const ISO = /^\d{4}-\d{2}-\d{2}$/
// formatShort 모양의 날짜: 11/7, '27 1/5 (앞에 해가 없으면 기준 해)
const LABEL = /(?:'(\d{2}) )?\b(\d{1,2})\/(\d{1,2})\b/g

const pad = (n: number) => String(n).padStart(2, "0")
export const isIsoDate = (value: string) => ISO.test(value) && addDays(value, 0) === value

// 한국 시간 기준 오늘
export function koreaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

// 고정한 날짜(?today=)가 맞으면 그 날, 아니면 한국 시간 오늘
export function clockToday(pinned?: string | null) {
  return pinned && isIsoDate(pinned) && Math.abs(daysBetween(DATA_ANCHOR, pinned)) <= 3 * 366 ? pinned : koreaToday()
}

// 글 안의 날짜(11/7, '27 1/5)를 옮긴다
export function shiftLabel(text: string, days: number) {
  if (!days || !text.includes("/")) return text
  return text.replace(LABEL, (whole, yy: string | undefined, m: string, d: string) => {
    const iso = `${yy ? 2000 + Number(yy) : BASE_YEAR}-${pad(Number(m))}-${pad(Number(d))}`
    return isIsoDate(iso) ? formatShort(addDays(iso, days)) : whole
  })
}

// 값 안의 모든 날짜를 옮긴다: "YYYY-MM-DD" 값은 그대로, 글 안의 11/7 · '27 1/5도. 키는 건드리지 않는다
export function shiftDates<T>(value: T, days: number): T {
  if (!days) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return isIsoDate(v) ? addDays(v, days) : shiftLabel(v, days)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}
