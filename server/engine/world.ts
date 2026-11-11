// 데이터셋(표 묶음) → 엔진이 쓰는 World.
// 시점 규칙: 데이터셋은 as_of 때의 스냅숏이다. 그 뒤에 일어난 이벤트는 '새 소식'이고,
// appliedEvents에 든 것만 반영한다 (값 바꾸기 이벤트는 대상 칸을 고치고, 등록 이벤트는 그 시각까지 알려진 행을 보이게 한다)
import { dayOf, groupBy, type Row, type Tables } from "./basics.js"

export type World = ReturnType<typeof loadWorld>

const by = (rows: Row[], key: string) => new Map(rows.map((r) => [String(r[key]), r]))

export function loadWorld(tables: Tables, opts: { appliedEvents?: string[] } = {}) {
  const t = (name: string) => tables[name] ?? []
  const dataset = t("dataset")[0]
  if (!dataset) throw new Error("dataset 표가 비어 있어요 (데이터 계약 형식이 아니에요)")
  const asOf: string = dataset.as_of
  const allEvents = t("event")
  const applied = new Set(opts.appliedEvents ?? [])
  const unknown = [...applied].filter((id) => !allEvents.some((e) => e.event_id === id))
  if (unknown.length) throw new Error(`모르는 이벤트: ${unknown.join(", ")}`)
  const appliedEvents = allEvents.filter((e) => applied.has(e.event_id))
  // 알려진 시각의 끝: as_of, 반영한 이벤트가 있으면 그 시각까지
  const horizon = [asOf, ...appliedEvents.map((e) => e.occurred_at as string)].sort().at(-1)!

  // 표 복사 + 시점 거르기 (known_at이 있는 표만)
  const view: Tables = {}
  for (const [name, rows] of Object.entries(tables)) view[name] = rows.filter((r) => !("known_at" in r) || !r.known_at || r.known_at <= horizon).map((r) => ({ ...r }))
  // 값 바꾸기 이벤트 반영: 대상 표에서 target_key 값을 가진 행의 칸을 바꾼다
  for (const e of appliedEvents) {
    if (!e.target_column) continue
    const row = (view[e.target_table] ?? []).find((r) => Object.values(r).some((v) => v === e.target_key))
    if (row) row[e.target_column] = e.new_value
  }
  const v = (name: string) => view[name] ?? []

  const labels = new Map<string, Map<string, string>>()
  for (const c of v("code")) {
    if (!labels.has(c.code_type)) labels.set(c.code_type, new Map())
    labels.get(c.code_type)!.set(c.code, c.label_ko)
  }
  const quotes = v("supplier_quote")
  const quoteLines = groupBy(v("supplier_quote_line"), (l) => l.quote_id)
  const supersededQuotes = new Set(quotes.map((q) => q.supersedes_quote_id).filter(Boolean))
  const settings = new Map(v("setting").map((s) => [s.key as string, s.value as string]))
  const voided = new Set(v("production_event").map((e) => e.voids_event_id).filter(Boolean))

  return {
    dataset,
    asOf,
    today: dayOf(asOf),
    horizon,
    label: (type: string, code: string) => labels.get(type)?.get(code) ?? code,
    series: v("series")[0],
    hulls: [...v("hull")].sort((a, b) => a.hull_seq - b.hull_seq),
    hull: by(v("hull"), "hull_id"),
    contract: by(v("hull_contract"), "hull_id"),
    path: by(v("hull_delivery_path"), "hull_id"),
    block: by(v("block"), "block_id"),
    window: by(v("block_window"), "block_id"),
    zone: by(v("zone"), "zone_code"),
    part: by(v("part"), "part_id"),
    revision: by(v("part_revision"), "revision_id"),
    occurrencesOfPart: groupBy(v("part_occurrence"), (o) => o.part_id),
    itemOfOccurrence: by(v("production_item"), "occurrence_id"),
    eventsOfItem: groupBy(
      v("production_event").filter((e) => !voided.has(e.event_id)),
      (e) => e.production_item_id,
    ),
    operationsOfItem: groupBy(v("operation"), (o) => o.production_item_id),
    changes: [...v("change")].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at))),
    change: by(v("change"), "change_id"),
    affected: groupBy(v("change_affected_part"), (a) => a.change_id),
    scope: groupBy(v("change_hull_scope"), (s) => s.change_id),
    solutions: groupBy(v("engineering_solution"), (s) => s.change_id),
    targets: groupBy(v("solution_target"), (s) => s.solution_id),
    material: by(v("material"), "material_id"),
    changeMaterials: groupBy(v("change_material"), (m) => m.change_id),
    // 변경의 견적: 다른 견적으로 대체되지 않은 것만, 줄 포함
    quotes: groupBy(
      quotes.filter((q) => !supersededQuotes.has(q.quote_id)).map((q): Row => ({ ...q, lines: quoteLines.get(q.quote_id) ?? [] })),
      (q) => q.change_id,
    ),
    purchaseLines: groupBy(v("purchase_line"), (l) => l.material_id),
    purchaseOrder: by(v("purchase_order"), "po_id"),
    availability: groupBy(v("resource_availability"), (a) => a.resource_group),
    resourceGroup: by(v("resource_group"), "resource_group"),
    employees: [...v("employee")].sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id))),
    employee: by(v("employee"), "employee_id"),
    department: by(v("department"), "department_code"),
    assignments: v("project_assignment"),
    responsibilities: groupBy(v("responsibility"), (r) => `${r.object_type}:${r.object_id}`),
    counterparty: by(v("counterparty"), "counterparty_id"),
    ownerPreferences: groupBy(v("owner_preference"), (p) => p.change_id),
    cases: v("case_record"),
    caseResults: groupBy(v("case_hull_result"), (r) => r.case_id),
    caseParticipants: groupBy(v("case_participant"), (r) => r.case_id),
    costRate: by(v("cost_rate"), "cost_code"),
    standards: v("work_standard"),
    duration: by(v("duration_default"), "duration_key"),
    templates: [...v("task_template")].sort((a, b) => a.sort_order - b.sort_order),
    payerRule: by(v("payer_rule"), "reason"),
    contractTerms: v("contract_change_term"),
    setting: (key: string, fallback: string) => settings.get(key) ?? fallback,
    events: allEvents,
    appliedEvents,
    pendingEvents: allEvents.filter((e) => !applied.has(e.event_id) && e.occurred_at > asOf),
    expected: groupBy(v("expected_result"), (e) => e.subject),
    // 서비스 기록 (DB 초기값 + 저장된 기록, server/records.ts가 합쳐서 넘긴다)
    seed: {
      confirmations: v("task_confirmation"),
      decisions: v("decision_record"),
      approvals: v("decision_approval"),
      delegations: v("chair_delegation"),
      runs: v("assessment_run"),
      progress: v("task_progress"),
    },
  }
}

// 날짜 d에 유효한 행 (valid_from ≤ d ≤ valid_to)
export const activeOn = (rows: Row[], day: string) => rows.filter((r) => (!r.valid_from || dayOf(r.valid_from) <= day) && (!r.valid_to || dayOf(r.valid_to) >= day))
