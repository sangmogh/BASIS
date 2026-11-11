// 날짜는 "YYYY-MM-DD" 문자열로 다루고 계산은 UTC로 한다.
// 현지 시간으로 만든 뒤 toISOString()을 쓰면 한국(UTC+9)에서 하루가 밀린다.
import series from "../data/series.json" with { type: "json" }

const DAY = 86400000

function parseDay(date: string) {
  const [y, m, d] = date.split("-").map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDays(date: string, days: number) {
  return new Date(parseDay(date) + days * DAY).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string) {
  return Math.round((parseDay(to) - parseDay(from)) / DAY)
}

export const minDate = (...dates: string[]) => dates.reduce((a, b) => (b < a ? b : a))
export const maxDate = (...dates: string[]) => dates.reduce((a, b) => (b > a ? b : a))

// 기준 해: 데이터셋 "오늘"(series.json today)의 해. 이 해의 날짜는 11/7, 다른 해는 '27 1/5
export const BASE_YEAR = Number(series.today.slice(0, 4))

export function formatShort(date: string) {
  const value = new Date(parseDay(date))
  const year = value.getUTCFullYear()
  return `${year === BASE_YEAR ? "" : `'${String(year).slice(2)} `}${value.getUTCMonth() + 1}/${value.getUTCDate()}`
}

export function dday(today: string, date: string) {
  const days = daysBetween(today, date)
  return days === 0 ? "D-day" : days > 0 ? `D-${days}` : `D+${-days}`
}
