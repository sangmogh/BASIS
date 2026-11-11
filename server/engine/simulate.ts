// 대응안 하나를 계산한다: 할 일 틀로 일정을 짜고 → 호선마다 부품 상태별로 언제 끝나는지 → 인도 · 계약 납기 → 비용 → 할 일 담당 · 여유.
// 규칙은 모두 데이터(할 일 틀 · 표준 공수 · 단가 · 기본 기간 · 견적)에서 읽는다. 할 일 이름에 기대지 않는다
import { addDays, diffDays, maxDay, minDay, median, sum, weakest, type Certainty, type Row } from "./basics.js"
import { occurrenceState, type OccState } from "./parts.js"
import { ownerFor, type Owner } from "./people.js"
import type { World } from "./world.js"

export type Method = "normal" | "expedite" | "retrofit" | "none"
type Channel = "normal" | "expedite" | "retrofit" | "stock" | "none"
export type Conditions = {
  leadDays?: Partial<Record<"normal" | "expedite" | "retrofit", number>> // 조달 기간 바꿔 보기
  taskDays?: Record<string, number> // 할 일 기간 바꿔 보기 (task_code → 일)
  startHullSeq?: number // 적용 시작 호선: 이 순번 앞 호선은 인도 후 개조
}
export type Confirmation = {
  task_code: string
  hull_id?: string | null
  employee_id: string
  answer: "ok" | "not_ok"
  edited_days?: number | null
  reason?: string | null
  memo?: string | null
  entered_by?: string
  spoken_by?: string | null
  at: string
}
export type Fallback = { where: string; what: string; certainty: Certainty }
export type OptionSpec = { key: string; method: Method; excluded: string[] }
export type SimInput = { decisionDay: string; conditions: Conditions; confirmations: Confirmation[] }

export type HullResult = {
  hullId: string
  seq: number
  lifecycle: string
  treatment: "new_spec" | "rework" | "retrofit" | "mixed" | "post_delivery" | "not_applicable"
  units: { notStarted: number; fabricated: number; installed: number; retrofit: number }
  partState: { certainty: Certainty; source: string }
  materialFrom: Channel | null
  ready: string | null
  needBy: string | null
  localDelay: number
  plannedFinish: string | null
  newFinish: string | null
  latestAllowed: string | null
  deliveryDelay: number
  recovered: number
  plannedDelivery: string
  newDelivery: string
  contractDate: string
  contractSource: string
  overrun: number
  ldRisk: number | null
  certainty: Certainty
}
export type CostLine = { code: string; label: string; amount: number; certainty: Certainty; source: string; details: string[] }
export type TaskResult = {
  taskCode: string
  when: string | null // 이 일을 만든 조건 (할 일 틀의 when_code: in_service_hull · installed_rework …)
  label: string
  role: string
  roleLabel: string
  counterpart: string | null
  counterpartKind: string | null
  hullId: string | null
  start: string
  finish: string
  days: number
  durationSource: string
  certainty: Certainty
  owner: Owner
  latestFinish: string | null
  slack: number | null
  flag: "ok" | "tight" | "short" | null
  confirmation: { answer: string; by: string; at: string; edited_days: number | null; reason: string | null; enteredBy: "self" | "chair"; spokenBy: string | null } | null
}
export type OptionResult = {
  key: string
  method: Method
  excluded: string[]
  hulls: HullResult[]
  cost: { lines: CostLine[]; total: number; ownerShare: number; yardShare: number; ownerPct: number; payerSource: string; certainty: Certainty }
  tasks: TaskResult[]
  metrics: { overrunSum: number; overrunMax: number; deliveryDelaySum: number; localDelaySum: number; reworkHours: number; retrofitUnits: number; ldSum: number }
  needsClass: boolean
  fallbacks: Fallback[]
}

const MATERIAL_WHEN: Record<string, Channel> = { method_normal: "normal", method_expedite: "expedite", method_retrofit: "retrofit", has_stock: "stock" }
const PASS = new Set(["approved", "not_required"])
const split = (list: string) =>
  String(list ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

export function simulate(w: World, changeId: string, spec: OptionSpec, input: SimInput): OptionResult {
  const change = w.change.get(changeId)
  if (!change) throw new Error(`변경 없음: ${changeId}`)
  const day0 = input.decisionDay
  const fallbacks: Fallback[] = []
  const note = (where: string, what: string, certainty: Certainty) => {
    if (!fallbacks.some((f) => f.where === where && f.what === what)) fallbacks.push({ where, what, certainty })
  }
  const hpd = Number(w.setting("work_hours_per_day", "8"))
  const partIds = (w.affected.get(changeId) ?? []).map((a) => a.part_id as string)
  const relocation = String(change.change_types).includes("relocation")
  const scopeOf = new Map((w.scope.get(changeId) ?? []).map((s) => [s.hull_id as string, s.scope_state as string]))
  const solutions = w.solutions.get(changeId) ?? []
  const replaceSolutions = solutions.filter((s) => s.kind === "replace")
  const retrofitSolutions = solutions.filter((s) => s.kind === "retrofit")
  const retrofitOcc = new Set(retrofitSolutions.flatMap((s) => (w.targets.get(s.solution_id) ?? []).map((t) => t.occurrence_id)))
  const cms = w.changeMaterials.get(changeId) ?? []
  const addMats = cms.filter((m) => m.action === "add" || m.action === "replace")
  const retroMats = cms.filter((m) => m.action === "retrofit")
  const removeMats = cms.filter((m) => m.action === "remove")
  const quotes = w.quotes.get(changeId) ?? []

  // ── 호선 나누기: 적용 / 인도 후 개조 / 해당 없음
  type Active = { hull: Row; states: OccState[]; rep: { n: number; f: number; i: number }; ret: { f: number; i: number }; total: number }
  const active: Active[] = []
  const postDelivery: Row[] = []
  const notApplicable: Row[] = []
  for (const hull of w.hulls) {
    const occs = partIds.flatMap((p) => (w.occurrencesOfPart.get(p) ?? []).filter((o) => o.hull_id === hull.hull_id))
    const scope = scopeOf.get(hull.hull_id) ?? (occs.length ? (hull.lifecycle_status === "in_service" ? "service_separate" : "in_scope") : "excluded")
    if (spec.method === "none" || scope === "excluded" || !occs.length) {
      notApplicable.push(hull)
      continue
    }
    const cutByStart = input.conditions.startHullSeq != null && hull.hull_seq < input.conditions.startHullSeq
    if (scope === "service_separate" || hull.lifecycle_status === "in_service" || spec.excluded.includes(hull.hull_id) || cutByStart) {
      if (cutByStart && !change.post_delivery_allowed) note("적용 시작 호선", `${hull.hull_seq}호선: 인도 전에 고쳐야 하는 변경인데 적용에서 뺐어요`, "assumption")
      postDelivery.push(hull)
      continue
    }
    const states = occs.map((o) => occurrenceState(w, o, day0))
    const rep = { n: 0, f: 0, i: 0 }
    const ret = { f: 0, i: 0 }
    for (const s of states) {
      rep.n += s.notStarted
      if (spec.method === "retrofit" && retrofitOcc.has(s.occurrence.occurrence_id)) {
        ret.f += s.fabricated
        ret.i += s.installed
      } else {
        rep.f += s.fabricated
        rep.i += s.installed
      }
      if (s.certainty !== "confirmed") note("부품 상태", `${hull.hull_seq}호선 ${s.part.name_ko}: ${s.source}`, s.certainty)
    }
    active.push({ hull, states, rep, ret, total: sum(states.map((s) => s.qty)) })
  }

  // ── 자재: 새 사양 부품의 자재는 재고 → (없으면) 일반 · 긴급 조달. 필요 시점이 이른 호선부터 재고를 준다
  const replaceChannel: Channel = spec.method === "expedite" ? "expedite" : "normal"
  const repUnits = (a: Active) => a.rep.n + a.rep.f + a.rep.i
  const retUnits = (a: Active) => a.ret.f + a.ret.i
  const need = (a: Active, mats: Row[], units: number) => mats.map((m) => ({ m, qty: a.total ? (Number(m.qty_per_hull) * units) / a.total : 0 }))
  const stockLeft = new Map(addMats.map((m) => [m.material_id as string, Number(m.stock_qty ?? 0)]))
  const source = new Map<string, Channel>()
  const firstNeed = (a: Active) => minDay(...a.states.map((s) => (s.notStarted > 0 ? s.fabStart : s.installStart))) ?? day0
  for (const a of [...active].sort((x, y) => firstNeed(x).localeCompare(firstNeed(y)))) {
    if (!repUnits(a)) continue
    if (!addMats.length) {
      source.set(a.hull.hull_id, "none")
      continue
    }
    const needs = need(a, addMats, repUnits(a))
    if (needs.every(({ m, qty }) => (stockLeft.get(m.material_id) ?? 0) >= qty)) {
      needs.forEach(({ m, qty }) => stockLeft.set(m.material_id, (stockLeft.get(m.material_id) ?? 0) - qty))
      source.set(a.hull.hull_id, "stock")
    } else source.set(a.hull.hull_id, replaceChannel)
  }
  const used = new Set<Channel>([...source.values()])
  if (active.some((a) => retUnits(a) > 0)) used.add("retrofit")

  const physical = spec.method !== "none" && (active.length > 0 || postDelivery.length > 0)
  const solutionPending = (list: Row[]) => list.some((s) => !PASS.has(s.class_state))
  const needsClass = (active.some((a) => repUnits(a) > 0) && solutionPending(replaceSolutions)) || (active.some((a) => retUnits(a) > 0) && solutionPending(retrofitSolutions))
  const subconHulls = new Set(active.filter((a) => a.states.some((s) => s.builderId)).map((a) => a.hull.hull_id))
  const installedRework = active.some((a) => a.rep.i + a.ret.i > 0)
  const openOrder = removeMats.some((m) => Number(m.open_order_qty) > 0 || Number(m.stock_qty) > 0)

  const whenOk = (code: string, overrun = false): boolean => {
    switch (code) {
      case "always":
        return true
      case "has_parts":
        return physical
      case "design_only":
        return !physical
      case "needs_class":
        return physical && needsClass
      case "owner_request":
        return change.reason === "owner_request"
      case "method_normal":
        return used.has("normal")
      case "method_expedite":
        return used.has("expedite")
      case "method_retrofit":
        return used.has("retrofit")
      case "has_stock":
        return used.has("stock")
      case "has_open_order":
        return physical && openOrder
      case "subcon_block":
        return subconHulls.size > 0
      case "installed_rework":
        return installedRework
      case "in_service_hull":
        return postDelivery.length > 0
      case "delivery_overrun":
        return overrun
      default:
        note("할 일 틀", `모르는 조건 '${code}' → 만들지 않음`, "assumption")
        return false
    }
  }
  const present = w.templates.filter((t) => t.when_code !== "delivery_overrun" && whenOk(t.when_code))
  const isField = (t: Row) => t.duration_from === "work_standard"
  const isPerHull = (t: Row) => isField(t) || t.when_code === "installed_rework"
  const globals = new Map(present.filter((t) => !isPerHull(t)).map((t) => [t.task_code as string, t]))
  const fieldTpl = present.find(isField)
  const reinspectTpl = present.find((t) => t.when_code === "installed_rework")

  // ── 기간: 조건 바꾸기 → 담당자 수정 → 견적 · 기본 기간
  // 목록 순서가 곧 우선순위: DB 초기값 → 저장된 기록(시각 순) → 요청의 '만약에' (review가 이 순서로 넘긴다). 마지막 것이 이긴다
  const confirmationOf = (code: string, hullId: string | null) => input.confirmations.filter((c) => c.task_code === code && (c.hull_id ?? null) === hullId).at(-1) ?? null
  const durationDefault = (key: string | null) => {
    const row = key ? w.duration.get(key) : undefined
    if (!row) {
      note("기본 기간", `'${key}' 기본 기간 없음 → 0일 (가정)`, "assumption")
      return { days: 0, certainty: "assumption" as Certainty, source: "기본 기간 없음" }
    }
    return { days: Number(row.days), certainty: row.certainty as Certainty, source: `${row.label_ko} ${row.days}일 (${w.label("certainty", row.certainty)})` }
  }
  const supplierName = (id: string) => w.counterparty.get(id)?.name ?? id
  const lead = (channel: Channel, t: Row) => {
    const override = input.conditions.leadDays?.[channel as "normal"]
    if (override != null) return { days: override, certainty: "provisional" as Certainty, source: `조건 바꿔 보기 ${override}일` }
    if (channel === "stock" || channel === "none") return durationDefault(t.duration_key)
    const q = quotes.filter((x) => x.channel === channel).sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0]
    if (q?.lines.length) {
      const days = Math.max(...q.lines.map((l: Row) => diffDays(q.received_at, l.delivery_date)))
      return { days, certainty: weakest(q.certainty, ...q.lines.map((l: Row) => l.certainty)), source: `${supplierName(q.supplier_id)} ${w.label("quote_channel", channel)} 견적 ${days}일` }
    }
    const mats = (channel === "retrofit" ? retroMats : addMats).filter((m) => m.standard_lead_days != null)
    if (mats.length) {
      const m = mats.sort((a, b) => b.standard_lead_days - a.standard_lead_days)[0]
      return { days: Number(m.standard_lead_days), certainty: m.certainty as Certainty, source: `표준 조달 기간 ${m.standard_lead_days}일` }
    }
    const d = durationDefault(t.duration_key)
    note("조달 기간", `${w.label("quote_channel", channel)}: 견적 · 표준 조달 기간 없음 → ${d.source}`, d.certainty)
    return d
  }
  const durationOf = (t: Row, hullId: string | null = null) => {
    const override = input.conditions.taskDays?.[t.task_code]
    if (override != null) return { days: override, certainty: "provisional" as Certainty, source: `조건 바꿔 보기 ${override}일` }
    const c = confirmationOf(t.task_code, hullId)
    if (c && c.answer === "not_ok" && c.edited_days != null) return { days: Number(c.edited_days), certainty: "confirmed" as Certainty, source: `${w.employee.get(c.employee_id)?.name ?? c.employee_id} 수정 ${c.edited_days}일` }
    if (t.duration_from === "quote") return lead(MATERIAL_WHEN[t.when_code] ?? "normal", t)
    return durationDefault(t.duration_key)
  }

  // ── 공통 할 일 일정 (앞 일이 끝나야 시작)
  const sched = new Map<string, { start: string; finish: string; days: number; certainty: Certainty; source: string }>()
  const scheduleGlobal = (code: string, stack: string[] = []): string => {
    const done = sched.get(code)
    if (done) return done.finish
    if (stack.includes(code)) throw new Error(`할 일 틀에 순환이 있어요: ${[...stack, code].join(" → ")}`)
    const t = globals.get(code)!
    const preds = split(t.predecessors).filter((p) => globals.has(p))
    const start = maxDay(day0, ...preds.map((p) => scheduleGlobal(p, [...stack, code])))!
    const d = durationOf(t)
    const finish = addDays(start, Math.ceil(d.days))
    sched.set(code, { start, finish, days: d.days, certainty: d.certainty, source: d.source })
    return finish
  }
  for (const code of globals.keys()) scheduleGlobal(code)

  const fieldPreds = fieldTpl ? split(fieldTpl.predecessors).filter((p) => globals.has(p)) : [...globals.keys()]
  if (physical && !fieldTpl) note("할 일 틀", "현장 작업 틀(표준 공수)이 없어 모든 공통 할 일이 끝난 뒤 작업한다고 봄", "assumption")
  const applies = (code: string, hullId: string, cat: "replace" | "retrofit") => {
    const ch = MATERIAL_WHEN[globals.get(code)!.when_code]
    if (globals.get(code)!.when_code === "subcon_block") return subconHulls.has(hullId)
    if (!ch) return true
    if (ch === "retrofit") return cat === "retrofit"
    return cat === "replace" && source.get(hullId) === ch
  }
  const readyFor = (hullId: string, cat: "replace" | "retrofit") => maxDay(day0, ...fieldPreds.filter((p) => applies(p, hullId, cat)).map((p) => sched.get(p)!.finish))!
  const readyCertainty = (hullId: string, cat: "replace" | "retrofit") => weakest(...fieldPreds.filter((p) => applies(p, hullId, cat)).map((p) => sched.get(p)!.certainty))

  // ── 표준 공수
  const standard = (kind: string, work: string, state: string) =>
    w.standards.find((s) => s.part_kind === kind && s.work_kind === work && s.part_state === state) ?? w.standards.find((s) => s.part_kind === kind && s.work_kind === work && s.part_state === "any")
  const workKinds = (cat: "replace" | "retrofit") => (cat === "retrofit" ? (relocation ? ["retrofit", "relocate"] : ["retrofit"]) : relocation ? ["relocate", "replace"] : ["replace"])
  const handling = durationDefault(fieldTpl?.duration_key ?? "production_handling")

  // ── 호선별 계산
  const hullResults: HullResult[] = []
  const work = new Map<string, { fabHours: number; insHours: number; inspectHours: number; days: number; reinspectDays: number; crew: number; start: string | null; finish: string | null; certainty: Certainty; source: string }>()
  for (const a of active) {
    const h = a.hull
    let fabHours = 0
    let insHours = 0
    let inspectHours = 0
    let crew = 2
    let missing = false
    let stdCertainty: Certainty = "confirmed"
    const daysBy: Record<string, number> = {}
    for (const s of a.states) {
      const isRet = spec.method === "retrofit" && retrofitOcc.has(s.occurrence.occurrence_id)
      const cat = isRet ? "retrofit" : "replace"
      for (const state of ["fabricated", "installed"] as const) {
        const units = s[state]
        if (!units) continue
        const std = workKinds(cat)
          .map((k) => standard(s.part.part_kind, k, state))
          .find(Boolean)
        if (!std) {
          missing = true
          note("표준 공수", `${s.part.name_ko} (${w.label("part_state", state)}) 표준 공수 없음 → ${handling.source}`, handling.certainty)
          daysBy[`${cat}:${state}`] = Math.max(daysBy[`${cat}:${state}`] ?? 0, handling.days)
          continue
        }
        crew = Math.max(crew, Number(std.crew_size ?? 2))
        stdCertainty = weakest(stdCertainty, std.certainty)
        const hours = units * Number(std.hours_per_unit)
        if (state === "installed") insHours += hours
        else fabHours += hours
        daysBy[`${cat}:${state}`] = (daysBy[`${cat}:${state}`] ?? 0) + hours / (crew * hpd)
      }
      if (s.installed) {
        const r = standard(s.part.part_kind, "reinspect", "installed")
        if (r) inspectHours += s.installed * Number(r.hours_per_unit)
      }
    }
    const reinspect = reinspectTpl && a.rep.i + a.ret.i > 0 ? durationOf(reinspectTpl, h.hull_id) : null
    const rR = readyFor(h.hull_id, "replace")
    const rC = readyFor(h.hull_id, "retrofit")
    const daysOf = (k: string) => Math.ceil(daysBy[k] ?? 0)
    // 생산 전 부품: 새 사양 도면 · 자재가 제작 시작 전에 있어야 함
    const fabStartN = minDay(...a.states.filter((s) => s.notStarted > 0).map((s) => s.fabStart))
    const delayN = a.rep.n > 0 && fabStartN ? Math.max(0, diffDays(maxDay(fabStartN, day0)!, rR)) : 0
    // 제작된 부품: 설치 시작 전에 고쳐야 함
    const installStartF = minDay(...a.states.filter((s) => s.fabricated > 0).map((s) => s.installStart))
    const doneF = maxDay(a.rep.f ? addDays(rR, daysOf("replace:fabricated")) : null, a.ret.f ? addDays(rC, daysOf("retrofit:fabricated")) : null)
    const delayF = doneF && installStartF ? Math.max(0, diffDays(maxDay(installStartF, day0)!, doneF)) : 0
    // 설치된 부품: 떼고 고친 뒤 재검사
    const rd = reinspect ? Math.ceil(reinspect.days) : 0
    const doneI = maxDay(a.rep.i ? addDays(rR, daysOf("replace:installed") + rd) : null, a.ret.i ? addDays(rC, daysOf("retrofit:installed") + rd) : null)
    const baselineFinish = maxDay(...a.states.map((s) => s.installFinish))!
    const localDelay = Math.max(delayN, delayF)
    const newFinish = maxDay(addDays(baselineFinish, localDelay), doneI)!

    const path = w.path.get(h.hull_id)
    const planned = h.planned_delivery_date as string
    let latestAllowed = baselineFinish
    let pathCertainty: Certainty = "assumption"
    if (path && path.integration_days != null) {
      latestAllowed = addDays(planned, -(Number(path.integration_days) + Number(path.acceptance_days ?? 0)))
      pathCertainty = path.certainty
    } else note("인도 경로", `${h.hull_seq}호선 인도 경로 없음 → 변경 부품의 원래 완료일까지만 허용 (여유 0, 가정)`, "assumption")
    const deliveryDelay = Math.max(0, diffDays(latestAllowed, newFinish))

    // 만회: 작업장 남는 시간으로 최대 5일 (가정)
    let recovered = 0
    if (deliveryDelay > 0) {
      const group = a.states.find((s) => s.installGroup)?.installGroup ?? null
      const rows = (group ? (w.availability.get(group) ?? []) : []).filter((r) => r.calendar_date >= addDays(newFinish, -14) && r.calendar_date < newFinish)
      if (!rows.length) note("만회", `${h.hull_seq}호선: 작업장 여력 정보 없음 → 만회 없음`, "assumption")
      else {
        recovered = Math.min(deliveryDelay, 5, Math.floor(sum(rows.map((r) => Number(r.available_hours))) / (crew * hpd)))
        if (recovered) note("만회", "잔업 · 특근은 작업장 남는 시간 안에서 최대 5일 (가정)", "assumption")
      }
    }
    const newDelivery = addDays(planned, deliveryDelay - recovered)
    const c = w.contract.get(h.hull_id)
    let contractDate = planned
    let contractSource = "인도 예정일 (계약 납기 · 공정 여유 없음, 가정)"
    let contractCertainty: Certainty = "assumption"
    if (c) {
      contractDate = c.contract_delivery_date
      contractSource = "계약"
      contractCertainty = c.certainty
    } else {
      // 공정 여유는 인도일이 밀리기 전에 이미 썼으니, 계약 납기 대신 인도 예정일을 쓴다 (여유를 두 번 세지 않게, 11/5 결정)
      contractSource = "인도 예정일 (계약 납기 없음, 가정)"
      note("계약 납기", `${h.hull_seq}호선 계약 납기 없음 → 인도 예정일을 계약 납기로 봄`, "assumption")
    }
    const overrun = Math.max(0, diffDays(contractDate, newDelivery))
    const ld = c?.ld_per_day_krw != null ? Math.min(overrun * Number(c.ld_per_day_krw), c.ld_cap_krw != null ? Number(c.ld_cap_krw) : Infinity) : null
    if (overrun && ld == null) note("지체상금", `${h.hull_seq}호선 지체상금 단가 없음`, "assumption")

    const units = { notStarted: a.rep.n, fabricated: a.rep.f + a.ret.f, installed: a.rep.i + a.ret.i, retrofit: retUnits(a) }
    const treatment: HullResult["treatment"] =
      units.retrofit && repUnits(a) ? "mixed" : units.retrofit ? "retrofit" : units.fabricated + units.installed ? "rework" : "new_spec"
    const fieldDays = Math.max(...Object.values(daysBy).map(Math.ceil), 0)
    work.set(h.hull_id, {
      fabHours,
      insHours,
      inspectHours,
      days: fieldDays,
      reinspectDays: rd,
      crew,
      start: units.fabricated + units.installed ? minDay(a.rep.f + a.rep.i ? rR : null, a.ret.f + a.ret.i ? rC : null) : null,
      finish: maxDay(doneF, doneI && rd ? addDays(doneI, -rd) : doneI),
      certainty: missing ? weakest(stdCertainty, handling.certainty) : stdCertainty,
      source: missing ? handling.source : "표준 공수",
    })
    const partCertainty = weakest(...a.states.map((s) => s.certainty))
    hullResults.push({
      hullId: h.hull_id,
      seq: h.hull_seq,
      lifecycle: h.lifecycle_status,
      treatment,
      units,
      partState: { certainty: partCertainty, source: [...new Set(a.states.map((s) => s.source))].join(" · ") },
      materialFrom: source.get(h.hull_id) ?? (units.retrofit ? "retrofit" : null),
      ready: units.retrofit && !repUnits(a) ? rC : rR,
      needBy: minDay(fabStartN, installStartF),
      localDelay,
      plannedFinish: baselineFinish,
      newFinish,
      latestAllowed,
      deliveryDelay: deliveryDelay - recovered,
      recovered,
      plannedDelivery: planned,
      newDelivery,
      contractDate,
      contractSource,
      overrun,
      ldRisk: ld,
      certainty: weakest(partCertainty, pathCertainty, contractCertainty, readyCertainty(h.hull_id, "replace"), work.get(h.hull_id)!.certainty),
    })
  }
  for (const h of postDelivery)
    hullResults.push(fixed(h, "post_delivery", w.contract.get(h.hull_id)?.contract_delivery_date ?? h.planned_delivery_date, partIds.length ? sum(partIds.flatMap((p) => (w.occurrencesOfPart.get(p) ?? []).filter((o) => o.hull_id === h.hull_id).map((o) => Number(o.required_qty)))) : 0))
  for (const h of notApplicable) hullResults.push(fixed(h, "not_applicable", w.contract.get(h.hull_id)?.contract_delivery_date ?? h.planned_delivery_date, 0))
  hullResults.sort((a, b) => a.seq - b.seq)

  const metrics = {
    overrunSum: sum(hullResults.map((r) => r.overrun)),
    overrunMax: Math.max(0, ...hullResults.map((r) => r.overrun)),
    deliveryDelaySum: sum(hullResults.map((r) => r.deliveryDelay)),
    localDelaySum: sum(hullResults.map((r) => r.localDelay)),
    reworkHours: sum([...work.values()].map((x) => x.fabHours + x.insHours)),
    retrofitUnits: sum(hullResults.map((r) => r.units.retrofit)),
    ldSum: sum(hullResults.map((r) => r.ldRisk ?? 0)),
  }

  // ── 비용
  const lines: CostLine[] = []
  const rate = (code: string) => w.costRate.get(code)
  // 같은 항목은 한 줄로 합치고, 호선 · 자재별 내역은 details에
  const add = (code: string, amount: number, certainty: Certainty, source: string, label?: string) => {
    if (!amount) return
    const name = label ?? w.label("cost_item", code)
    const line = lines.find((l) => l.code === code && l.label === name)
    if (line) {
      line.amount += Math.round(amount)
      line.certainty = weakest(line.certainty, certainty)
      line.details.push(source)
      line.source = `${line.details.length}건 합계`
    } else lines.push({ code, label: name, amount: Math.round(amount), certainty, source, details: [source] })
  }
  const byRate = (code: string, qty: number, what: string) => {
    if (!qty) return
    const r = rate(code)
    if (!r) {
      note("단가", `${w.label("cost_item", code)} 단가 없음 → 0원 (가정)`, "assumption")
      return
    }
    add(code, qty * Number(r.unit_cost_krw) * (code === "salvage_credit" ? -1 : 1), r.certainty, `${what} × ${Number(r.unit_cost_krw).toLocaleString("ko-KR")}원 (${w.label("certainty", r.certainty)})`)
  }
  const priceOf = (materialId: string, channel: Channel) => {
    const fromQuote = (ch: string) =>
      quotes
        .filter((q) => q.channel === ch)
        .flatMap((q) => q.lines.filter((l: Row) => l.material_id === materialId).map((l: Row) => ({ price: Number(l.unit_price_krw), certainty: weakest(q.certainty, l.certainty) as Certainty, source: `${supplierName(q.supplier_id)} 견적` })))[0]
    const q = fromQuote(channel === "stock" ? "normal" : channel) ?? fromQuote("normal")
    if (q) return q
    const pl = (w.purchaseLines.get(materialId) ?? [])[0]
    if (pl) return { price: Number(pl.unit_price_krw), certainty: pl.certainty as Certainty, source: "기존 발주 단가" }
    return null
  }
  const caseMedian = (kind: string) => {
    const ids = new Set(w.cases.filter((c) => c.part_kind === kind).map((c) => c.case_id))
    const pick = (only: boolean) => median(w.cases.filter((c) => !only || ids.has(c.case_id)).flatMap((c) => (w.caseResults.get(c.case_id) ?? []).filter((r) => r.handling === "apply_now" && r.actual_cost_krw != null).map((r) => Number(r.actual_cost_krw))))
    return pick(true) ?? pick(false)
  }
  const kind = partIds.length ? w.part.get(partIds[0])?.part_kind : null
  const materialLine = (code: string, label: string, mats: Row[], units: (a: Active) => number, channelOf: (a: Active) => Channel) => {
    const byMat = new Map<string, { qty: number; channel: Channel }>()
    for (const a of active) {
      const u = units(a)
      if (!u) continue
      for (const { m, qty } of need(a, mats, u)) byMat.set(m.material_id, { qty: (byMat.get(m.material_id)?.qty ?? 0) + qty, channel: channelOf(a) })
    }
    for (const [id, { qty, channel }] of byMat) {
      const p = priceOf(id, channel)
      const name = w.material.get(id)?.name_ko ?? id
      if (p) add(code, qty * p.price, p.certainty, `${name} ${Math.round(qty)}개 × ${p.price.toLocaleString("ko-KR")}원 (${p.source})`, label)
      else {
        const m = kind ? caseMedian(kind) : null
        const hulls = active.filter((a) => units(a) > 0).length
        note("단가", `${name} 단가 없음 → ${m != null ? "사례 중간값 (호선당)" : "0원 (가정)"}`, m != null ? "case" : "assumption")
        if (m != null) add(code, m * hulls, "case", `${name}: 단가 없음 → 같은 부품 사례 비용 중간값 × ${hulls}척`, `${label} (사례 중간값)`)
      }
    }
  }
  materialLine("material", "자재", addMats, repUnits, (a) => source.get(a.hull.hull_id) ?? "normal")
  materialLine("material", "보강 자재", retroMats, retUnits, () => "retrofit")
  if (spec.method === "expedite") byRate("expedite_handling", Math.round(sum(active.filter((a) => source.get(a.hull.hull_id) === "expedite").flatMap((a) => need(a, addMats, repUnits(a)).map((x) => x.qty)))), "긴급 조달 수량")
  const laborRate = (group: string | null, fallback: string) => [...w.costRate.values()].find((r) => r.applies_to && r.applies_to === group)?.cost_code ?? fallback
  for (const a of active) {
    const x = work.get(a.hull.hull_id)!
    const fabGroup = a.states.find((s) => s.fabGroup)?.fabGroup ?? null
    const insGroup = a.states.find((s) => s.installGroup)?.installGroup ?? null
    byRate(laborRate(fabGroup, "fabrication_labor"), Math.round(x.fabHours * 10) / 10, `${a.hull.hull_seq}호선 제작 재작업 ${Math.round(x.fabHours)}시간`)
    byRate(laborRate(insGroup, "installation_labor"), Math.round(x.insHours * 10) / 10, `${a.hull.hull_seq}호선 설치 재작업 ${Math.round(x.insHours)}시간`)
    byRate("inspection", Math.round(x.inspectHours * 10) / 10, `${a.hull.hull_seq}호선 재검사 ${Math.round(x.inspectHours)}시간`)
  }
  const reworkHulls = active.filter((a) => a.rep.i + a.ret.i > 0)
  byRate("reinspection_fee", reworkHulls.length, `설치된 부품을 고친 호선 ${reworkHulls.length}척`)
  const installedOccs = active.flatMap((a) => a.states.filter((s) => s.installed > 0))
  byRate("scaffolding", installedOccs.length, `설치된 위치 ${installedOccs.length}곳`)
  const welded = installedOccs.filter((s) => ["hull", "piping"].includes(s.part.work_type))
  byRate("hot_work", sum(welded.map((s) => s.installed)), `용접 재작업 ${sum(welded.map((s) => s.installed))}개`)
  byRate("paint_repair", sum(welded.map((s) => s.installed)), `도장 보수 ${sum(welded.map((s) => s.installed))}개`)
  byRate("salvage_credit", sum(active.map((a) => a.rep.f + a.rep.i)), "떼어 낸 기존 부품")
  const designDays = sum([...globals.values()].filter((t) => t.owner_role === "design" && !t.counterpart_kind).map((t) => sched.get(t.task_code)!.days))
  byRate("design_labor", designDays * hpd, `설계 ${designDays}일 × ${hpd}시간`)
  if (physical && needsClass) byRate("class_fee", 1, "선급 승인 1건")
  byRate("subcon_change_fee", subconHulls.size, `협력사 블록 호선 ${subconHulls.size}척`)
  const lossRate = rate("order_cancellation_loss")
  for (const m of physical ? removeMats : []) {
    const qty = Number(m.open_order_qty ?? 0) + Number(m.stock_qty ?? 0)
    const p = priceOf(m.material_id, "normal")
    if (!qty) continue
    if (!p || !lossRate) {
      note("단가", `${w.material.get(m.material_id)?.name_ko ?? m.material_id}: 기존 발주 취소 손실을 계산할 단가 · 비율 없음`, "assumption")
      continue
    }
    add("order_cancellation_loss", qty * p.price * Number(lossRate.unit_cost_krw), weakest(p.certainty, lossRate.certainty), `${w.material.get(m.material_id)?.name_ko ?? m.material_id} 남는 ${qty}개 × ${p.price.toLocaleString("ko-KR")}원 × ${lossRate.unit_cost_krw}`)
  }
  const recoveredHours = sum(hullResults.map((r) => r.recovered)) * 2 * hpd
  byRate("overtime_premium", recoveredHours, `만회 ${sum(hullResults.map((r) => r.recovered))}일`)
  const idleDays = sum(hullResults.filter((r) => r.units.fabricated > 0).map((r) => Math.min(r.localDelay, 2)))
  if (idleDays) note("작업 중단 대기", "제작된 부품이 기다리는 동안 작업반 대기는 호선당 최대 2일 (가정)", "assumption")
  byRate("idle_wait", idleDays, `작업반 대기 ${idleDays}일`)
  byRate("post_delivery_retrofit", postDelivery.length, `인도 후 개조 ${postDelivery.length}척`)

  const total = sum(lines.map((l) => l.amount))
  const term = w.contractTerms.find((t) => t.reason === change.reason && !t.hull_id)
  const rule = w.payerRule.get(change.reason)
  let ownerPct = 0
  let payerSource = "조선소 부담 (부담 규칙 없음, 가정)"
  let payerCertainty: Certainty = "assumption"
  if (term) {
    ownerPct = Number(term.owner_share_pct)
    payerSource = `계약 조건: ${term.note ?? ""}`.trim()
    payerCertainty = term.certainty
  } else if (rule) {
    ownerPct = rule.payer === "owner" ? 100 : 0
    payerSource = rule.payer === "contract" ? "계약 조건을 따르는데 계약 조건이 없어 조선소 부담 (가정)" : `부담 규칙: ${rule.note ?? w.label("payer", rule.payer)}`
    payerCertainty = rule.payer === "contract" ? "assumption" : "confirmed"
    if (rule.payer === "contract") note("부담 주체", "계약 조건 없음 → 조선소 부담 (가정)", "assumption")
  } else note("부담 주체", "사유별 부담 규칙 없음 → 조선소 부담 (가정)", "assumption")
  const ownerShare = Math.round((total * ownerPct) / 100)

  // ── 할 일 (공통 + 호선별 현장 작업 · 재검사) + 담당 + 여유
  const allBlocks = [...new Set(active.flatMap((a) => a.states.map((s) => s.blockId)))]
  const builders = [...new Set(active.flatMap((a) => a.states.map((s) => s.builderId).filter((x): x is string => !!x)))]
  const materialIdsFor = (t: Row) => {
    const ch = MATERIAL_WHEN[t.when_code]
    if (t.when_code === "has_open_order") return removeMats.map((m) => m.material_id)
    if (ch === "retrofit") return retroMats.map((m) => m.material_id)
    return [...addMats, ...retroMats, ...removeMats].map((m) => m.material_id)
  }
  const counterpartOf = (t: Row, hullId: string | null) => {
    switch (t.counterpart_kind) {
      case "owner":
        return w.counterparty.get(w.series?.owner_id)?.name ?? "선주"
      case "class":
        return w.counterparty.get(w.series?.class_society_id)?.name ?? "선급"
      case "supplier": {
        if (t.when_code === "has_open_order") {
          const names = removeMats.flatMap((m) => (w.purchaseLines.get(m.material_id) ?? []).map((l) => w.purchaseOrder.get(l.po_id)?.supplier_id).filter(Boolean)).map((id) => supplierName(id as string))
          return [...new Set(names)].join(" · ") || "기존 발주처"
        }
        const ch = MATERIAL_WHEN[t.when_code]
        const q = quotes.find((x) => x.channel === ch)
        return q ? supplierName(q.supplier_id) : "공급사"
      }
      case "subcontractor": {
        const ids = hullId ? active.find((a) => a.hull.hull_id === hullId)?.states.map((s) => s.builderId).filter(Boolean) : builders
        return [...new Set(ids ?? [])].map((id) => supplierName(id as string)).join(" · ") || "협력사"
      }
      default:
        return null
    }
  }
  const confirmationView = (code: string, hullId: string | null) => {
    const c = confirmationOf(code, hullId)
    if (!c) return null
    const name = (id: string) => w.employee.get(id)?.name ?? id
    return {
      answer: c.answer,
      by: name(c.employee_id),
      at: c.at,
      edited_days: c.edited_days ?? null,
      reason: c.reason ?? null,
      // 주관자가 대신 입력했으면 "주관자 입력 · 김OO 발언"
      enteredBy: c.entered_by === "chair" ? ("chair" as const) : ("self" as const),
      spokenBy: c.spoken_by ? name(c.spoken_by) : null,
    }
  }
  const tasks: TaskResult[] = []
  for (const [code, t] of globals) {
    const s = sched.get(code)!
    tasks.push({
      taskCode: code,
      when: t.when_code ?? null,
      label: t.label_ko,
      role: t.owner_role,
      roleLabel: w.label("role", t.owner_role),
      counterpart: counterpartOf(t, null),
        counterpartKind: t.counterpart_kind ?? null,
      hullId: null,
      start: s.start,
      finish: s.finish,
      days: s.days,
      durationSource: s.source,
      certainty: s.certainty,
      owner: ownerFor(w, t.owner_role, { partIds, materialIds: materialIdsFor(t), blockIds: allBlocks, builderIds: builders }, day0),
      latestFinish: null,
      slack: null,
      flag: null,
      confirmation: confirmationView(code, null),
    })
  }
  for (const a of active) {
    const x = work.get(a.hull.hull_id)!
    if (!x.start || !x.finish) continue
    const blocks = [...new Set(a.states.map((s) => s.blockId))]
    if (fieldTpl)
      tasks.push({
        taskCode: fieldTpl.task_code,
        when: fieldTpl.when_code ?? null,
        label: `${fieldTpl.label_ko} · ${a.hull.hull_seq}호선`,
        role: fieldTpl.owner_role,
        roleLabel: w.label("role", fieldTpl.owner_role),
        counterpart: counterpartOf(fieldTpl, a.hull.hull_id),
        counterpartKind: fieldTpl.counterpart_kind ?? null,
        hullId: a.hull.hull_id,
        start: x.start,
        finish: x.finish,
        days: diffDays(x.start, x.finish),
        durationSource: x.source,
        certainty: x.certainty,
        owner: ownerFor(w, fieldTpl.owner_role, { partIds, blockIds: blocks, hullId: a.hull.hull_id }, day0),
        latestFinish: null,
        slack: null,
        flag: null,
        confirmation: confirmationView(fieldTpl.task_code, a.hull.hull_id),
      })
    if (reinspectTpl && x.reinspectDays && a.rep.i + a.ret.i > 0)
      tasks.push({
        taskCode: reinspectTpl.task_code,
        when: reinspectTpl.when_code ?? null,
        label: `${reinspectTpl.label_ko} · ${a.hull.hull_seq}호선`,
        role: reinspectTpl.owner_role,
        roleLabel: w.label("role", reinspectTpl.owner_role),
        counterpart: counterpartOf(reinspectTpl, a.hull.hull_id),
        counterpartKind: reinspectTpl.counterpart_kind ?? null,
        hullId: a.hull.hull_id,
        start: x.finish,
        finish: addDays(x.finish, x.reinspectDays),
        days: x.reinspectDays,
        durationSource: durationOf(reinspectTpl, a.hull.hull_id).source,
        certainty: durationOf(reinspectTpl, a.hull.hull_id).certainty,
        owner: ownerFor(w, reinspectTpl.owner_role, { partIds, blockIds: blocks, hullId: a.hull.hull_id }, day0),
        latestFinish: null,
        slack: null,
        flag: null,
        confirmation: confirmationView(reinspectTpl.task_code, a.hull.hull_id),
      })
  }
  // 계약 납기를 넘기면 생기는 일 (선주 협의 · 지체상금 검토)
  if (metrics.overrunSum > 0)
    for (const t of w.templates.filter((x) => x.when_code === "delivery_overrun")) {
      const d = durationOf(t)
      tasks.push({
        taskCode: t.task_code,
        when: t.when_code ?? null,
        label: t.label_ko,
        role: t.owner_role,
        roleLabel: w.label("role", t.owner_role),
        counterpart: counterpartOf(t, null),
        counterpartKind: t.counterpart_kind ?? null,
        hullId: null,
        start: day0,
        finish: addDays(day0, Math.ceil(d.days)),
        days: d.days,
        durationSource: d.source,
        certainty: d.certainty,
        owner: ownerFor(w, t.owner_role, { partIds }, day0),
        latestFinish: null,
        slack: null,
        flag: null,
        confirmation: confirmationView(t.task_code, null),
      })
    }

  // 여유 = 이 일이 며칠 더 늦어도 그 호선이 계약 납기를 지키나 (공정 여유 → 인도 예정일 → 계약 납기 순으로 먹는다).
  // 호선마다 '준비 끝(ready)'에 그 여유를 더한 날이 앞 일들의 기한. 계약 납기를 이미 넘기면 여유가 음수(부족)
  const tight = Number(w.setting("tight_slack_days", "2"))
  const latest = new Map<string, string>()
  const lower = (code: string, day: string) => {
    const cur = latest.get(code)
    if (!cur || day < cur) latest.set(code, day)
  }
  for (const r of hullResults) {
    if (!r.ready || !r.newFinish || !r.latestAllowed) continue
    const hullSlack = Math.max(0, diffDays(r.newFinish, r.latestAllowed)) + diffDays(r.newDelivery, r.contractDate)
    for (const cat of ["replace", "retrofit"] as const) {
      const ready = readyFor(r.hullId, cat)
      for (const p of fieldPreds.filter((p) => applies(p, r.hullId, cat))) lower(p, addDays(ready, hullSlack))
    }
    const field = tasks.find((t) => t.hullId === r.hullId && fieldTpl && t.taskCode === fieldTpl.task_code)
    if (field) field.latestFinish = addDays(field.finish, hullSlack)
    const reinspect = tasks.find((t) => t.hullId === r.hullId && reinspectTpl && t.taskCode === reinspectTpl.task_code)
    if (reinspect) reinspect.latestFinish = addDays(reinspect.finish, hullSlack)
  }
  const order = [...globals.keys()].reverse()
  for (const code of order) {
    const lf = latest.get(code)
    if (!lf) continue
    for (const p of split(globals.get(code)!.predecessors).filter((p) => globals.has(p))) lower(p, addDays(lf, -Math.ceil(sched.get(code)!.days)))
  }
  for (const t of tasks) {
    const lf = t.hullId ? t.latestFinish : (latest.get(t.taskCode) ?? null)
    if (!lf) continue
    t.latestFinish = lf
    t.slack = diffDays(t.finish, lf)
    t.flag = t.slack < 0 ? "short" : t.slack <= tight ? "tight" : "ok"
  }

  return {
    key: spec.key,
    method: spec.method,
    excluded: postDelivery.filter((h) => h.lifecycle_status !== "in_service" && (scopeOf.get(h.hull_id) ?? "in_scope") === "in_scope").map((h) => h.hull_id),
    hulls: hullResults,
    cost: { lines, total, ownerShare, yardShare: total - ownerShare, ownerPct, payerSource, certainty: weakest(payerCertainty, ...lines.map((l) => l.certainty)) },
    tasks,
    metrics,
    needsClass: physical && needsClass,
    fallbacks,
  }

  function fixed(h: Row, treatment: HullResult["treatment"], contractDate: string, qty: number): HullResult {
    return {
      hullId: h.hull_id,
      seq: h.hull_seq,
      lifecycle: h.lifecycle_status,
      treatment,
      units: { notStarted: 0, fabricated: 0, installed: treatment === "post_delivery" ? qty : 0, retrofit: 0 },
      partState: { certainty: "confirmed", source: treatment === "post_delivery" ? "인도 후 개조" : "해당 없음" },
      materialFrom: null,
      ready: null,
      needBy: null,
      localDelay: 0,
      plannedFinish: null,
      newFinish: null,
      latestAllowed: null,
      deliveryDelay: 0,
      recovered: 0,
      plannedDelivery: h.planned_delivery_date,
      newDelivery: h.actual_delivery_date ?? h.planned_delivery_date,
      contractDate,
      contractSource: w.contract.get(h.hull_id) ? "계약" : "인도 예정일",
      overrun: 0,
      ldRisk: null,
      certainty: "confirmed",
    }
  }
}
