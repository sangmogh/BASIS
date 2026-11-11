// AI ④ 결정 요약 (기능명세 2-2-g · 5장, 선택).
// 요약의 재료는 엔진이 쓴 "계산된 사실" 문장뿐이다. AI 요약에 사실에 없는 숫자(날짜 · 일수 · 척 수 · 호선)가 하나라도 있으면
// 버리고 정해진 문장 틀(decisionSummary)을 그대로 쓴다.
import type { Change } from "../data/types.js"
import { ROLES, type SimResult, TEAM_INFO, type Task, decisionSummary, formatShort } from "../engine/index.js"

export type SummaryInput = { code: string; title: string; facts: string[] }

const span = (t: Task) => (t.start === t.end ? formatShort(t.end) : `${formatShort(t.start)}~${formatShort(t.end)}`)

// 회의에서 정한 것 → 사실 문장 (화면의 결정 기록 · 진행 보드와 같은 값)
export function summaryFacts(change: Change, sim: SimResult, tasks: Task[], meta: { decidedOn: string; baseline: string; removed: Task[]; method?: string }) {
  const facts = [`${formatShort(meta.decidedOn)} 회의에서 결정, 일정 기준선 ${meta.baseline} 채택`, decisionSummary(change, sim, tasks, meta.method)]
  ROLES.forEach((role) => {
    const list = tasks.filter((t) => TEAM_INFO[t.team].role === role)
    if (list.length) facts.push(`${role} 할 일: ${list.map((t) => `${t.vessel ? `${t.vessel} ` : ""}${t.name} ${span(t)}`).join(", ")}`)
  })
  if (meta.removed.length) facts.push(`회의에서 뺀 제안: ${meta.removed.map((t) => t.name).join(", ")}`)
  return facts
}

const NUMBER = /\d+(?:[/.:~-]\d+)*/g

// 요약에 나온 숫자 중 사실에 없는 것 (비어 있어야 통과)
export function unknownNumbers(text: string, facts: string[]) {
  const known = new Set(facts.join(" ").match(NUMBER) ?? [])
  // "11/2~11/7" 같은 구간은 양 끝 날짜로도 맞춰 본다
  ;[...known].forEach((n) => n.split("~").forEach((part) => known.add(part)))
  return [...new Set(text.match(NUMBER) ?? [])].filter((n) => !known.has(n) && !n.split("~").every((part) => known.has(part)))
}
