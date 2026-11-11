// BASIS 새 엔진: 데이터 계약 형식의 데이터셋이면 어떤 시나리오든 계산한다
//   loadWorld(표 묶음, { appliedEvents }) → reviewChange(world, 변경, { decisionDay, priority, conditions, confirmations })
import { diffDays } from "./basics.js"
import { reviewChange } from "./review.js"
import type { Ontology } from "./ontology.js"
import type { World } from "./world.js"

export { won, type Tables } from "./basics.js"
export { changeStates, dbOptionFacts, diffReviews, optionRules, reviewChange, teamSummary, type Review, type ReviewInput, type RunInputs } from "./review.js"
export { actingChairOf, chairOf, ownerFor } from "./people.js"
export type { Conditions, Confirmation } from "./simulate.js"
export { datasetIds, loadTables, readTables, storageOf } from "./source.js"
export { connectionPaths, loadOntology, matchPartKinds, optionFacts, partsOfKind, seriesSplit, similarCases, type Ontology, type OptionFacts } from "./ontology.js"
export { loadWorld, type World } from "./world.js"

// 목록 화면: 변경 한 줄 요약 + 결정 기한 (이미 결정한 변경은 결정한 안, 기한 없음). 한 건이 실패해도 나머지는 보여 준다
//   ontology: 상세 화면과 같은 규칙(온톨로지)으로 대응안을 만들도록 같이 넘긴다
export function listChanges(w: World, ontology: Ontology | null = null) {
  return w.changes.map((c) => {
    const base = { id: c.change_id as string, title: c.title as string, status: w.label("change_status", c.status) }
    if (c.status === "withdrawn" || c.status === "done") return { ...base, oneLine: null, deadline: null, recommended: null, decided: null, designOnly: false, allOverrun: false, error: null }
    try {
      const r = reviewChange(w, c.change_id, { ontology })
      const d = r.recommended?.deadline ?? null
      return {
        ...base,
        oneLine: r.summary.oneLine,
        deadline: d ? { date: d.date, dday: diffDays(w.today, d.date), badge: d.badge, ifMissed: d.badge ? d.ifMissed : null } : null,
        recommended: r.recommended?.label ?? null,
        decided: r.decision ? `${r.decision.label} (${r.decision.day} 결정${r.decision.state.code === "approval_pending" ? " · 결재 대기" : ""})` : null,
        allOverrun: r.recommended?.allOverrun ?? false,
        designOnly: r.designOnly,
        error: null,
      }
    } catch (error) {
      return { ...base, oneLine: null, deadline: null, recommended: null, decided: null, designOnly: false, allOverrun: false, error: error instanceof Error ? error.message : "계산하지 못했어요" }
    }
  })
}

export function datasetInfo(w: World) {
  return {
    id: w.dataset.dataset_id,
    name: w.dataset.name,
    note: w.dataset.note,
    asOf: w.asOf,
    series: w.series?.name,
    shipType: w.label("ship_type", w.series?.ship_type),
    hulls: w.hulls.length,
    inService: w.hulls.filter((h) => h.lifecycle_status === "in_service").length,
  }
}
