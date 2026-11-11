// 사례 화면(메뉴 3) 공통: 호선 상태 묶음 정의 · 열린 변경의 호선 상태 · 사례 카드 · 전체 목록
// 엔진(server/engine)은 고치지 않고 불러 쓰기만 한다. 검색 자체는 server/caseQuery.ts
import { listChanges, type Ontology, type World } from "./engine/index.js"
import { occurrenceState } from "./engine/parts.js"

type Row = Record<string, any>

// 호선(부품) 상태 묶음: 사례의 시점(timing) · 처리(handling) 코드와 짝짓는다
export const GROUPS = [
  { key: "delivered", label: "인도 후 (운항 중)", timings: [] as string[], handlings: ["retrofit_after_delivery"] },
  { key: "installed", label: "설치 후", timings: ["after_erection"], handlings: ["rework_after_erection"] },
  { key: "fabricated", label: "만든 뒤 설치 전", timings: ["block_fabrication", "block_complete"], handlings: [] as string[] },
  { key: "not_started", label: "아직 안 만듦", timings: ["before_production"], handlings: ["apply_now"] },
] as const
export type GroupKey = (typeof GROUPS)[number]["key"]
export const isGroupKey = (x: string): x is GroupKey => GROUPS.some((g) => g.key === x)

// 사례가 그 상태 묶음에서 있었던 일인가 (시점이 같거나, 그 상태에서 하는 처리를 했거나)
export function caseInState(w: World, c: Row, key: GroupKey) {
  const g = GROUPS.find((x) => x.key === key)!
  const handlings = (w.caseResults.get(c.case_id) ?? []).map((r: Row) => r.handling as string)
  return (g.timings as readonly string[]).includes(c.timing) || handlings.some((h) => (g.handlings as readonly string[]).includes(h))
}

// 결정을 기다리는 변경마다 바뀌는 부재와, 호선이 놓인 상태(가장 많이 진행된 부품 기준)
export function openChangeContext(w: World, onto: Ontology | null = null) {
  return listChanges(w, onto) // 설계변경 목록 화면과 같은 기준 (대응안 규칙이 온톨로지를 읽는다)
    .filter((c) => c.deadline && !c.decided && !c.designOnly && !c.error)
    .map((c) => {
      const parts = (w.affected.get(c.id) ?? []).map((a: Row) => w.part.get(a.part_id)).filter(Boolean) as Row[]
      const states = parts.flatMap((p) => (w.occurrencesOfPart.get(p.part_id) ?? []).map((o: Row) => occurrenceState(w, o, w.today)))
      const hullStates = new Map<string, GroupKey>()
      for (const h of w.hulls) {
        const st = states.filter((s) => s.hullId === h.hull_id)
        if (!st.length) continue
        const installed = sum(st.map((s) => s.installed))
        const fabricated = sum(st.map((s) => s.fabricated))
        hullStates.set(h.hull_id, h.lifecycle_status === "in_service" ? "delivered" : installed > 0 ? "installed" : fabricated > 0 ? "fabricated" : "not_started")
      }
      return { id: c.id, title: c.title, partKinds: [...new Set(parts.map((p) => p.part_kind as string))], states: [...new Set(hullStates.values())] }
    })
}

export type CaseCard = {
  id: string
  title: string
  source: string // 기록이 나온 호선 (예: H-099)
  timing: string
  basis: string[] // 왜 나왔나
  differences: string[] // 물어본 것과 다른 점
  problem: string | null
  lesson: string | null
  originalText: string | null
  spec: { before: string | null; after: string | null }
  results: { hull: string; handling: string; days: number | null; cost: number | null; payer: string | null; note: string | null }[]
  maxLocalDelay: number | null
  deliveryDelay: number | null
  synthetic: boolean
}

export function toCard(w: World, c: Row, basis: string[] = [], differences: string[] = []): CaseCard {
  const src = String(c.source_hull_text ?? "")
  return {
    id: c.case_id,
    title: c.title,
    source: src,
    timing: w.label("timing", c.timing),
    basis,
    differences,
    problem: c.problem ?? null,
    lesson: c.lesson ?? null,
    originalText: c.original_text ?? null,
    spec: { before: c.spec_before ?? null, after: c.spec_after ?? null },
    results: (w.caseResults.get(c.case_id) ?? []).map((r: Row) => ({
      hull: r.source_hull_text ?? src,
      handling: w.label("handling", r.handling),
      days: r.actual_duration_days ?? null,
      cost: r.actual_cost_krw ?? null,
      payer: r.payer ? w.label("payer", r.payer) : null,
      note: r.note ?? null,
    })),
    maxLocalDelay: c.max_local_delay_days ?? null,
    deliveryDelay: c.delivery_delay_days ?? null,
    synthetic: !!c.synthetic,
  }
}

// 사례 1건 자세히 (전체 목록에서 누를 때)
export function caseDetail(w: World, caseId: string) {
  const c = w.cases.find((x: Row) => x.case_id === caseId)
  return c ? toCard(w, c) : null
}

// 전체 사례 목록 (접어 둔 표)
export function allCases(w: World) {
  return w.cases
    .map((c: Row) => ({
      id: c.case_id as string,
      title: c.title as string,
      part: w.label("part_kind", c.part_kind),
      timing: w.label("timing", c.timing),
      reason: w.label("reason", c.reason),
      handling: [...new Set((w.caseResults.get(c.case_id) ?? []).map((r: Row) => w.label("handling", r.handling)))].join(" · "),
      lesson: (c.lesson as string | null) ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// 데이터 범위: 어떤 부재의 기록이 몇 건 있는지 (검색 범위를 정직하게 보여 주려고)
export function scopeOf(w: World) {
  const by = new Map<string, number>()
  for (const c of w.cases) by.set(c.part_kind, (by.get(c.part_kind) ?? 0) + 1)
  return { total: w.cases.length, parts: [...by].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, label: w.label("part_kind", code), count })) }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
