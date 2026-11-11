// 엔진 공용: 날짜(반열림 [시작, 끝)), 확실성, 금액 표기
export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export type Tables = Record<string, Row[]>

// ── 날짜: 'YYYY-MM-DD'. 시작 + 일수 = 끝(다음 날). 모든 날짜 계산은 여기서만
export const dayOf = (iso: string) => iso.slice(0, 10)
export function addDays(date: string, days: number) {
  const d = new Date(`${dayOf(date)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export const diffDays = (from: string, to: string) => Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${dayOf(from)}T00:00:00Z`)) / 86_400_000)
export const maxDay = (...days: (string | null | undefined)[]) => days.filter((d): d is string => !!d).sort().at(-1) ?? null
export const minDay = (...days: (string | null | undefined)[]) => days.filter((d): d is string => !!d).sort()[0] ?? null

// ── 확실성: 계산한 숫자는 재료 중 가장 약한 확실성을 따른다
export type Certainty = "confirmed" | "provisional" | "case" | "assumption"
const RANK: Record<Certainty, number> = { confirmed: 0, provisional: 1, case: 2, assumption: 3 }
export const CERTAINTY_LABEL: Record<Certainty, string> = { confirmed: "확정", provisional: "잠정", case: "사례", assumption: "가정" }
export function weakest(...list: (Certainty | null | undefined)[]): Certainty {
  return list.filter((c): c is Certainty => !!c).reduce<Certainty>((a, b) => (RANK[b] > RANK[a] ? b : a), "confirmed")
}
// 출처가 붙은 값
export type Sourced<T> = { value: T; certainty: Certainty; source: string }
export const sourced = <T>(value: T, certainty: Certainty, source: string): Sourced<T> => ({ value, certainty, source })

// ── 금액: 원 → '1억 2,345만원'
export function won(amount: number) {
  const sign = amount < 0 ? "−" : ""
  const man = Math.round(Math.abs(amount) / 10_000)
  if (man === 0) return `${sign}${Math.abs(Math.round(amount)).toLocaleString("ko-KR")}원`
  const eok = Math.floor(man / 10_000)
  const rest = man % 10_000
  return `${sign}${eok ? `${eok}억` : ""}${eok && rest ? " " : ""}${rest ? `${rest.toLocaleString("ko-KR")}만` : ""}원`
}

export const sum = (list: number[]) => list.reduce((a, b) => a + b, 0)
export function median(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
export function groupBy<T>(list: T[], key: (x: T) => string) {
  const map = new Map<string, T[]>()
  for (const x of list) {
    const k = key(x)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(x)
  }
  return map
}
