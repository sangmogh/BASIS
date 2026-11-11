// AI 대안 검토 의견: 엔진이 계산한 대응안별 사실 + 과거 사례 교훈 → 안마다 장점 · 단점 · 추가 확인사항.
// AI는 안을 고르지 않는다 (추천은 엔진이 선주 우선순위로 정함). 사실에 없는 숫자가 하나라도 나오면 버리고 규칙 의견을 쓴다.
import type { Analysis } from "./analysis.js"
import type { CaseRecord, Change, Method } from "../data/types.js"
import { CRITERION_LABEL, type MethodComparison, type MethodPlan, formatShort } from "../engine/index.js"

export type OptionOpinion = { method: Method; pros: string[]; cons: string[]; checks: string[] }
export type Opinion = { key: string; source: "rules" | "claude" | "gemini"; opinions: OptionOpinion[]; note?: string; createdAt: string }
export type OpinionInput = {
  code: string
  title: string
  priority: string // "일정 > 생산 차질 > 비용"
  recommended: Method | null
  methods: Array<{ method: Method; label: string; facts: string[] }>
  cases: string[] // 비슷한 과거 사례의 교훈 (근거)
}

// 만원 → "1억 4,500만원"
export function won(n: number) {
  const eok = Math.floor(n / 10000)
  const man = Math.round(n % 10000)
  if (!eok) return `${man.toLocaleString()}만원`
  return `${eok}억${man ? ` ${man.toLocaleString()}만` : ""}원`
}

const span = (from: string, to: string) => (from === to ? formatShort(to) : `${formatShort(from)}~${formatShort(to)}`)

// 안마다 엔진이 계산한 사실 문장 (화면의 대응안 카드와 같은 값)
export function planFacts(plan: MethodPlan): string[] {
  if (!plan.rec) return ["범위 안에서 모든 팀이 맞출 수 있는 반영일이 없음"]
  const r = plan.rec
  const late = r.result.rows.filter((x) => x.delay > 0).map((x) => `${x.vessel.order} ${x.handling} ${x.delay}일`)
  return [
    `현장 반영 ${span(r.from, r.to)}, 결정 마감 ${formatShort(r.decideBy)} (${r.check.decideTeams} 착수 기준)`,
    plan.overDays
      ? `만회하고도 계약 납기 초과: ${plan.overruns.filter((o) => o.remaining).map((o) => `${o.order} ${o.remaining}일`).join(", ")}`
      : plan.rawOverDays
        ? `계약 납기 초과 ${plan.overruns.map((o) => `${o.order} ${o.over}일`).join(", ")}를 만회해 납기 안 (${plan.overruns
            .map((o) => o.recovered.map((r) => `${o.order} ${r.name} ${r.days}일 ${won(r.cost)}`).join(", "))
            .join(", ")})`
        : "계약 납기 안에 끝남",
    ...(plan.absorbed.length ? [`여유 안에서 흡수: ${plan.absorbed.map((o) => `${o.order} 지연 ${o.delay}일 (여유 ${o.margin}일)`).join(", ")}`] : []),
    `지연 합계 ${plan.delayDays}일 (${r.result.label})${late.length ? `: ${late.join(", ")}` : ""}`,
    `직접 비용 ${won(plan.cost.total)} (자재 ${won(plan.cost.material)}, 보강 ${won(plan.cost.reinforce)}, 긴급 조달 ${won(plan.cost.expedite)}, 작업 ${won(plan.cost.labor)}, 만회 ${won(plan.cost.recovery)})`,
    ...(plan.cost.ldRisk ? [`지체상금 위험 ${won(plan.cost.ldRisk)}`] : []),
    ...(plan.approvals.length ? [`먼저 받아야 할 승인: ${plan.approvals.join(" · ")}`] : []),
    `가장 빠듯한 팀: ${r.check.tightest.team} 여유 ${r.check.tightest.slack}일`,
  ]
}

export function opinionInput(change: Change, comparison: MethodComparison, analysis: Analysis | undefined, cases: CaseRecord[]): OpinionInput {
  const lessons = (analysis?.similar ?? [])
    .slice(0, 3)
    .map((s) => cases.find((c) => c.code === s.code))
    .filter((c): c is CaseRecord => Boolean(c))
    .map((c) => `${c.code} ${c.title}: ${c.lesson}`)
  return {
    code: change.code,
    title: change.title,
    priority: comparison.priority.map((c) => CRITERION_LABEL[c]).join(" > "),
    recommended: comparison.recommended,
    methods: comparison.plans.map((p) => ({ method: p.method, label: `${p.method} ${p.label}`, facts: planFacts(p) })),
    cases: lessons,
  }
}

// 같은 입력이면 같은 의견 (캐시 열쇠)
export const opinionKey = (input: OpinionInput) => JSON.stringify([input.code, input.priority, input.methods.map((m) => m.facts)])

// 규칙 의견: AI 없이 엔진 숫자만으로 (AI가 안 되면 이것을 보여 준다)
export function ruleOpinion(comparison: MethodComparison, key: string, note?: string): Opinion {
  const feasible = comparison.plans.filter((p) => p.rec)
  const minCost = Math.min(...feasible.map((p) => p.cost.total))
  const minDelay = Math.min(...feasible.map((p) => p.delayDays))
  const opinions = comparison.plans.map((p): OptionOpinion => {
    if (!p.rec) return { method: p.method, pros: [], cons: ["범위 안에서 모든 팀이 맞출 수 있는 반영일이 없어요"], checks: [] }
    const pros = [
      ...(p.overDays === 0 && p.rawOverDays === 0 ? ["계약 납기 안에 끝나요"] : []),
      ...(p.delayDays === minDelay ? [`지연 합계가 가장 짧아요 (${p.delayDays}일)`] : []),
      ...(p.cost.total === minCost ? [`직접 비용이 가장 적어요 (${won(p.cost.total)})`] : []),
    ]
    const cons = [
      ...(p.overDays ? [`만회하고도 ${p.overruns.filter((o) => o.remaining).map((o) => `${o.order} ${o.remaining}일`).join(", ")} 납기를 넘겨요`] : []),
      ...(p.rawOverDays && !p.overDays ? [`납기를 맞추려면 만회 작업이 필요해요 (+${won(p.cost.recovery)})`] : []),
      ...(p.cost.expedite ? [`긴급 조달 비용 ${won(p.cost.expedite)}이 더 들어요`] : []),
      ...(p.cost.total > minCost ? [`가장 싼 안보다 ${won(p.cost.total - minCost)} 더 들어요`] : []),
      ...(p.rec.check.tightest.slack <= 2 ? [`${p.rec.check.tightest.team} 여유가 ${p.rec.check.tightest.slack}일뿐이에요`] : []),
    ]
    const checks = [
      ...(p.approvals.length ? [`${p.approvals.join(" · ")} 보강안 승인을 결정 마감 전에 요청하세요`] : []),
      ...(p.cost.expedite ? ["긴급 조달 납기를 공급사에 서면으로 확인하세요"] : []),
      ...(p.rawOverDays && !p.overDays ? [`만회 인력 · 일정(${p.overruns.flatMap((o) => o.recovered.map((r) => r.name)).join(" · ")})을 생산과 확인하세요`] : []),
      ...(p.overDays ? ["납기를 넘기는 호선은 선주와 인도일 협의가 필요해요"] : []),
    ]
    return { method: p.method, pros, cons, checks }
  })
  return { key, source: "rules", opinions, note, createdAt: new Date().toISOString() }
}

const NUMBER = /\d+(?:[/.:~,-]\d+)*/g
// 의견에 나온 숫자 중 사실 · 사례에 없는 것 (비어 있어야 통과)
export function unknownOpinionNumbers(opinions: OptionOpinion[], input: OpinionInput) {
  const known = new Set([input.code, input.title, ...input.methods.flatMap((m) => [m.label, ...m.facts]), ...input.cases].join(" ").match(NUMBER) ?? [])
  ;[...known].forEach((n) => n.split(/[~]/).forEach((part) => known.add(part)))
  const text = opinions.flatMap((o) => [...o.pros, ...o.cons, ...o.checks]).join(" ")
  return [...new Set(text.match(NUMBER) ?? [])].filter((n) => !known.has(n))
}
