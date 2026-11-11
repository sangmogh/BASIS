// 변경 1건 검토: 대응안 만들기 → 범위 조정안 → 추천(계약 납기 관문 → 선주 우선순위) → 결정 기한 → 화면 1~6단계 재료
import { addDays, diffDays, won, weakest, type Certainty, type Row } from "./basics.js"
import { occurrenceState, timingOf } from "./parts.js"
import { connectionPaths, optionFacts, seriesSplit, type Ontology, type OptionFacts } from "./ontology.js"
import { caseStats, retrieveCases, suggestParties } from "./rag.js"
import { actingChairOf } from "./people.js"
import { simulate, type Conditions, type Confirmation, type Fallback, type Method, type OptionResult, type SimInput } from "./simulate.js"
import type { World } from "./world.js"

// ontology: 데이터셋의 온톨로지 (loadOntology). 있으면 비슷한 사례 · 연결 경로 · 공통/호선마다를 온톨로지로 찾는다
export type ReviewInput = { decisionDay?: string; priority?: string[]; conditions?: Conditions; confirmations?: Confirmation[]; ontology?: Ontology | null }
export type Review = ReturnType<typeof reviewChange>

const LETTER: Record<string, string> = { normal: "A", expedite: "B", retrofit: "C" }
const METHODS: Method[] = ["normal", "expedite", "retrofit"]

export function reviewChange(w: World, changeId: string, input: ReviewInput = {}) {
  const change = w.change.get(changeId)
  if (!change) throw new Error(`변경이 없거나 아직 알려지지 않았어요: ${changeId}`)
  // 결정 기록: 같은 결정은 나중 행이 이긴다(기록을 합칠 때 접음). 가장 최근 결정이 '재검토'면 결정 없음으로 본다
  const decisionRows = w.seed.decisions.filter((d) => d.change_id === changeId).sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)))
  const latestDecision = decisionRows.at(-1)
  const activeDecision = latestDecision && latestDecision.state !== "reopened" ? latestDecision : null
  // 결정할 때 쓴 입력(안 · 우선순위 · 조건 · 결정일). 결정한 뒤에는 이 입력으로 다시 계산해 결정한 안의 할 일 · 띠를 보여 준다
  const run = activeDecision?.run_id ? w.seed.runs.find((r) => r.run_id === activeDecision.run_id) : undefined
  const frozen = run ? runInputs(run) : null
  const decideDay = input.decisionDay ?? frozen?.decisionDay
  const day0 = decideDay && decideDay > w.today ? decideDay : w.today
  // 팀 확인: DB 초기값 · 저장된 기록(시각 순) 다음에 요청의 '만약에'를 붙인다. simulate는 마지막 것을 쓴다
  const storedConfirmations = w.seed.confirmations.filter((c) => c.change_id === changeId).sort((a, b) => String(a.at).localeCompare(String(b.at))) as Confirmation[]
  const confirmations = [...storedConfirmations, ...(input.confirmations ?? [])]
  const conditions = input.conditions ?? frozen?.conditions ?? {}
  const priorityInput = input.priority ?? frozen?.priority
  const sim = (method: Method, excluded: string[] = [], day = day0, key?: string) =>
    simulate(w, changeId, { key: key ?? (excluded.length ? `range:${method}` : method), method, excluded }, { decisionDay: day, conditions, confirmations } satisfies SimInput)

  // ── 1. 무슨 일이야
  const parts = (w.affected.get(changeId) ?? []).map((a) => w.part.get(a.part_id)!).filter(Boolean)
  const states = changeStates(w, changeId, day0)
  const types = JSON.parse(change.change_types || "[]") as string[]
  const requester = change.requested_by_kind === "counterparty" ? w.counterparty.get(change.requested_by_id)?.name : w.employee.get(change.requested_by_id)?.name
  const summary = {
    id: change.change_id,
    title: change.title,
    oneLine: oneLineOf(w.zone.get(change.zone_code)?.name_ko ?? change.zone_code ?? "", parts.map((p) => p.name_ko as string), change.spec_before, change.spec_after, w.label("reason", change.reason)),
    reason: { code: change.reason, label: w.label("reason", change.reason) },
    types: types.map((t) => w.label("change_type", t)),
    mandatory: !!change.mandatory,
    postDeliveryAllowed: !!change.post_delivery_allowed,
    status: { code: change.status, label: w.label("change_status", change.status) },
    source: w.label("change_source", change.source),
    requester: requester ?? change.requested_by_id,
    registeredBy: w.employee.get(change.registered_by)?.name ?? null,
    receivedAt: change.received_at,
    zone: w.zone.get(change.zone_code)?.name_ko ?? change.zone_code,
    drawingNo: change.drawing_no,
    specBefore: change.spec_before,
    specAfter: change.spec_after,
    originalText: change.original_text,
    timing: { code: timingOf(states), label: w.label("timing", timingOf(states)) },
    chair: actingChairOf(w, changeId, day0),
  }

  // ── 2. 대응안 만들기 (규칙)
  const base = sim("none", [], day0, "none")
  const probe = sim("normal")
  const designOnly = probe.hulls.every((h) => h.treatment === "not_applicable")
  const unavailable: { key: string; label: string; why: string }[] = []
  let results: OptionResult[] = []
  // 대응안 규칙: 사실은 온톨로지에서(시점까지 알려진 것), 결정일의 제작 · 설치 상태는 엔진이 계산
  const rules = designOnly ? null : optionRules(w, changeId, states, input.ontology ?? null)
  if (rules) {
    results = [probe]
    if (rules.expedite.ok) results.push(sim("expedite"))
    else unavailable.push({ key: "expedite", label: optionLabel(w, "expedite", []), why: rules.expedite.why })
    if (rules.retrofit.ok) results.push(sim("retrofit"))
    else unavailable.push({ key: "retrofit", label: optionLabel(w, "retrofit", []), why: rules.retrofit.why })
    // 범위 조정안: 어떤 방식으로도 계약 납기를 못 지키는 호선이 있을 때, 인도 후 개조가 허용되면 그 호선을 뺀 안
    const failing = probe.hulls.filter((h) => !["post_delivery", "not_applicable"].includes(h.treatment) && results.every((r) => (r.hulls.find((x) => x.hullId === h.hullId)?.overrun ?? 0) > 0)).map((h) => h.hullId)
    const activeCount = probe.hulls.filter((h) => !["post_delivery", "not_applicable"].includes(h.treatment)).length
    if (failing.length && change.post_delivery_allowed && failing.length < activeCount) {
      const ranged = results.map((r) => sim(r.method, failing))
      results.push(ranged.sort(compareWith(priorityOf(w, changeId, priorityInput, day0).order))[0])
    } else if (failing.length && !change.post_delivery_allowed)
      unavailable.push({ key: "range", label: "범위 조정안", why: "인도 전 반영 필수 변경 (인도 후 개조 불가)" })
  }
  // 대응안마다 생긴 근거 (화면 4단계 · 근거). 범위 조정안은 계산 결과(납기)로 생기므로 규칙 사실에 없다
  const optionBasis = rules
    ? {
        via: rules.via,
        items: [
          { key: "normal", letter: "A", ok: true, why: null, facts: ["모든 변경에 생성 (일반 조달)"] },
          { key: "expedite", letter: "B", ...rules.expedite },
          { key: "retrofit", letter: "C", ...rules.retrofit },
        ],
      }
    : null

  // ── 3. 추천: 계약 납기 관문 → 선주 우선순위
  const priority = priorityOf(w, changeId, priorityInput, day0)
  const ranked = [...results].sort(compareWith(priority.order))
  const recommended = ranked[0] ?? null
  const allOverrun = !!recommended && recommended.metrics.overrunSum > 0
  const second = ranked[1] ?? null

  // ── 결정 기한: 이 날을 넘기면 결과가 나빠지기 시작하는 날 (결정일을 미뤄 다시 계산)
  const badgeDays = Number(w.setting("deadline_badge_days", "7"))
  const deadlineOf = (r: OptionResult) => {
    const at = (k: number) => sim(r.method, r.excluded, addDays(day0, k), r.key)
    const worse = (x: OptionResult) => x.metrics.overrunSum > r.metrics.overrunSum || x.metrics.deliveryDelaySum > r.metrics.deliveryDelaySum || x.metrics.localDelaySum > r.metrics.localDelaySum
    if (!worse(at(365))) return null
    let lo = 0
    let hi = 365
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (worse(at(mid))) hi = mid
      else lo = mid
    }
    const date = addDays(day0, lo)
    const after = at(lo + badgeDays)
    const first = after.hulls.find((h) => {
      const b = r.hulls.find((x) => x.hullId === h.hullId)!
      return h.localDelay > b.localDelay || h.overrun > b.overrun || h.deliveryDelay > b.deliveryDelay
    })
    const b = first ? r.hulls.find((x) => x.hullId === first.hullId)! : null
    return {
      date,
      dday: diffDays(w.today, date),
      badge: diffDays(w.today, date) <= badgeDays,
      threshold:
        first && b
          ? {
              hullId: first.hullId,
              seq: first.seq,
              needBy: b.units.notStarted || b.units.fabricated ? b.needBy : b.latestAllowed,
              what: b.units.notStarted ? "제작 시작" : b.units.fabricated ? "설치 시작" : "인도 전 완료",
            }
          : null,
      ifMissed: {
        days: badgeDays,
        extraLocalDelay: Math.max(0, ...after.hulls.map((h) => h.localDelay - (r.hulls.find((x) => x.hullId === h.hullId)?.localDelay ?? 0))),
        extraDeliveryDelay: after.metrics.deliveryDelaySum - r.metrics.deliveryDelaySum,
        extraOverrun: after.metrics.overrunSum - r.metrics.overrunSum,
        extraYardCost: after.cost.yardShare - r.cost.yardShare,
      },
    }
  }

  // 계약관리 결재 (HD 기준): 계약 납기 초과 · 조선소 실부담 기준 초과 · 선주 동의 필요(인도 후 개조 호선)
  const threshold = Number(w.setting("pm_approval_threshold_krw", "100000000"))
  const approvalOf = (r: OptionResult) => {
    const triggers: { code: string; label: string }[] = []
    if (r.metrics.overrunSum > 0) triggers.push({ code: "contract_overrun", label: `계약 납기 초과 (최대 ${r.metrics.overrunMax}일)` })
    if (r.cost.yardShare > threshold) triggers.push({ code: "yard_cost", label: `조선소 실부담 ${won(r.cost.yardShare)} > 기준 ${won(threshold)}` })
    if (r.hulls.some((h) => h.treatment === "post_delivery")) triggers.push({ code: "owner_consent", label: "인도 후 개조 호선 → 선주 동의 필요" })
    return { needed: triggers.length > 0, triggers }
  }

  const options = ranked.map((r, i) => ({
    key: r.key,
    method: r.method,
    letter: LETTER[r.method] ?? "",
    label: optionLabel(w, r.method, r.excluded.map((id) => w.hull.get(id)!.hull_seq)),
    rank: i + 1,
    recommended: r === recommended,
    passesGate: r.metrics.overrunSum === 0,
    metrics: r.metrics,
    cost: r.cost,
    hulls: r.hulls,
    tasks: r.tasks,
    needsClass: r.needsClass,
    approval: approvalOf(r),
    deadline: deadlineOf(r),
  }))

  // 이미 결정한 변경: 결정 기록 (화면은 결정한 안을 보여 주고 결정 기한은 띄우지 않는다)
  const name = (id: string | null | undefined) => (id ? (w.employee.get(id)?.name ?? id) : null)
  // 결정한 안: 결정할 때 고른 안 키(실행 기록) → 없으면(DB 초기값) 같은 방식의 전체 적용안
  const decidedOption = activeDecision
    ? (options.find((o) => o.key === frozen?.option) ?? options.find((o) => o.method === activeDecision.method && !o.key.startsWith("range:")) ?? null)
    : null
  const decision = activeDecision
    ? {
        id: activeDecision.decision_id as string,
        method: activeDecision.method as string,
        optionKey: decidedOption?.key ?? frozen?.option ?? (activeDecision.method as string),
        label: decidedOption?.label ?? w.label("method", activeDecision.method),
        decidedBy: name(activeDecision.decided_by)!,
        decidedById: activeDecision.decided_by as string,
        delegatedFrom: name(activeDecision.delegated_from),
        decidedAt: activeDecision.decided_at as string, // 기록 시각 (실제 시각)
        day: (run?.as_of as string | undefined) ?? String(activeDecision.decided_at).slice(0, 10), // 결정일 (데이터셋 시계)
        state: { code: activeDecision.state as string, label: w.label("decision_state", activeDecision.state) },
        rationale: activeDecision.rationale as string | null,
        approvals: w.seed.approvals
          .filter((a) => a.decision_id === activeDecision.decision_id)
          .map((a) => ({
            id: a.approval_id as string,
            trigger: a.trigger_code as string,
            approver: name(a.approver_id)!,
            approverId: a.approver_id as string,
            state: a.state as string,
            at: (a.at as string | null) ?? null,
            comment: (a.comment as string | null) ?? null,
          })),
        teamCheckAtDecision: parseJson(activeDecision.confirmation_snapshot),
      }
    : null
  const decisionHistory = decisionRows.map((d) => ({ id: d.decision_id as string, label: w.label("method", d.method), state: w.label("decision_state", d.state), at: d.decided_at as string }))
  const rec = options[0] ?? null
  // 화면이 따라가는 안: 결정했으면 결정한 안, 아니면 추천안
  const focus = decidedOption ?? rec

  // ── 이유 3줄: 납기 · 실부담 · 2등과 차이
  const reasons: string[] = []
  if (rec && recommended) {
    const live = recommended.hulls.filter((h) => !["post_delivery", "not_applicable"].includes(h.treatment))
    if (allOverrun) {
      const worst = [...live].sort((a, b) => b.overrun - a.overrun)[0]
      reasons.push(`전 대응안 ${worst.seq}호선 계약 납기 준수 불가 · 최소 지연안 (최대 ${recommended.metrics.overrunMax}일 초과 → 선주와 인도일 협의)`)
    } else {
      const tightest = [...live].sort((a, b) => diffDays(a.newDelivery, a.contractDate) - diffDays(b.newDelivery, b.contractDate))[0]
      const excluded = recommended.excluded.map((id) => w.hull.get(id)!.hull_seq)
      reasons.push(
        `${excluded.length ? `${excluded.join(" · ")}호선 인도 후 개조, ` : ""}${live.length ? `적용 호선 전체 계약 납기 준수${tightest ? ` (최소 여유 ${tightest.seq}호선 ${diffDays(tightest.newDelivery, tightest.contractDate)}일)` : ""}` : "적용 대상 호선 없음"}`,
      )
    }
    reasons.push(`조선소 실부담 ${won(recommended.cost.yardShare)} (총비용 ${won(recommended.cost.total)}${recommended.cost.ownerShare ? `, 선주 청구 ${won(recommended.cost.ownerShare)}` : ""})`)
    if (second) reasons.push(diffLine(w, recommended, second, priority.order, priority.source === "선주 회신" ? "선주 우선순위" : "우선순위"))
  }

  // ── 4. 각 팀이 맞출 수 있어 (추천안 기준, 결정했으면 결정한 안 기준)
  const teamCheck = teamSummary(focus ? focus.tasks : base.tasks)
  const stakeholders = [...new Set((focus ? focus.tasks : base.tasks).flatMap((t) => [t.roleLabel, ...(t.counterpartKind ? [w.label("counterparty_kind", t.counterpartKind)] : [])]))]

  // ── 1단계 호선 띠 + 시리즈 공통 vs 호선마다 다른 것
  const strip = w.hulls.map((h) => {
    const r = (focus ?? recommended)?.hulls.find((x) => x.hullId === h.hull_id) ?? probe.hulls.find((x) => x.hullId === h.hull_id)!
    const st = states.filter((s) => s.hullId === h.hull_id)
    return {
      hullId: h.hull_id,
      seq: h.hull_seq,
      lifecycle: { code: h.lifecycle_status, label: w.label("lifecycle_status", h.lifecycle_status) },
      units: { notStarted: sum(st.map((s) => s.notStarted)), fabricated: sum(st.map((s) => s.fabricated)), installed: sum(st.map((s) => s.installed)) },
      treatment: r.treatment,
      deliveryDelay: r.deliveryDelay,
      overrun: r.overrun,
      newDelivery: r.newDelivery,
      contractDate: r.contractDate,
      certainty: r.certainty,
      byOption: Object.fromEntries(options.map((o) => [o.key, o.hulls.find((x) => x.hullId === h.hull_id)?.overrun ?? 0])),
    }
  })
  const common = {
    drawingNo: change.drawing_no,
    parts: parts.map((p) => p.name_ko),
    materials: (w.changeMaterials.get(changeId) ?? []).map((m) => `${w.material.get(m.material_id)?.name_ko ?? m.material_id} (${w.label("material_action", m.action)})`),
    quotes: (w.quotes.get(changeId) ?? []).map((q) => `${w.label("quote_channel", q.channel)} · ${w.counterparty.get(q.supplier_id)?.name ?? q.supplier_id}`),
    classApproval: options.some((o) => o.needsClass) ? "선급 승인 필요 (시리즈 공통 1회)" : "선급 승인 불필요",
  }

  // ── 근거: 비슷한 과거 사례 (RAG의 찾기) = 온톨로지(다섯 기준 · 부재 계층) + 문장 검색 → 사례 통계 · 관계자 제안
  const zoneKind = w.zone.get(change.zone_code)?.zone_kind
  const onto = input.ontology ?? null
  const retrieved = retrieveCases(w, {
    ontology: onto,
    query: { partKinds: [...new Set(parts.map((p) => p.part_kind as string))], changeTypes: types, zoneKind: zoneKind ?? null, reason: change.reason, timing: summary.timing.code },
    text: [change.title, change.spec_before, change.spec_after, change.original_text, ...parts.map((p) => p.name_ko)].filter(Boolean).join(" "),
  })
  const cases = retrieved.top
  const stats = caseStats(w, retrieved.pool)
  const tasksNow = focus ? focus.tasks : base.tasks
  const suggestions = suggestParties(w, retrieved.pool, {
    roles: [...new Set(tasksNow.map((t) => t.role))],
    counterparts: [...new Set(tasksNow.map((t) => t.counterpartKind).filter((x): x is string => !!x))],
  })
  const ontoNote: Fallback[] = onto
    ? []
    : [{ where: "온톨로지", what: "온톨로지 파일이 없어 대응안 규칙은 DB 사실로 판단하고, 사례는 DB에서 같은 부재만 찾고, 연결 경로 · 공통/호선마다 분류는 비움", certainty: "assumption" }]
  // 근거 화면 맨 위 연결 경로 · 1단계 시리즈 공통 / 호선마다 다름 (온톨로지, 엔진과 같은 시점까지)
  const connection = onto && !designOnly ? connectionPaths(onto, changeId, w.horizon) : null
  const split = onto ? seriesSplit(onto, changeId, w.horizon) : null

  // ── 대체값 (출처가 가정 · 사례로 내려간 곳)
  const fallbacks: Fallback[] = []
  for (const f of [...(priority.fallback ? [priority.fallback] : []), ...ontoNote, ...results.flatMap((r) => r.fallbacks), ...base.fallbacks])
    if (!fallbacks.some((x) => x.where === f.where && x.what === f.what)) fallbacks.push(f)

  // ── 기대값 비교 (데이터셋에 적힌 것만)
  const exp = w.expected.get(changeId) ?? []
  const outcome = designOnly ? "design_only" : allOverrun ? "all_overrun" : recommended?.excluded.length ? `range:${LETTER[recommended.method]}` : (LETTER[recommended?.method ?? ""] ?? "")
  const expectRow = exp.find((e) => e.check_code === "scenario_expect")
  const teammate = [...w.expected.values()].flat().filter((e) => String(e.check_code).startsWith("teammate_option_total") && String(e.note ?? "").includes(changeId))
  const expectation = {
    expect: expectRow?.value_text ?? null,
    intent: exp.find((e) => e.check_code === "scenario_intent")?.value_text ?? null,
    outcome,
    match: expectRow ? expectRow.value_text === outcome : null,
    teammate: teammate.map((e) => ({ check: e.check_code, option: e.subject, theirs: e.value_num, ours: options.find((o) => o.letter === e.subject && !o.key.startsWith("range"))?.cost.total ?? null })),
  }

  return {
    dataset: { id: w.dataset.dataset_id, name: w.dataset.name, asOf: w.asOf, horizon: w.horizon },
    decisionDay: day0,
    summary,
    designOnly,
    options,
    unavailable,
    optionBasis,
    decision,
    decisionHistory,
    recommended: rec ? { key: rec.key, label: rec.label, reasons, allOverrun, deadline: decision ? null : rec.deadline, approval: rec.approval } : null,
    priority,
    focusKey: focus?.key ?? null, // tasks · teamCheck · strip이 따라가는 안
    tasks: tasksNow,
    teamCheck,
    stakeholders,
    strip,
    common,
    seriesSplit: split,
    connection,
    cases,
    caseStats: stats,
    suggestions,
    ontology: onto ? { used: true, triples: onto.triples, schemaHash: onto.schemaHash } : { used: false, triples: 0, schemaHash: null },
    fallbacks,
    news: w.pendingEvents.map((e) => ({ id: e.event_id, system: e.system_name, at: e.occurred_at, note: e.note_ko })),
    applied: w.appliedEvents.map((e) => e.event_id),
    expectation,
    certainty: weakest(...(recommended ? recommended.hulls.map((h) => h.certainty) : []), recommended?.cost.certainty) as Certainty,
  }
}

function sum(list: number[]) {
  return list.reduce((a, b) => a + b, 0)
}

// ── 대응안 규칙 (A는 늘 있음)
//   B 긴급 조달: 이 변경에 대체되지 않은 긴급 조달 견적이 있다
//   C 기존 부품 보강: 보강 설계안이 있고, 그 대상 부품 위치 중 결정일에 이미 제작 · 설치됐고 운항 중이 아닌 호선의 것이 있다
// 사실(견적 · 설계안 · 대상 위치 · 호선 운항 여부)은 온톨로지에서 엔진과 같은 시점까지 읽는다.
// 결정일의 제작 · 설치 상태는 날짜에 따라 바뀌는 계산값이라 엔진(occurrenceState)이 준다.
// 온톨로지가 없거나, 반영한 새 소식이 그 사실의 값을 바꿨으면(온톨로지 파일에는 아직 없는 값) DB 사실로 같은 규칙을 돌린다
// 변경이 건드리는 부품의 호선별 위치마다 결정일(day)의 상태
export function changeStates(w: World, changeId: string, day: string) {
  const parts = (w.affected.get(changeId) ?? []).map((a) => w.part.get(a.part_id)!).filter(Boolean)
  return parts.flatMap((p) => (w.occurrencesOfPart.get(p.part_id) ?? []).map((o) => occurrenceState(w, o, day)))
}
const RULE_TABLES = new Set(["supplier_quote", "engineering_solution", "solution_target", "part_occurrence", "hull"])
type OccState = ReturnType<typeof occurrenceState>
export function optionRules(w: World, changeId: string, states: OccState[], onto: Ontology | null) {
  const eventTouched = w.appliedEvents.some((e) => e.target_column && RULE_TABLES.has(e.target_table))
  const via: "온톨로지" | "DB" = onto && !eventTouched ? "온톨로지" : "DB"
  const facts: OptionFacts = via === "온톨로지" ? optionFacts(onto!, changeId, w.horizon) : dbOptionFacts(w, changeId)
  const expedite = facts.quotes.filter((q) => q.channel === "expedite")
  const retrofit = facts.solutions.filter((s) => s.kind === "retrofit")
  const targetInService = new Map(retrofit.flatMap((s) => s.targets.map((t) => [t.occurrenceId, t.inService] as const)))
  const existing = states.filter((s) => targetInService.has(s.occurrence.occurrence_id) && s.fabricated + s.installed > 0 && !targetInService.get(s.occurrence.occurrence_id))
  const existingHulls = new Set(existing.map((s) => s.hullId)).size
  return {
    via,
    expedite: expedite.length
      ? { ok: true as const, why: null, facts: expedite.map((q) => `긴급 조달 견적 ${q.id}${q.supplier ? ` · ${q.supplier}` : ""}`) }
      : { ok: false as const, why: "긴급 조달 견적 없음", facts: [] as string[] },
    retrofit:
      retrofit.length && existing.length
        ? { ok: true as const, why: null, facts: [`보강 설계안 ${retrofit.map((s) => s.id).join(" · ")}`, `보강 대상 기존 부품 ${existing.length}곳 (${existingHulls}척, 제작 · 설치 완료)`] }
        : { ok: false as const, why: retrofit.length ? "보강 대상 기존 부품 없음 (전량 생산 전)" : "보강안(설계안) 없음", facts: retrofit.map((s) => `보강 설계안 ${s.id}`) },
  }
}

// 같은 사실을 DB(World)에서: 온톨로지가 없을 때 · 새 소식이 값을 바꿨을 때 · 둘이 같은지 검사할 때
export function dbOptionFacts(w: World, changeId: string): OptionFacts {
  const hullOf = new Map([...w.occurrencesOfPart.values()].flat().map((o) => [String(o.occurrence_id), String(o.hull_id)]))
  return {
    quotes: (w.quotes.get(changeId) ?? []).map((q) => ({ id: String(q.quote_id), channel: String(q.channel), supplier: w.counterparty.get(q.supplier_id)?.name ?? null })),
    solutions: (w.solutions.get(changeId) ?? []).map((s) => ({
      id: String(s.solution_id),
      kind: String(s.kind),
      targets: (w.targets.get(s.solution_id) ?? []).map((t) => ({ occurrenceId: String(t.occurrence_id), inService: w.hull.get(hullOf.get(String(t.occurrence_id)) ?? "")?.lifecycle_status === "in_service" })),
    })),
  }
}

export function optionLabel(w: World, method: Method, excludedSeqs: number[]) {
  const base = w.label("method", method)
  if (!excludedSeqs.length) return base
  const first = Math.max(...excludedSeqs) + 1
  return `${base} · ${first}호선부터 (${excludedSeqs.sort((a, b) => a - b).join(" · ")}호선은 인도 후 개조)`
}

// 선주 우선순위: 직접 준 것 → 선주 회신 이력 중 가장 최근 → 설정 기본값
export function priorityOf(w: World, changeId: string, override: string[] | undefined, day: string) {
  if (override?.length) return { order: override, source: "조건 바꿔 보기", at: null as string | null, fallback: null as Fallback | null }
  const rows = (w.ownerPreferences.get(changeId) ?? []).filter((p) => p.valid_from.slice(0, 10) <= day)
  const latest = rows.map((p) => p.valid_from as string).sort().at(-1)
  if (latest) return { order: rows.filter((p) => p.valid_from === latest).sort((a, b) => a.priority_rank - b.priority_rank).map((p) => p.criterion as string), source: "선주 회신", at: latest, fallback: null }
  return {
    order: w.setting("default_priority", "schedule,cost,production_disruption").split(","),
    source: "기본 순서 (선주 선호 없음)",
    at: null,
    fallback: { where: "선주 우선순위", what: "선주 선호 없음 → 기본 순서 (계약 납기 → 비용 → 생산 차질)", certainty: "assumption" as Certainty },
  }
}

const metricOf = (r: OptionResult, criterion: string): number[] => {
  switch (criterion) {
    case "schedule":
      return [r.metrics.deliveryDelaySum]
    case "cost":
      return [r.cost.yardShare, r.cost.total]
    case "production_disruption":
      return [r.metrics.localDelaySum + Math.round(r.metrics.reworkHours / 8)]
    case "quality":
      return [r.metrics.retrofitUnits]
    default:
      return []
  }
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}
export function compareWith(order: string[]) {
  return (a: OptionResult, b: OptionResult) => {
    const ga = a.metrics.overrunSum === 0
    const gb = b.metrics.overrunSum === 0
    if (ga !== gb) return ga ? -1 : 1
    if (!ga) {
      const d = cmp([a.metrics.overrunSum, a.metrics.overrunMax], [b.metrics.overrunSum, b.metrics.overrunMax])
      if (d) return d
    }
    for (const c of order) {
      const d = cmp(metricOf(a, c), metricOf(b, c))
      if (d) return d
    }
    return cmp([a.cost.total], [b.cost.total]) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method)
  }
}

// who: 순서의 출처 이름. 선주 회신이면 '선주 우선순위', 회의에서 바꿨거나 기본 순서면 '우선순위'
function diffLine(w: World, a: OptionResult, b: OptionResult, order: string[], who = "우선순위") {
  const label = optionLabel(w, b.method, b.excluded.map((id) => w.hull.get(id)!.hull_seq))
  if (a.metrics.overrunSum === 0 && b.metrics.overrunSum > 0) return `${label} 계약 납기 ${b.metrics.overrunMax}일 초과`
  for (const c of order) {
    const d = cmp(metricOf(a, c), metricOf(b, c))
    if (!d) continue
    if (c === "cost") {
      // 조선소 실부담이 같으면(예: 둘 다 전액 선주 청구) 차이는 총비용(선주 청구분)이다 → 그렇게 쓴다
      const yard = Math.abs(b.cost.yardShare - a.cost.yardShare)
      const what = yard ? `조선소 실부담 ${won(yard)}` : `총비용 ${won(Math.abs(b.cost.total - a.cost.total))}${a.cost.yardShare === 0 ? " (선주 청구분)" : ""}`
      return `${label} 대비 ${what} 절감 (${who}: ${w.label("owner_criterion", c)})`
    }
    if (c === "schedule") return `${label} 대비 인도 지연 ${b.metrics.deliveryDelaySum - a.metrics.deliveryDelaySum}일 단축 (${who}: ${w.label("owner_criterion", c)})`
    if (c === "production_disruption") return `${label} 대비 생산 차질 감소: 공정 지연 ${b.metrics.localDelaySum - a.metrics.localDelaySum}일 · 재작업 ${Math.round(b.metrics.reworkHours - a.metrics.reworkHours)}시간 (${who}: ${w.label("owner_criterion", c)})`
    if (c === "quality") return `${label} 대비 보강 처리 부품 감소 (${who}: ${w.label("owner_criterion", c)})`
  }
  return `${label}과 납기 · 비용 동일 · 총비용 기준 선정`
}

// 한 줄 현황: 같은 부품의 위치만 다르면 '화물배관 서포트 3곳'으로 줄이고,
// 부품 이름이 이미 구역 이름으로 시작하면 구역을 또 붙이지 않는다 ('거주구 거주구 A데크 방화문' 방지)
function oneLineOf(zone: string, partNames: string[], before: string | null, after: string | null, reason: string) {
  const bases = [...new Set(partNames.map((p) => p.replace(/\s*\(.*\)$/, "")))]
  const parts = !partNames.length ? "도면" : bases.length === 1 && partNames.length > 1 ? `${bases[0]} ${partNames.length}곳` : partNames.join(" · ")
  const where = zone && !parts.startsWith(zone) ? `${zone} ${parts}` : parts
  return `${where}: ${before ?? ""} → ${after ?? ""} (${reason})`.trim()
}

// 결정 때 쓴 입력: assessment_run.note에 JSON으로 남긴다 (server/records.ts의 decide)
export type RunInputs = { option: string; priority?: string[]; conditions?: Conditions; decisionDay?: string; events?: string[] }
function runInputs(run: Row): RunInputs | null {
  const v = parseJson(run.note) as RunInputs | null
  return v && typeof v.option === "string" ? v : null
}
function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || !text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function teamSummary(tasks: OptionResult["tasks"]) {
  const groups = new Map<string, { role: string; total: number; ok: number; notOk: number; unconfirmed: number; tight: number; short: number; owners: string[] }>()
  for (const t of tasks) {
    const g = groups.get(t.roleLabel) ?? { role: t.roleLabel, total: 0, ok: 0, notOk: 0, unconfirmed: 0, tight: 0, short: 0, owners: [] }
    g.total++
    if (t.confirmation?.answer === "ok") g.ok++
    else if (t.confirmation?.answer === "not_ok") g.notOk++
    else g.unconfirmed++
    if (t.flag === "tight") g.tight++
    if (t.flag === "short") g.short++
    if (!g.owners.includes(t.owner.name)) g.owners.push(t.owner.name)
    groups.set(t.roleLabel, g)
  }
  return [...groups.values()]
}

// '달라진 것': 두 검토 결과를 비교 (갱신하기 · 팀 확인 · 조건 바꾸기 모두 같은 방식)
export function diffReviews(before: Review, after: Review) {
  const out: { what: string; before: string; after: string }[] = []
  const push = (what: string, b: unknown, a: unknown) => {
    if (String(b) !== String(a)) out.push({ what, before: String(b ?? "없음"), after: String(a ?? "없음") })
  }
  push("추천안", before.recommended?.label, after.recommended?.label)
  push("결정 기한", before.recommended?.deadline?.date, after.recommended?.deadline?.date)
  for (const o of after.options) {
    const p = before.options.find((x) => x.key === o.key)
    if (!p) {
      out.push({ what: `대응안 ${o.label}`, before: "없음", after: "새로 생김" })
      continue
    }
    push(`${o.label} · 계약 납기 초과`, `${p.metrics.overrunSum}일`, `${o.metrics.overrunSum}일`)
    push(`${o.label} · 조선소 실부담`, won(p.cost.yardShare), won(o.cost.yardShare))
    for (const h of o.hulls) {
      const ph = p.hulls.find((x) => x.hullId === h.hullId)
      if (ph) push(`${o.label} · ${h.seq}호선 인도`, ph.newDelivery, h.newDelivery)
    }
  }
  for (const p of before.options) if (!after.options.some((o) => o.key === p.key)) out.push({ what: `대응안 ${p.label}`, before: "있음", after: "없어짐" })
  for (const t of after.tasks) {
    const p = before.tasks.find((x) => x.taskCode === t.taskCode && x.hullId === t.hullId)
    if (p) push(`할 일 · ${t.label}`, `${p.finish} (${p.days}일)`, `${t.finish} (${t.days}일)`)
  }
  return out
}
