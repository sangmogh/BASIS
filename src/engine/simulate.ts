// 날짜 시뮬레이션: 현장 반영 목표일(T)에 따라 호선별 처리, 자재 대기, 팀별 판정을 계산한다.
// 숫자는 모두 코드가 계산한다. AI는 이 계산에 끼어들지 않는다(기능명세 5장).
import type { Benchmarks, BlockSchedule, Change, Costs, Criterion, Method, Series, Vessel } from "../data/types.js"
import { addDays, daysBetween, maxDate, minDate } from "./dates.js"

export type Context = { series: Series; benchmarks: Benchmarks; costs?: Costs }

export type Kind = "apply" | "hold" | "rework" | "rework-erected"
export type Handling = "바로 반영" | "중단 검토" | "재작업" | "탑재 후 재작업" | "보강" | "선상 보강"
export const HANDLING: Record<Kind, Handling> = {
  apply: "바로 반영",
  hold: "중단 검토",
  rework: "재작업",
  "rework-erected": "탑재 후 재작업",
}

export type TeamId = "class" | "design" | "purchase" | "production"
export type Params = Record<TeamId | "prep", number>

export type SimOptions = {
  prepDays?: number
  overrides?: Partial<Record<TeamId, number>>
  today?: string // 과거 결정은 그 결정일을 "오늘"로 본다
  method?: Method // 대응안: A 일반 조달(기본) · B 긴급 조달 · C 기존 부품 보강
  priority?: Criterion[] // 선주 우선순위 (대응안 추천 순서)
}

// 결과 띠 · 슬라이더가 끝나는 날(도면 배포 기준). 목표일은 여기에 준비 기간을 더한 날까지
// 결과 띠 끝: 오늘부터 95일 (기준일 10/28이면 '27 1/31)
export const BAND_DAYS = 95

export const isMandatory = (change: Change) => change.reason === "선급·규정"

// C 기존 부품 보강을 쓸 수 있나 (보강 입력이 있는 변경만)
export const reinforceOf = (change: Change, opts: SimOptions = {}) => (opts.method === "C" ? change.options?.reinforce : undefined)
// 승인을 받아야 도면을 배포할 수 있나: 선급 · 규정 변경이거나, C 보강안 (선주 · 선급 승인)
export const gated = (change: Change, opts: SimOptions = {}) => isMandatory(change) || Boolean(reinforceOf(change, opts))

// 이번 변경을 계산할 호선: 건조 중이고 그 블록이 있는 호선 (운항 중인 배는 출발점일 뿐 생산 일정이 없다)
export const buildingVessels = (ctx: Context, change: Change) =>
  ctx.series.vessels.filter((v) => v.status !== "in_service" && v.blocks[change.block])

export function params(ctx: Context, change: Change, opts: SimOptions = {}): { values: Params; base: Params } {
  const base: Params = {
    design: 1,
    class: reinforceOf(change, opts)?.approvalDays ?? ctx.benchmarks.approval,
    prep: ctx.series.prepDays,
    purchase: (opts.method === "B" ? change.options?.expedite?.leadTime : undefined) ?? change.material?.leadTime ?? 0,
    production: 3,
  }
  const values = { ...base, ...opts.overrides }
  if (opts.prepDays != null) values.prep = opts.prepDays
  return { values, base }
}

export function delayFor(ctx: Context, kind: Kind) {
  const b = ctx.benchmarks
  return kind === "apply" ? 0 : kind === "hold" ? b.hold : kind === "rework" ? b.rework : b.reworkErected
}

function classify(target: string, block: BlockSchedule): Kind {
  if (target <= block.start) return "apply"
  if (target <= block.end) return "hold"
  if (target <= block.mount) return "rework"
  return "rework-erected"
}

export type SimRow = {
  vessel: Vessel
  block: BlockSchedule
  kind: Kind
  handling: Handling
  processDays: number // 처리 일수(사례 중간값)
  need: string // 자재가 필요한 날
  source: "none" | "stock" | "buy"
  arrival?: string
  materialWait: number
  delay: number // 인도 지연 = 처리 일수 + 자재 대기
  reinforced?: boolean // C: 바꾸지 않고 기존 부품을 보강
}

export type SimResult = {
  target: string
  release: string // 도면 배포일 = 목표일 - 준비 기간
  rows: SimRow[]
  rework: number
  stops: number
  materialWaits: number
  maxDelay: number
  totalDelay: number
  label: string
  kindKey: string // 처리만 본 서명 (빨간 날짜 판단)
  key: string // 처리 + 자재 대기 여부 (결과 구간 판단)
}

export function simulate(ctx: Context, change: Change, target: string, opts: SimOptions = {}): SimResult {
  const p = params(ctx, change, opts).values
  const today = opts.today ?? ctx.series.today
  const release = addDays(target, -p.prep)
  const orderDay = minDate(release, today) // 자재는 결정한 날 발주
  // 운항 중인 호선과 이 블록이 없는 호선(데이터셋마다 다를 수 있음)은 빼고 계산한다
  // C 기존 부품 보강: 이미 만든(재작업 대상) 부품은 바꾸지 않고 보강한다. 새 자재가 필요 없다
  const reinforce = reinforceOf(change, opts)
  const rows: SimRow[] = buildingVessels(ctx, change).map((vessel) => {
    const block = vessel.blocks[change.block]
    const kind = classify(target, block)
    const reinforced = Boolean(reinforce && kind.startsWith("rework"))
    return {
      vessel,
      block,
      kind,
      handling: reinforced ? (kind === "rework-erected" ? "선상 보강" : "보강") : HANDLING[kind],
      processDays: reinforced ? (kind === "rework-erected" ? reinforce!.daysErected : reinforce!.days) : delayFor(ctx, kind),
      need: kind === "apply" ? block.start : target,
      source: "none",
      materialWait: 0,
      delay: 0,
      ...(reinforced ? { reinforced: true } : {}),
    }
  })
  if (change.material) {
    // 필요일이 빠른 호선부터 재고를 배정하고, 나머지는 결정한 날 발주해 조달 기간 뒤 입고 (보강하는 호선은 새 자재가 없다)
    ;[...rows.filter((r) => !r.reinforced)]
      .sort((a, b) => a.need.localeCompare(b.need) || a.vessel.id.localeCompare(b.vessel.id))
      .forEach((row, index) => {
        if (index < change.material!.stock) {
          row.source = "stock"
          return
        }
        row.source = "buy"
        row.arrival = addDays(orderDay, p.purchase)
        row.materialWait = Math.max(0, daysBetween(row.need, row.arrival))
      })
  }
  rows.forEach((row) => {
    row.delay = row.processDays + row.materialWait
  })
  const rework = rows.filter((r) => r.kind.startsWith("rework") && !r.reinforced).length
  const reinforced = rows.filter((r) => r.reinforced).length
  const stops = rows.filter((r) => r.kind === "hold").length
  const materialWaits = rows.filter((r) => r.materialWait > 0).length
  const maxDelay = Math.max(0, ...rows.map((r) => r.delay))
  const parts = [
    rework ? `재작업 ${rework}척` : "",
    reinforced ? `보강 ${reinforced}척` : "",
    stops ? `중단 검토 ${stops}척` : "",
    materialWaits ? `자재 대기 ${materialWaits}척` : "",
  ].filter(Boolean)
  return {
    target,
    release,
    rows,
    rework,
    stops,
    materialWaits,
    maxDelay,
    totalDelay: rows.reduce((sum, r) => sum + r.delay, 0),
    label: parts.length ? parts.join(" · ") : `바로 반영 ${rows.length}척`,
    kindKey: rows.map((r) => r.kind).join("|"),
    key: rows.map((r) => r.kind + (r.materialWait > 0 ? "+w" : "")).join("|"),
  }
}

// 목표일로 고를 수 있는 범위: 오늘 결정해 도면을 배포하는 날 ~ 결과 띠 끝
export function targetRange(ctx: Context, change: Change, opts: SimOptions = {}) {
  const prep = params(ctx, change, opts).values.prep
  const today = opts.today ?? ctx.series.today
  return { min: addDays(today, prep), max: addDays(ctx.series.today, BAND_DAYS + prep) }
}

export type Segment = SimResult & { start: string; end: string }

// 목표일별 결과: 결과(처리 + 자재 대기)가 같은 연속 날짜를 한 구간으로 묶는다
export function segments(ctx: Context, change: Change, opts: SimOptions = {}): Segment[] {
  const { min, max } = targetRange(ctx, change, opts)
  const list: Segment[] = []
  for (let t = min; t <= max; t = addDays(t, 1)) {
    const result = simulate(ctx, change, t, opts)
    const last = list[list.length - 1]
    if (last && last.key === result.key) last.end = t
    else list.push({ ...result, start: t, end: t })
  }
  return list
}

// 빨간 날짜: 이날까지 현장에 반영해야 지금(가장 빨리 반영할 때)의 처리 결과가 유지된다
export function redDate(ctx: Context, change: Change, opts: SimOptions = {}): string | null {
  const { min, max } = targetRange(ctx, change, opts)
  const first = simulate(ctx, change, min, opts).kindKey
  for (let t = addDays(min, 1); t <= max; t = addDays(t, 1)) {
    if (simulate(ctx, change, t, opts).kindKey !== first) return addDays(t, -1)
  }
  return null
}

export type TeamRow = {
  id: TeamId
  team: "선급" | "설계" | "구매" | "생산"
  task: string
  duration: number
  base: number
  source: string
  earliest: string // 오늘 결정하면 가장 빨리 끝나는 날
  latest: string // 목표일에서 거꾸로 센 늦어도 끝내야 하는 날
  startBy: string // 늦어도 시작해야 하는 날
  slack: number
  possible: boolean
  note?: string
}

export type TeamCheck = {
  target: string
  release: string
  sim: SimResult
  rows: TeamRow[]
  ok: boolean
  tightest: TeamRow
  decideBy: string // 회의 결정 마감 = 팀별 "늦어도 시작" 중 가장 이른 날
  decideTeams: string
}

const SOURCE: Record<TeamId, string> = {
  class: "선급 승인 사례 중간값",
  design: "PLM 표준 공수",
  purchase: "ERP 조달 기간",
  production: "가정",
}
const TEAM: Record<TeamId, TeamRow["team"]> = { class: "선급", design: "설계", purchase: "구매", production: "생산" }

export function teamCheck(ctx: Context, change: Change, target: string, opts: SimOptions = {}): TeamCheck {
  const { values: p, base } = params(ctx, change, opts)
  const today = opts.today ?? ctx.series.today
  const sim = simulate(ctx, change, target, opts)
  const release = sim.release
  const gate = gated(change, opts)
  const reinforce = reinforceOf(change, opts)
  const rows: TeamRow[] = []
  const add = (id: TeamId, task: string, earliest: string, latest: string, note?: string) => {
    const slack = daysBetween(earliest, latest)
    rows.push({
      id,
      team: TEAM[id],
      task,
      duration: p[id],
      base: base[id],
      source: SOURCE[id],
      earliest,
      latest,
      startBy: addDays(latest, -p[id]),
      slack,
      possible: slack >= 0,
      note,
    })
  }
  const approvalDone = addDays(today, p.class)
  if (gate)
    add(
      "class",
      reinforce ? `보강안 승인 (${reinforce.approvals.join(" · ")})` : "선급 지적 반영 도면 승인",
      approvalDone,
      release,
      "승인 전에는 도면을 배포할 수 없음",
    )
  const releaseEarliest = maxDate(addDays(today, p.design), gate ? approvalDone : today)
  add("design", "v2 도면 확정 · 배포", releaseEarliest, release)
  const buy = sim.rows.filter((r) => r.source === "buy")
  if (buy.length && change.material) {
    const need = minDate(...buy.map((r) => r.need))
    add(
      "purchase",
      `${change.material.item} 발주 → 입고`,
      addDays(today, p.purchase),
      need,
      `${buy.map((r) => r.vessel.order).join(", ")}분`,
    )
  }
  const partners = sim.rows.filter((r) => r.kind === "apply" && r.block.partner)
  if (partners.length) {
    const latest = addDays(minDate(...partners.map((r) => r.block.start)), -1)
    add(
      "production",
      "협력사 도면 전달 · 수신 확인",
      addDays(releaseEarliest, p.production),
      latest,
      `${partners.map((r) => r.vessel.order).join(", ")} · ${partners[0].block.partner}`,
    )
  }
  const decideBy = minDate(...rows.map((r) => r.startBy))
  return {
    target,
    release,
    sim,
    rows,
    ok: rows.every((r) => r.possible),
    tightest: [...rows].sort((a, b) => a.slack - b.slack)[0],
    decideBy,
    decideTeams: [...new Set(rows.filter((r) => r.startBy === decideBy).map((r) => r.team))].join(" · "),
  }
}

// 모든 팀이 맞출 수 있는 가장 빠른 목표일
export function earliestFeasible(ctx: Context, change: Change, opts: SimOptions = {}): string | null {
  const { min, max } = targetRange(ctx, change, opts)
  for (let t = min; t <= max; t = addDays(t, 1)) if (teamCheck(ctx, change, t, opts).ok) return t
  return null
}


const TIMINGS = ["탑재 후", "블록 완성", "블록 제작 중", "생산 전"] as const
export type Timing = (typeof TIMINGS)[number]

// 오늘 기준 호선별 반영 시점 (사례의 "언제"와 같은 값)
export function timingOf(ctx: Context, change: Change): Timing[] {
  const today = ctx.series.today
  return buildingVessels(ctx, change).map((v) => {
    const b = v.blocks[change.block]
    return today < b.start ? "생산 전" : today <= b.end ? "블록 제작 중" : today <= b.mount ? "블록 완성" : "탑재 후"
  })
}

// 시점: 오늘 기준 해당 블록 상태의 분포 (예: 블록 완성 1척 · 생산 전 4척)
export function timingDistribution(ctx: Context, change: Change) {
  const count: Record<string, number> = {}
  timingOf(ctx, change).forEach((t) => {
    count[t] = (count[t] ?? 0) + 1
  })
  return TIMINGS.filter((t) => count[t]).map((t) => `${t} ${count[t]}척`).join(" · ")
}

// 영향 범위(바운더리)
export function scopeOf(change: Change): string[] {
  if (change.boundary === "design") return ["설계 안에서 끝남"]
  const scope = ["생산·구매까지"]
  if (change.reason === "선주 요청") scope.push("계약(선주)까지")
  if (isMandatory(change)) scope.push("규정(선급)까지")
  return scope
}

// 결과 띠 색 단계 (지연 합계 6 이하 / 12 / 24 / 그 이상)
export function delayLevel(total: number) {
  return total <= 6 ? 0 : total <= 12 ? 1 : total <= 24 ? 2 : 3
}
