// 대응안 비교: A 일반 조달 / B 긴급 조달 / C 기존 부품 보강.
// 안마다 검토 결론(review)을 돌려 반영 시점 · 결정 마감 · 호선별 결과를 얻고, 그 위에 비용과 납기 초과를 계산한다.
// 추천은 선주 우선순위 순서로 비교해 정한다 (같은 입력이면 늘 같은 답 — AI는 고르지 않고 설명만 한다).
import type { Change, Criterion, Method, RecoveryMeasure } from "../data/types.js"
import { daysBetween } from "./dates.js"
import { type Review, type ResponseOption, review } from "./review.js"
import { type Context, type SimOptions, type SimResult, redDate, targetRange, teamCheck } from "./simulate.js"

export const METHOD_LABEL: Record<Method, string> = { A: "일반 조달", B: "긴급 조달", C: "기존 부품 보강" }
export const CRITERION_LABEL: Record<Criterion, string> = { schedule: "일정", cost: "비용", disruption: "생산 차질" }
export const DEFAULT_PRIORITY: Criterion[] = ["schedule", "disruption", "cost"]

export type Cost = {
  material: number // 새 자재 (만원)
  reinforce: number // 보강 자재 · 외주
  expedite: number // 긴급 조달 추가 비용
  labor: number // 재작업 · 보강 · 수정 작업비 (처리 일수 × 하루 작업비)
  recovery: number // 납기 만회 (잔업 · 병행 작업)
  total: number // 직접 비용 합계
  ldRisk: number // 납기를 넘기면 물 수 있는 지체상금 (직접 비용에 넣지 않고 위험으로 보여 줌)
}

// 계약 납기 대비: 지연 · 여유 · 넘는 날, 넘는 날을 만회 수단으로 얼마나 줄였나
export type Overrun = {
  vessel: string
  order: string
  handling: string
  delay: number
  margin: number
  over: number // 만회 전 납기 초과
  recovered: Array<{ name: string; days: number; cost: number }>
  remaining: number // 만회하고도 남는 납기 초과 (빨간색)
}

export type MethodPlan = {
  method: Method
  label: string
  review: Review
  rec: ResponseOption | null // 이 안의 우선 검토 시점 (없으면 이 안은 범위 안에서 맞출 수 없음)
  cost: Cost
  overruns: Overrun[] // 계약 납기 여유를 넘는 호선 (만회 포함)
  absorbed: Overrun[] // 여유 안에서 흡수된 호선 (인도일 계약 납기 유지)
  overDays: number // 만회하고도 남는 납기 초과 합계 (일정 기준은 이 값)
  rawOverDays: number // 만회 전 납기 초과 합계
  delayDays: number // 지연 합계
  touched: number // 손대는 척수 (재작업 · 보강 · 중단)
  approvals: string[] // 먼저 받아야 하는 승인
}

export type MethodComparison = {
  plans: MethodPlan[]
  priority: Criterion[]
  recommended: Method | null
}

// 이 변경에서 고를 수 있는 안: A는 늘, B는 긴급 조달 입력이 있을 때, C는 보강 입력이 있을 때
export function methodsOf(change: Change): Method[] {
  return ["A", ...(change.material && change.options?.expedite ? (["B"] as const) : []), ...(change.options?.reinforce ? (["C"] as const) : [])]
}

export function costOf(ctx: Context, change: Change, result: SimResult, method: Method, overDays = 0, recovery = 0): Cost {
  const unit = change.material?.unitCost ?? 0
  const newParts = result.rows.filter((r) => !r.reinforced).length
  const material = change.material ? unit * newParts : 0
  const reinforce = (change.options?.reinforce?.cost ?? 0) * result.rows.filter((r) => r.reinforced).length
  const bought = result.rows.some((r) => r.source === "buy")
  const expedite = method === "B" && bought ? (change.options?.expedite?.premium ?? 0) : 0
  const labor = (ctx.costs?.reworkPerDay ?? 0) * result.rows.reduce((sum, r) => sum + r.processDays, 0)
  return { material, reinforce, expedite, labor, recovery, total: material + reinforce + expedite + labor + recovery, ldRisk: (ctx.costs?.ldPerDay ?? 0) * overDays }
}

// 넘는 날을 싼 만회 수단부터 채운다 (호선 하나에 수단마다 최대 일수까지)
export function recover(over: number, measures: RecoveryMeasure[] = []) {
  const used: Overrun["recovered"] = []
  let left = over
  for (const m of [...measures].sort((a, b) => a.costPerDay - b.costPerDay)) {
    if (left <= 0) break
    const days = Math.min(left, m.days)
    used.push({ name: m.name, days, cost: days * m.costPerDay })
    left -= days
  }
  return { used, remaining: left }
}

// 계약 납기 여유: 계약 납기 - 계획 인도일 (계약 납기가 없으면 여유 0). 여유를 넘는 날은 만회 수단으로 줄여 본다
export function overrunsOf(result: SimResult, measures: RecoveryMeasure[] = []): Overrun[] {
  return result.rows
    .filter((r) => r.delay > 0)
    .map((r) => {
      const margin = r.vessel.contractDelivery ? Math.max(0, daysBetween(r.vessel.delivery, r.vessel.contractDelivery)) : 0
      const over = Math.max(0, r.delay - margin)
      const { used, remaining } = recover(over, measures)
      return { vessel: r.vessel.id, order: r.vessel.order, handling: r.handling, delay: r.delay, margin, over, recovered: used, remaining }
    })
}

export function planOf(ctx: Context, change: Change, method: Method, opts: SimOptions = {}): MethodPlan {
  const rv = review(ctx, change, { ...opts, method })
  const rec = rv.options[rv.recommended] ?? null
  const result = rec?.result
  const all = result ? overrunsOf(result, ctx.costs?.recovery) : []
  const overDays = all.reduce((sum, o) => sum + o.remaining, 0)
  const recoveryCost = all.reduce((sum, o) => sum + o.recovered.reduce((s, x) => s + x.cost, 0), 0)
  const reinforce = method === "C" ? change.options?.reinforce : undefined
  return {
    method,
    label: METHOD_LABEL[method],
    review: rv,
    rec,
    cost: result ? costOf(ctx, change, result, method, overDays, recoveryCost) : { material: 0, reinforce: 0, expedite: 0, labor: 0, recovery: 0, total: 0, ldRisk: 0 },
    overruns: all.filter((o) => o.over > 0),
    absorbed: all.filter((o) => o.over === 0),
    overDays,
    rawOverDays: all.reduce((sum, o) => sum + o.over, 0),
    delayDays: result?.totalDelay ?? 0,
    touched: result ? result.rows.filter((r) => r.kind !== "apply").length : 0,
    approvals: reinforce ? reinforce.approvals : [],
  }
}

// 기준별 점수 (작을수록 좋음): 일정 = 납기 초과 → 지연 합계, 비용 = 직접 비용, 생산 차질 = 손대는 척수 → 작업 일수
const SCORE: Record<Criterion, (p: MethodPlan) => number[]> = {
  schedule: (p) => [p.overDays, p.delayDays],
  cost: (p) => [p.cost.total],
  disruption: (p) => [p.touched, p.delayDays],
}

export function compareByPriority(a: MethodPlan, b: MethodPlan, priority: Criterion[]) {
  for (const c of priority) {
    const x = SCORE[c](a)
    const y = SCORE[c](b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
  }
  return a.method.localeCompare(b.method)
}

export function compareMethods(ctx: Context, change: Change, opts: SimOptions = {}, priority: Criterion[] = DEFAULT_PRIORITY): MethodComparison {
  const plans = methodsOf(change).map((m) => planOf(ctx, change, m, opts))
  const feasible = plans.filter((p) => p.rec)
  const best = [...feasible].sort((a, b) => compareByPriority(a, b, priority))[0]
  return { plans, priority, recommended: best?.method ?? null }
}

// 두 안이 기준별로 어떻게 다른지 (화면 · AI 설명의 재료)
export function differences(a: MethodPlan, b: MethodPlan) {
  return {
    overDays: a.overDays - b.overDays,
    delayDays: a.delayDays - b.delayDays,
    cost: a.cost.total - b.cost.total,
    touched: a.touched - b.touched,
    decideBy: a.rec && b.rec ? daysBetween(b.rec.decideBy, a.rec.decideBy) : 0,
  }
}

// 화면 · 결정이 쓰는 안: 고른 안이 있으면 그 안, 없으면 선주 우선순위로 추천한 안 (고를 안이 A 하나뿐이면 그대로)
export function withMethod(ctx: Context, change: Change, opts: SimOptions = {}): SimOptions {
  if (opts.method || methodsOf(change).length < 2) return opts
  const rec = compareMethods(ctx, change, opts, opts.priority ?? DEFAULT_PRIORITY).recommended
  return rec ? { ...opts, method: rec } : opts
}

// "결정 마감": 추천 안(또는 고른 안)의 우선 검토 시점을 지키려면 회의에서 늦어도 정해야 하는 날.
// 목록 · 상세 · 호선 화면 · 갱신 알림이 모두 이 값을 쓴다. 맞출 수 있는 시점이 없으면 빨간 날짜 기준 (이미 지난 날일 수 있음)
export function meetingDeadline(ctx: Context, change: Change, opts: SimOptions = {}) {
  const o = withMethod(ctx, change, opts)
  const r = review(ctx, change, o)
  const rec = r.options[r.recommended]
  if (rec) return { date: rec.decideBy, teams: rec.check.decideTeams, red: rec.to, ok: true, result: rec.result, method: o.method ?? ("A" as Method) }
  const red = redDate(ctx, change, o) ?? targetRange(ctx, change, o).min
  const check = teamCheck(ctx, change, red, o)
  return { date: check.decideBy, teams: check.decideTeams, red, ok: check.ok, result: check.sim, method: o.method ?? ("A" as Method) }
}
