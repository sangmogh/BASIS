// 서비스 기록 (데이터 계약 ③): 팀 확인 · 위임 · 결정 · 결재 · 재검토 · 갱신하기
//
// 저장: KV 목록 basis:records:<데이터셋>에 { table, row }를 한 줄씩 붙이기만 한다 (자르지 않음 → 결정이 밀려 사라지지 않음)
//       버전 = 줄 수. 화면은 버전만 물어보고 바뀌었으면 다시 읽는다 (같은 화면을 연 사람 모두에게 반영)
// 읽기: 기본키로 접어(같은 키는 나중 줄이 이김) DB 초기값 뒤에 붙인다
//       → 엔진은 DB 초기값 < 저장된 기록 < 요청의 '만약에' 순서로 본다
// 시계 두 개: 업무 날짜(회의일 · 결정일)는 검토의 decisionDay(데이터셋 시계),
//             기록 시각(at · decided_at)은 실제 UTC (순서 · 감사용)
// 권한 (시연: 화면에서 고른 직원 = actor, 실제 운영은 사내 SSO):
//   팀 확인 · 기간 수정 = 그 일의 담당자 (주관자가 대신 입력하면 entered_by = chair, spoken_by = 말한 사람)
//   위임 = 조직표 주관자 · 결정 · 재검토 = 이번 회의 주관자 · 결재 = 결재자(PM) · 갱신하기 = 누구나
import { createHash, randomUUID } from "node:crypto"
import { chairOf, diffReviews, loadOntology, loadTables, loadWorld, ownerFor, reviewChange, teamSummary, type Review, type RunInputs, type Tables, type World } from "./engine/index.js"
import { BadRequest, parseReviewRequest } from "./engine/request.js"
import type { Row } from "./engine/basics.js"
import { listAll, listAppend, listClear, listLength, storageKind } from "./kv.js"

export const ENGINE_VERSION = "engine-2026-11-05"
const MAX_ENTRIES = 20_000

// 기록 표와 기본키 (DB의 서비스 기록 표와 같은 모양)
const PK = {
  task_confirmation: "confirmation_id",
  chair_delegation: "delegation_id",
  assessment_run: "run_id",
  decision_record: "decision_id",
  decision_approval: "approval_id",
  audit_log: "log_id",
  // 변경 등록 (직접 입력): 변경 1건 + 변경 대상 부품 (기본키 두 칸)
  change: "change_id",
  change_affected_part: ["change_id", "part_id"],
} as const satisfies Record<string, string | readonly string[]>
export type RecordTable = keyof typeof PK
const rowKey = (table: RecordTable, row: Row) => {
  const pk = PK[table] as string | readonly string[]
  return typeof pk === "string" ? String(row[pk]) : pk.map((k) => String(row[k])).join("|")
}
export type Entry = { table: RecordTable; row: Row }

export class Forbidden extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}
export class NoStorage extends Error {}

const keyOf = (dataset: string) => `basis:records:${dataset}`
const fail = (msg: string): never => {
  throw new BadRequest(msg)
}

// ── 읽기 · 접기 · 합치기
export async function readRecords(dataset: string): Promise<{ storage: string; version: number; entries: Entry[] }> {
  const storage = storageKind()
  if (storage === "none") return { storage, version: 0, entries: [] }
  const entries = await listAll<Entry>(keyOf(dataset))
  return { storage, version: entries.length, entries }
}

export function foldRecords(entries: Entry[]) {
  const maps = new Map<RecordTable, Map<string, Row>>()
  for (const e of entries) {
    const pk = PK[e.table]
    if (!pk || !e.row) continue
    if (!maps.has(e.table)) maps.set(e.table, new Map())
    maps.get(e.table)!.set(rowKey(e.table, e.row), e.row)
  }
  const rows = Object.fromEntries([...maps].map(([t, m]) => [t, [...m.values()]])) as Partial<Record<RecordTable, Row[]>>
  // 갱신하기: 감사 기록의 apply_event (이벤트 표 자체는 시스템이 준 그대로 둔다)
  const appliedEvents = [...new Set((rows.audit_log ?? []).filter((r) => r.action === "apply_event").map((r) => r.target_key as string))]
  return { rows, appliedEvents }
}

export function withRecords(tables: Tables, rows: Partial<Record<RecordTable, Row[]>>): Tables {
  const merged: Tables = { ...tables }
  for (const [table, list] of Object.entries(rows) as [RecordTable, Row[]][]) {
    const m = new Map((tables[table] ?? []).map((r) => [rowKey(table, r), r]))
    for (const r of list) m.set(rowKey(table, r), r)
    merged[table] = [...m.values()]
  }
  return merged
}

// 데이터셋 + 저장된 기록. 저장소를 못 읽어도 검토는 DB 초기값으로 계속한다 (recordsError에 적음)
export async function loadDataset(dataset: string) {
  const tables = await loadTables(dataset)
  let stored: { storage: string; version: number; entries: Entry[] } = { storage: storageKind(), version: 0, entries: [] }
  let recordsError: string | null = null
  try {
    stored = await readRecords(dataset)
  } catch (error) {
    recordsError = `저장된 기록을 읽지 못해 DB 초기값으로 보여요 (${error instanceof Error ? error.message : error})`
  }
  const folded = foldRecords(stored.entries)
  const merged = withRecords(tables, folded.rows)
  return {
    dataset,
    entries: stored.entries,
    records: { storage: stored.storage, version: stored.version, error: recordsError },
    appliedEvents: folded.appliedEvents,
    // 갱신하기로 반영한 이벤트(저장됨) + 요청의 '만약에' 이벤트
    world: (extraEvents: string[] = []) => loadWorld(merged, { appliedEvents: [...new Set([...folded.appliedEvents, ...extraEvents])] }),
  }
}

export async function clearRecords(dataset: string) {
  if (storageKind() === "none") throw new NoStorage("서버 저장소(KV)가 연결되지 않아 기록이 없어요")
  await listClear(keyOf(dataset))
}

export async function recordsVersion(dataset: string) {
  return storageKind() === "none" ? 0 : listLength(keyOf(dataset))
}

// ── 쓰기 (POST /api/records)
const ID = /^[A-Za-z0-9_-]{1,60}$/
const id = (v: unknown, what: string) => (typeof v === "string" && ID.test(v) ? v : fail(`${what}이(가) 필요해요`))
const optId = (v: unknown, what: string) => (v == null || v === "" ? null : id(v, what))
const line = (v: unknown, max = 300) => (v == null || v === "" ? null : typeof v === "string" && v.length <= max ? v.trim() || null : fail("글자가 너무 길거나 형식이 틀려요"))
const uid = () => randomUUID().replace(/-/g, "").slice(0, 10)
const ACTIONS = ["confirm", "delegate", "decide", "approve", "reopen", "apply_events", "register"] as const
type Action = (typeof ACTIONS)[number]

type Ctx = { w: World; actor: Row; now: string; body: Record<string, unknown>; review: (change: string, extra?: Parameters<typeof reviewChange>[2]) => Review; takenIds: Set<string> }
type Result = { change: string | null; entries: Entry[] }

const audit = (ctx: Ctx, action: string, table: string, key: string, detail: unknown): Entry => ({
  table: "audit_log",
  row: { log_id: `LOG-${uid()}`, at: ctx.now, employee_id: ctx.actor.employee_id, action, target_table: table, target_key: key, detail_json: JSON.stringify(detail) },
})
const nameOf = (w: World, empId: string | null | undefined) => (empId ? (w.employee.get(empId)?.name ?? empId) : "담당자 없음")

// 팀 확인: 가능 / 안 돼요 (+ 고친 기간 · 이유). 담당자 본인, 또는 주관자가 대신 입력(말한 사람 기록)
function confirm(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const change = id(body.change, "change")
  const r = ctx.review(change)
  const taskCode = id(body.task_code, "task_code")
  const hullId = optId(body.hull_id, "hull_id")
  const task = [r.tasks, ...r.options.map((o) => o.tasks)].flat().find((t) => t.taskCode === taskCode && (t.hullId ?? null) === hullId)
  if (!task) throw new NotFound(`이 변경에 그 할 일이 없어요: ${taskCode}${hullId ? ` (${hullId})` : ""}`)
  const answer = body.answer === "ok" || body.answer === "not_ok" ? body.answer : fail("answer는 ok(가능) · not_ok(안 돼요) 중 하나예요")
  const reason = line(body.reason)
  if (answer === "not_ok" && !reason) fail("안 되면 이유를 한 줄 써 주세요")
  const editedDays = answer === "not_ok" && body.edited_days != null ? Number(body.edited_days) : null
  if (editedDays != null && !(Number.isFinite(editedDays) && editedDays >= 0 && editedDays <= 365)) fail("고친 기간은 0~365일이에요")
  const owner = task.owner.employeeId
  const chair = r.summary.chair.employeeId
  let enteredBy: "self" | "chair"
  if (owner && actor.employee_id === owner) enteredBy = "self"
  else if (chair && actor.employee_id === chair) enteredBy = "chair"
  else throw new Forbidden(`이 할 일은 담당자(${task.owner.name})나 이번 회의 주관자(${r.summary.chair.name})만 확인할 수 있어요`)
  const spokenBy = enteredBy === "chair" ? (optId(body.spoken_by, "spoken_by") ?? owner) : null
  if (spokenBy && !w.employee.has(spokenBy)) fail(`말한 사람이 직원 목록에 없어요: ${spokenBy}`)
  const row: Row = {
    confirmation_id: `TC-${uid()}`,
    change_id: change,
    task_code: taskCode,
    hull_id: hullId,
    employee_id: owner ?? actor.employee_id,
    answer,
    edited_days: editedDays,
    reason,
    memo: line(body.memo),
    entered_by: enteredBy,
    spoken_by: spokenBy,
    at: ctx.now,
  }
  return { change, entries: [{ table: "task_confirmation", row }, audit(ctx, "confirm", "task_confirmation", row.confirmation_id, { task: task.label, answer, editedDays })] }
}

// 이번 회의만 주관자 위임 (조직표 주관자가 한다. 자기에게 다시 맡기면 위임 취소)
function delegate(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const change = id(body.change, "change")
  const r = ctx.review(change)
  const chair = chairOf(w, r.decisionDay)
  if (actor.employee_id !== chair.employeeId) throw new Forbidden(`위임은 조직표의 주관자(${chair.name})만 할 수 있어요`)
  const to = id(body.to, "to(맡을 직원)")
  if (!w.employee.get(to)?.active) fail(`맡을 직원이 없거나 재직 중이 아니에요: ${to}`)
  const row: Row = { delegation_id: `DG-${uid()}`, change_id: change, from_employee_id: actor.employee_id, to_employee_id: to, meeting_date: r.decisionDay, reason: line(body.reason), at: ctx.now }
  return { change, entries: [{ table: "chair_delegation", row }, audit(ctx, "delegate", "chair_delegation", row.delegation_id, { to: nameOf(w, to) })] }
}

// 결정: 서버가 같은 입력으로 다시 계산해서 기록한다 (화면이 보낸 숫자를 믿지 않는다)
function decide(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const change = id(body.change, "change")
  const what = parseReviewRequest({ dataset: "x", change, priority: body.priority, conditions: body.conditions, decide: body.decide })
  const r = ctx.review(change, { decisionDay: what.decide, priority: what.priority, conditions: what.conditions })
  if (r.decision) throw new Conflict(`이미 결정했어요: ${r.decision.label} (재검토하면 다시 정할 수 있어요)`)
  const chair = r.summary.chair
  if (actor.employee_id !== chair.employeeId) throw new Forbidden(`결정은 이번 회의 주관자(${chair.name})만 할 수 있어요`)
  if (r.designOnly) throw new Conflict("도면만 바뀌는 변경이라 고를 안이 없어요")
  const optionKey = id(body.option, "option(고른 안)")
  const opt = r.options.find((o) => o.key === optionKey) ?? fail(`고를 수 있는 안: ${r.options.map((o) => `${o.key}(${o.label})`).join(", ")}`)
  let rationale = line(body.rationale, 500)
  if (!rationale && opt.key !== r.recommended?.key) fail("추천안과 다른 안을 고르면 이유를 한 줄 써 주세요")
  rationale ??= r.recommended?.reasons.join(" / ") ?? null
  const startHull = [...opt.hulls].filter((h) => !["post_delivery", "not_applicable"].includes(h.treatment)).sort((a, b) => a.seq - b.seq)[0]?.hullId ?? null
  const inputs: RunInputs = { option: opt.key, priority: what.priority, conditions: what.conditions, decisionDay: r.decisionDay, events: r.applied }
  const run: Row = {
    run_id: `RUN-${uid()}`,
    change_id: change,
    as_of: r.decisionDay,
    created_at: ctx.now,
    engine_version: ENGINE_VERSION,
    input_fingerprint: createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16),
    note: JSON.stringify(inputs),
  }
  const team = teamSummary(opt.tasks)
  const snapshot = {
    teams: team,
    notOk: opt.tasks.filter((t) => t.confirmation?.answer === "not_ok").map((t) => ({ task: t.label, owner: t.owner.name, editedDays: t.confirmation!.edited_days, reason: t.confirmation!.reason })),
    unconfirmed: opt.tasks.filter((t) => !t.confirmation).map((t) => ({ task: t.label, owner: t.owner.name })),
  }
  const decision: Row = {
    decision_id: `DEC-${uid()}`,
    change_id: change,
    run_id: run.run_id,
    method: opt.method,
    start_hull_id: startHull,
    priority_snapshot: JSON.stringify(r.priority.order),
    confirmation_snapshot: JSON.stringify(snapshot),
    rationale,
    decided_by: actor.employee_id,
    delegated_from: chair.delegatedFromId,
    decided_at: ctx.now,
    state: opt.approval.needed ? "approval_pending" : "decided",
  }
  // 계약관리 결재 (HD 기준, 선주 · 비용 창구): 조건마다 1건, 결재자는 시리즈 계약관리 담당 (조직표) → 없으면 계약관리 부서장
  const pm = ownerFor(w, "pm", { hullId: null }, r.decisionDay)
  const approvals: Entry[] = opt.approval.triggers.map((t) => ({
    table: "decision_approval",
    row: { approval_id: `APR-${uid()}-${t.code}`, decision_id: decision.decision_id, approver_id: pm.employeeId, trigger_code: t.code, state: "pending", at: null, comment: null },
  }))
  return {
    change,
    entries: [
      { table: "assessment_run", row: run },
      { table: "decision_record", row: decision },
      ...approvals,
      audit(ctx, "decide", "decision_record", decision.decision_id, { option: opt.label, approvals: opt.approval.triggers.map((t) => t.label) }),
    ],
  }
}

// 계약관리 결재: 승인 / 반려 (반려하면 재검토로 돌아간다, 모두 승인하면 결재 완료)
function approve(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const approvalId = id(body.approval_id, "approval_id")
  const a = w.seed.approvals.find((x) => x.approval_id === approvalId)
  if (!a) throw new NotFound(`결재가 없어요: ${approvalId}`)
  const d = w.seed.decisions.find((x) => x.decision_id === a.decision_id)
  if (!d || d.state === "reopened") throw new Conflict("재검토로 돌아간 결정이라 결재할 수 없어요")
  if (a.state !== "pending") throw new Conflict(`이미 처리한 결재예요 (${a.state})`)
  if (actor.employee_id !== a.approver_id) throw new Forbidden(`이 결재는 ${nameOf(w, a.approver_id)}만 할 수 있어요`)
  const answer = body.answer === "approved" || body.answer === "rejected" ? body.answer : fail("answer는 approved(승인) · rejected(반려) 중 하나예요")
  const comment = line(body.comment)
  if (answer === "rejected" && !comment) fail("반려하면 이유를 한 줄 써 주세요")
  const updated: Row = { ...a, state: answer, at: ctx.now, comment }
  const others = w.seed.approvals.filter((x) => x.decision_id === a.decision_id && x.approval_id !== approvalId)
  const entries: Entry[] = [{ table: "decision_approval", row: updated }]
  if (answer === "rejected") entries.push({ table: "decision_record", row: { ...d, state: "reopened" } })
  else if (others.every((x) => x.state === "approved")) entries.push({ table: "decision_record", row: { ...d, state: "approved" } })
  entries.push(audit(ctx, answer === "approved" ? "approve" : "reject", "decision_approval", approvalId, { trigger: a.trigger_code, comment }))
  return { change: d.change_id as string, entries }
}

// 재검토: 결정을 되돌려 다시 검토 화면으로 (이번 회의 주관자)
function reopen(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const change = id(body.change, "change")
  const r = ctx.review(change)
  if (!r.decision) throw new Conflict("지금 결정된 상태가 아니에요")
  if (actor.employee_id !== r.summary.chair.employeeId) throw new Forbidden(`재검토는 이번 회의 주관자(${r.summary.chair.name})만 할 수 있어요`)
  const reason = line(body.reason) ?? fail("재검토하는 이유를 한 줄 써 주세요")
  const d = w.seed.decisions.find((x) => x.decision_id === r.decision!.id)!
  return { change, entries: [{ table: "decision_record", row: { ...d, state: "reopened" } }, audit(ctx, "reopen", "decision_record", d.decision_id, { reason })] }
}

// 갱신하기: 새 소식(시스템 이벤트)을 반영 — 데이터셋 전체에 반영돼서 모든 화면이 같이 본다
function applyEvents(ctx: Ctx): Result {
  const { w, body } = ctx
  const list = Array.isArray(body.events) ? body.events : fail("events(반영할 새 소식 목록)가 필요해요")
  if (!list.length || list.length > 50) fail("새 소식은 1~50건이에요")
  const ids = list.map((e) => id(e, "이벤트"))
  const known = new Set(w.events.map((e) => e.event_id as string))
  const unknown = ids.filter((e) => !known.has(e))
  if (unknown.length) throw new NotFound(`모르는 이벤트: ${unknown.join(", ")}`)
  const pending = new Set(w.pendingEvents.map((e) => e.event_id as string))
  const fresh = ids.filter((e) => pending.has(e))
  return { change: optId(body.change, "change"), entries: fresh.map((e) => audit(ctx, "apply_event", "event", e, { note: w.events.find((x) => x.event_id === e)?.note_ko ?? null })) }
}

// 변경 등록 (직접 입력, 기능명세 2장): 부품 · 바꾸기 전 · 후 사양 · 사유 · 요청자 · 원문만 받는다. 직원 누구나
//   블록 · 호선 · 상태는 엔진이 부품의 호선별 위치로 찾는다 (등록 즉시 분석). 자재 · 견적 · 설계안은 연동 시스템이 나중에 준다
//   업무 시각(received_at · known_at)은 데이터셋 시계(as_of)여야 엔진에 보인다. 실제 등록 시각은 감사 기록(at)
//   번호: 데이터셋의 변경 번호 꼴(예: DC-021)을 따라 DB 전체(아직 안 알려진 것 포함) · 저장 기록에 없는 다음 번호
function register(ctx: Ctx): Result {
  const { w, body, actor } = ctx
  const parts = Array.isArray(body.parts) ? [...new Set(body.parts.map((p) => id(p, "부품")))] : []
  if (!parts.length || parts.length > 20) fail("변경 대상 부품을 1~20개 골라 주세요")
  for (const p of parts) if (!w.part.has(p)) throw new NotFound(`부품이 없어요: ${p}`)
  const specAfter = line(body.spec_after, 200) ?? fail("바꾼 뒤 사양을 써 주세요")
  const specBefore = line(body.spec_before, 200)
  const reason = typeof body.reason === "string" && w.label("reason", body.reason) !== body.reason ? body.reason : fail("사유 코드가 맞지 않아요")
  const original = line(body.original_text, 2000) ?? fail("원문을 써 주세요")
  const kind = body.requester_kind === "counterparty" ? "counterparty" : "employee"
  const requester = kind === "counterparty" ? id(body.requester_id, "요청자") : (actor.employee_id as string)
  if (kind === "counterparty" && !w.counterparty.has(requester)) throw new NotFound(`요청자(회사 밖 상대)가 없어요: ${requester}`)
  // 번호
  const nums = [...ctx.takenIds].map((x) => /^([A-Z]+-)(\d+)$/.exec(x)).filter((m): m is RegExpExecArray => !!m)
  const counts = new Map<string, number>()
  for (const m of nums) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "DC-"
  const width = nums.find((m) => m[1] === prefix)?.[2].length ?? 3
  let n = Math.max(0, ...nums.filter((m) => m[1] === prefix).map((m) => Number(m[2]))) + 1
  while (ctx.takenIds.has(`${prefix}${String(n).padStart(width, "0")}`)) n++
  const change = `${prefix}${String(n).padStart(width, "0")}`
  // 구역: 부품이 놓인 블록의 구역 중 가장 많은 것
  const occ = parts.flatMap((p) => w.occurrencesOfPart.get(p) ?? [])
  const zones = new Map<string, number>()
  for (const o of occ) {
    const z = w.block.get(o.block_id)?.zone_code as string | undefined
    if (z) zones.set(z, (zones.get(z) ?? 0) + 1)
  }
  const zone = [...zones].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const first = w.part.get(parts[0])!
  const title = line(body.title, 120) ?? `${first.name_ko}${parts.length > 1 ? ` 외 ${parts.length - 1}건` : ""} 사양 변경`
  const at = w.asOf
  const prov = { source_system: "BASIS", certainty: "provisional", known_at: at, synthetic: 0 }
  const mandatory = reason === "class_rule"
  const entries: Entry[] = [
    {
      table: "change",
      row: {
        change_id: change,
        series_id: w.series?.series_id ?? null,
        ecr_code: null,
        title,
        reason,
        change_types: "[]",
        mandatory: mandatory ? 1 : 0,
        post_delivery_allowed: mandatory ? 0 : 1,
        source: "manual",
        requested_by_kind: kind,
        requested_by_id: requester,
        registered_by: actor.employee_id,
        received_at: at,
        detected_hull_id: null,
        zone_code: zone,
        drawing_no: null,
        revision_before: null,
        revision_after: null,
        spec_before: specBefore,
        spec_after: specAfter,
        original_text: original,
        status: "reviewing",
        ...prov,
      },
    },
    ...parts.map((p): Entry => {
      const base = (w.occurrencesOfPart.get(p) ?? [])[0]?.baseline_revision_id ?? [...w.revision.values()].find((r) => r.part_id === p)?.revision_id ?? null
      return { table: "change_affected_part", row: { change_id: change, part_id: p, revision_before: base, revision_after: null, qty_change: 0, applies_from_hull: null, ...prov } }
    }),
  ]
  entries.push(audit(ctx, "register_change", "change", change, { parts, reason, requester: `${kind}:${requester}` }))
  return { change, entries }
}

const HANDLERS: Record<Action, (ctx: Ctx) => Result> = { confirm, delegate, decide, approve, reopen, apply_events: applyEvents, register }

// 등록 화면 재료: 부품(종류 · 구역 · 지금 사양) · 사유 · 요청자(회사 밖 상대 중 선주 · 선급, 아니면 사내 = 등록자)
export async function changeFormOptions(dataset: string) {
  const tables = await loadTables(dataset)
  const w = (await loadDataset(dataset)).world()
  const zoneOf = (partId: string) => {
    const z = new Map<string, number>()
    for (const o of w.occurrencesOfPart.get(partId) ?? []) {
      const code = w.block.get(o.block_id)?.zone_code as string | undefined
      if (code) z.set(code, (z.get(code) ?? 0) + 1)
    }
    const code = [...z].sort((a, b) => b[1] - a[1])[0]?.[0]
    return code ? ((w.zone.get(code)?.name_ko as string | undefined) ?? code) : null
  }
  const specOf = (partId: string) => {
    const rev = (w.occurrencesOfPart.get(partId) ?? [])[0]?.baseline_revision_id
    return ((rev ? w.revision.get(rev)?.spec_text : null) as string | null | undefined) ?? null
  }
  return {
    parts: [...w.part.values()].map((p) => ({
      id: p.part_id as string,
      name: p.name_ko as string,
      kind: p.part_kind as string,
      kindLabel: w.label("part_kind", p.part_kind),
      zone: zoneOf(p.part_id),
      places: (w.occurrencesOfPart.get(p.part_id) ?? []).length,
      spec: specOf(p.part_id),
    })),
    reasons: (tables.code ?? [])
      .filter((c) => c.code_type === "reason")
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((c) => ({ code: c.code as string, label: c.label_ko as string })),
    requesters: [...w.counterparty.values()]
      .filter((c) => c.kind === "owner" || c.kind === "class")
      .map((c) => ({ kind: "counterparty" as const, id: c.counterparty_id as string, name: c.name as string, kindLabel: w.label("counterparty_kind", c.kind) })),
  }
}

export async function writeRecord(raw: unknown) {
  if (!raw || typeof raw !== "object") fail("요청 형식이 아니에요")
  const body = raw as Record<string, unknown>
  const dataset = typeof body.dataset === "string" && /^[a-z0-9_-]{1,40}$/i.test(body.dataset) ? body.dataset : fail("dataset이 필요해요")
  const action = (ACTIONS as readonly string[]).includes(body.action as string) ? (body.action as Action) : fail(`action은 ${ACTIONS.join(" · ")} 중 하나예요`)
  if (storageKind() === "none") throw new NoStorage("서버 저장소(KV)가 연결되지 않아 기록할 수 없어요")
  let ds
  try {
    ds = await loadDataset(dataset)
  } catch {
    throw new NotFound(`데이터셋이 없어요: ${dataset}`)
  }
  if (ds.records.error) throw new Error(ds.records.error)
  const ontology = loadOntology(dataset)
  const w = ds.world()
  const actorId = id(body.actor, "actor(누가 하는지, 직원 ID)")
  const actor = w.employee.get(actorId)
  if (!actor || !actor.active) throw new Forbidden(`직원 목록에 없거나 재직 중이 아니에요: ${actorId}`)
  const cache = new Map<string, Review>()
  const review = (change: string, extra: Parameters<typeof reviewChange>[2] = {}) => {
    if (!w.change.has(change)) throw new NotFound(`변경이 없거나 아직 알려지지 않았어요: ${change}`)
    if (Object.keys(extra).length) return reviewChange(w, change, { ...extra, ontology })
    if (!cache.has(change)) cache.set(change, reviewChange(w, change, { ontology }))
    return cache.get(change)!
  }
  const allTables = await loadTables(dataset) // 아직 안 알려진(as_of 뒤) 변경 번호까지
  const takenIds = new Set([...(allTables.change ?? []).map((c) => String(c.change_id)), ...ds.entries.filter((e) => e.table === "change").map((e) => String(e.row.change_id))])
  const ctx: Ctx = { w, actor, now: new Date().toISOString(), body, review, takenIds }
  const result = HANDLERS[action](ctx)
  const before = result.change && w.change.has(result.change) ? review(result.change) : null
  if (ds.records.version + result.entries.length > MAX_ENTRIES) throw new Conflict("기록이 너무 많아요. 초기화(DELETE /api/records) 후 다시 해 주세요")
  const version = result.entries.length ? await listAppend(keyOf(dataset), result.entries) : ds.records.version
  // 쓴 뒤 다시 계산 → '달라진 것' (같은 요청 안에서 서버가 비교)
  const merged = withRecords(await loadTables(dataset), foldRecords([...ds.entries, ...result.entries]).rows)
  const applied = foldRecords([...ds.entries, ...result.entries]).appliedEvents
  const w2 = loadWorld(merged, { appliedEvents: applied })
  const after = result.change && w2.change.has(result.change) ? reviewChange(w2, result.change, { ontology }) : null
  return {
    ok: true,
    change: result.change,
    version,
    written: result.entries,
    review: after,
    changes: before && after ? diffReviews(before, after) : [],
  }
}
