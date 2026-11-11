// 실적 기준값과 사례 적립 (기능명세 2-2-e · 2-2-i).
// 기준값은 사례의 호선별 처리 · 부서별 수행 일수와, 진행 보드에서 완료하며 적은 실제 일수의 중간값이다.
// 결정한 변경의 할 일이 모두 끝나면 그 변경을 사례 1건으로 만들어 다음 회의의 사례 찾기에 쓴다.
import type { Actual, Benchmarks, CaseRecord, Change, Features, Metric } from "../data/types.js"
import type { Kind, SimResult } from "./simulate.js"
import type { Task } from "./tasks.js"

export const METRICS: Array<{ metric: Metric; label: string }> = [
  { metric: "rework", label: "재작업" },
  { metric: "reworkErected", label: "탑재 후 재작업" },
  { metric: "hold", label: "중단 검토" },
  { metric: "approval", label: "선급 승인" },
  { metric: "procure", label: "구매 조달" },
  { metric: "owner", label: "선주 협의" },
]

// 처리별 일수는 사례의 호선별 처리에서, 승인 · 조달 · 협의는 부서별 수행 기록에서 모은다
const HANDLING_METRIC: Record<string, Metric> = { 재작업: "rework", "탑재 후 재작업": "reworkErected", "중단 검토": "hold" }
const DEPT_METRIC: Record<string, Metric> = { 선급: "approval", 구매: "procure", 선주: "owner" }

export function median(values: number[]) {
  const a = [...values].sort((x, y) => x - y)
  const n = a.length
  return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null
}

export function benchmarkSamples(cases: CaseRecord[], actuals: Actual[] = []): Record<Metric, number[]> {
  const samples: Record<Metric, number[]> = { rework: [], reworkErected: [], hold: [], approval: [], procure: [], owner: [] }
  cases.forEach((c) => {
    c.treatments.forEach((t) => HANDLING_METRIC[t.handling] && samples[HANDLING_METRIC[t.handling]].push(t.days))
    c.execution.forEach((e) => DEPT_METRIC[e.dept] && samples[DEPT_METRIC[e.dept]].push(e.days))
  })
  actuals.forEach((a) => a.metric && samples[a.metric].push(a.actual))
  return samples
}

// 시뮬레이션이 쓰는 기준값 (일 단위로 반올림)
export function benchmarksOf(cases: CaseRecord[], actuals: Actual[] = []): Benchmarks {
  const samples = benchmarkSamples(cases, actuals)
  return Object.fromEntries(METRICS.map(({ metric }) => [metric, Math.round(median(samples[metric]) ?? 0)])) as Benchmarks
}

const KIND_TIMING: Record<Kind, CaseRecord["timing"]> = {
  apply: "생산 전",
  hold: "블록 제작 중",
  rework: "블록 완성",
  "rework-erected": "탑재 후",
}
const SEVERITY: Kind[] = ["apply", "hold", "rework", "rework-erected"]

// 할 일이 모두 끝난 변경 → 사례 1건. 처리 일수와 부서별 기록은 실제 걸린 일수로 채운다
export function caseFromDecision(change: Change, sim: SimResult, tasks: Task[], actuals: Actual[], features: Features): CaseRecord {
  const mine = actuals.filter((a) => a.code === change.code)
  const byTask = new Map(mine.map((a) => [a.taskId, a]))
  const worst = [...sim.rows].sort((a, b) => SEVERITY.indexOf(b.kind) - SEVERITY.indexOf(a.kind))[0]
  const treatments = sim.rows.map((r) => {
    const a = byTask.get(`${r.vessel.id}:rework`) ?? byTask.get(`${r.vessel.id}:fix`)
    const days = r.kind === "apply" ? 0 : (a?.actual ?? r.processDays)
    return {
      vessel: r.vessel.id,
      handling: r.handling,
      days,
      note: a ? `계획 ${a.planned}일 · 실제 ${a.actual}일` : r.kind === "apply" ? "작업지시 변경" : "계획대로",
      delay: r.materialWait + days,
    }
  })
  const fixed = treatments.filter((t) => t.days > 0)
  const byHandling = [...new Set(fixed.map((t) => t.handling))].map((h) => {
    const rows = fixed.filter((t) => t.handling === h)
    return `${h} ${rows.length}척(${rows.map((t) => t.days).join("·")}일)`
  })
  const over = mine.filter((a) => a.actual > a.planned).sort((a, b) => b.actual - b.planned - (a.actual - a.planned))
  const parties = [...new Map(tasks.filter((t) => t.party).map((t) => [t.party!, t.reason ?? ""])).entries()]
  return {
    code: change.code,
    title: change.title,
    member: features.part !== "-" ? features.part : (change.member ?? "-"),
    trade: features.trade,
    types: features.types,
    area: features.zone,
    reason: change.reason,
    timing: KIND_TIMING[worst.kind],
    currentSeries: true,
    vessel: `${worst.vessel.id} ${change.block}`,
    v1: change.v1 ?? "",
    v2: change.v2 ?? "",
    result: byHandling.length ? byHandling.join(" · ") : `바로 반영 ${treatments.length}척`,
    maxDelay: Math.max(0, ...treatments.map((t) => t.delay)),
    treatments: treatments.map(({ delay: _, ...t }) => t),
    execution: mine.map((a) => ({ dept: a.dept, task: a.task, days: a.actual })),
    participants: parties.map(([dept, reason]) => ({ dept, reason })),
    problem: over.length ? over.map((a) => `${a.task} 계획 ${a.planned}일 → 실제 ${a.actual}일`).join(", ") : "계획한 일수 안에 끝남",
    lesson: over.length
      ? `${over[0].dept} '${over[0].task}'에 계획보다 ${over[0].actual - over[0].planned}일 더 걸림. 비슷한 변경은 ${over[0].dept} 기간을 그만큼 더 잡을 것`
      : "부서별 할 일이 계획한 일수 안에 끝남. 같은 기준으로 일정을 잡아도 됨",
  }
}
