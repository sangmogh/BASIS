// 검토 결론: 반영 시점별 대응안과 우선 검토안 (숫자는 모두 엔진 계산)
// 회의 화면에서 옮겨 둔 목표일(draft.target)은 쓰지 않는다. 조건(팀별 기간 · 준비 기간)만 받는다.
import type { Change } from "../data/types.js"
import {
  type Context,
  type SimOptions,
  type SimResult,
  type SimRow,
  type TeamCheck,
  type TeamRow,
  earliestFeasible,
  segments,
  teamCheck,
} from "./simulate.js"

export type ResponseOption = {
  from: string // 이 결과로 반영할 수 있는 첫날 (모든 팀이 맞출 수 있는 날부터)
  to: string // 이 결과가 유지되는 마지막 날
  result: SimResult // to에 반영할 때 호선별 결과
  check: TeamCheck // to에 반영할 때 팀별 판정
  decideBy: string // 이 안을 지키려면 늦어도 결정할 날
}

// 다음 안으로 넘어가면 바뀌는 호선과 그 까닭 (블록이 한 단계 넘어감 · 자재가 늦게 옴)
export type Shift = {
  vessel: string
  order: string
  block: string
  event: "착수" | "제작 완료" | "탑재" | "자재 입고"
  date: string
  handling: string
  delay: number
  extra: number // 앞 안보다 늘어난 지연 일수
}

export type Review = {
  options: ResponseOption[] // 팀이 맞출 수 있는 안, 이른 순으로 최대 3개
  recommended: number // options 안의 번호 (맞출 수 있는 안이 없으면 -1)
  blocked: { to: string; result: SimResult; short: TeamRow[] } | null // 더 좋은 결과가 있지만 팀이 못 맞추는 안
  unavoidable: SimRow[] // 우선 검토안에서도 늦어지는 호선
  direct: SimRow[] // 우선 검토안에서 바로 반영되는 호선
  next: Shift[] // 우선 검토안을 넘기면 바뀌는 것
}

const EVENT = { hold: "착수", rework: "제작 완료", "rework-erected": "탑재" } as const

export function shiftsBetween(change: Change, a: SimResult, b: SimResult): Shift[] {
  return b.rows.flatMap((row, i) => {
    const prev = a.rows[i]
    if (prev.kind === row.kind && prev.delay === row.delay) return []
    const event: Shift["event"] = prev.kind !== row.kind && row.kind !== "apply" ? EVENT[row.kind] : "자재 입고"
    const date =
      event === "착수" ? row.block.start : event === "제작 완료" ? row.block.end : event === "탑재" ? row.block.mount : (row.arrival ?? b.target)
    return [
      {
        vessel: row.vessel.id,
        order: row.vessel.order,
        block: change.block,
        event,
        date,
        handling: row.handling,
        delay: row.delay,
        extra: row.delay - prev.delay,
      },
    ]
  })
}

export function review(ctx: Context, change: Change, opts: SimOptions = {}): Review {
  const earliest = earliestFeasible(ctx, change, opts)
  const segs = segments(ctx, change, opts)
  const options: ResponseOption[] = []
  for (const s of segs) {
    if (options.length >= 3) break
    if (!earliest || s.end < earliest) continue
    const check = teamCheck(ctx, change, s.end, opts)
    if (!check.ok) continue
    options.push({ from: s.start < earliest ? earliest : s.start, to: s.end, result: check.sim, check, decideBy: check.decideBy })
  }
  // 지연 합계가 가장 작은 안 (같으면 이른 안)
  const recommended = options.reduce((best, o, i) => (best < 0 || o.result.totalDelay < options[best].result.totalDelay ? i : best), -1)
  const rec = options[recommended]
  // 맨 앞 구간(가장 좋은 결과)을 팀이 못 맞추면, 무엇이 모자라서인지
  const first = segs[0]
  let blocked: Review["blocked"] = null
  if (first && (!earliest || first.end < earliest)) {
    const check = teamCheck(ctx, change, first.end, opts)
    blocked = { to: first.end, result: check.sim, short: check.rows.filter((r) => !r.possible) }
  }
  return {
    options,
    recommended,
    blocked,
    unavoidable: rec ? rec.result.rows.filter((r) => r.delay > 0) : [],
    direct: rec ? rec.result.rows.filter((r) => r.delay === 0) : [],
    next: rec && options[recommended + 1] ? shiftsBetween(change, rec.result, options[recommended + 1].result) : [],
  }
}

// 우선 검토안 하나만 비교할 때 쓰는 요약 (조건을 바꾸기 전 · 후)
export function reviewKey(r: Review) {
  const rec = r.options[r.recommended]
  return rec ? { to: rec.to, decideBy: rec.decideBy, total: rec.result.totalDelay, tightest: rec.check.tightest } : null
}
