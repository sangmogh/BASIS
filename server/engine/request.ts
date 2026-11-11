// /api/review 요청 확인: 화면 · 다른 시스템이 보내는 값을 엔진 입력으로 (형식이 틀리면 한국어 오류)
import type { Conditions, Confirmation } from "./simulate.js"

export type ReviewState = { events: string[]; decide?: string; priority?: string[]; conditions?: Conditions; confirmations?: Confirmation[] }
export type ReviewRequest = ReviewState & { dataset: string; change: string; before?: ReviewState }

export class BadRequest extends Error {}
const fail = (msg: string): never => {
  throw new BadRequest(msg)
}
const ID = /^[A-Za-z0-9_-]{1,60}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const CRITERIA = ["schedule", "cost", "production_disruption", "quality"]
const days = (v: unknown, what: string) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 365 ? v : fail(`${what}은 0~365 사이 숫자여야 해요`))
const text = (v: unknown, max = 300) => (v == null ? null : typeof v === "string" && v.length <= max ? v : fail("글자가 너무 길거나 형식이 틀려요"))

function parseState(raw: Record<string, unknown>): ReviewState {
  const list = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : typeof v === "string" ? v.split(",").filter(Boolean) : fail("목록 형식이 아니에요"))
  const events = list(raw.events).map((e) => (typeof e === "string" && ID.test(e) ? e : fail(`이벤트 이름이 맞지 않아요: ${e}`)))
  if (events.length > 50) fail("이벤트가 너무 많아요")
  const decide = raw.decide == null ? undefined : typeof raw.decide === "string" && DAY.test(raw.decide) ? raw.decide : fail("decide는 YYYY-MM-DD 형식이에요")
  const priority = raw.priority == null ? undefined : list(raw.priority).map((c) => (typeof c === "string" && CRITERIA.includes(c) ? c : fail(`우선순위 기준은 ${CRITERIA.join(" · ")} 중 하나예요`)))
  if (priority && new Set(priority).size !== priority.length) fail("우선순위 기준이 겹쳐요")
  let conditions: Conditions | undefined
  if (raw.conditions != null) {
    const c = raw.conditions as Record<string, unknown>
    if (typeof c !== "object") fail("conditions 형식이 아니에요")
    conditions = {}
    if (c.leadDays != null) {
      const ld = c.leadDays as Record<string, unknown>
      conditions.leadDays = {}
      for (const [k, v] of Object.entries(ld)) {
        if (!["normal", "expedite", "retrofit"].includes(k)) fail(`조달 경로는 normal · expedite · retrofit 중 하나예요: ${k}`)
        conditions.leadDays[k as "normal"] = days(v, "조달 기간")
      }
    }
    if (c.taskDays != null) {
      const entries = Object.entries(c.taskDays as Record<string, unknown>)
      if (entries.length > 50) fail("바꿀 할 일이 너무 많아요")
      conditions.taskDays = Object.fromEntries(entries.map(([k, v]) => [ID.test(k) ? k : fail(`할 일 코드가 맞지 않아요: ${k}`), days(v, "할 일 기간")]))
    }
    if (c.startHullSeq != null) conditions.startHullSeq = Number.isInteger(c.startHullSeq) && (c.startHullSeq as number) >= 1 && (c.startHullSeq as number) <= 500 ? (c.startHullSeq as number) : fail("적용 시작 호선 순번이 맞지 않아요")
  }
  let confirmations: Confirmation[] | undefined
  if (raw.confirmations != null) {
    if (!Array.isArray(raw.confirmations) || raw.confirmations.length > 300) fail("팀 확인은 300건 이하 목록이에요")
    confirmations = (raw.confirmations as Record<string, unknown>[]).map((c) => ({
      task_code: typeof c.task_code === "string" && ID.test(c.task_code) ? c.task_code : fail("팀 확인의 할 일 코드가 맞지 않아요"),
      hull_id: c.hull_id == null ? null : typeof c.hull_id === "string" && ID.test(c.hull_id) ? c.hull_id : fail("팀 확인의 호선이 맞지 않아요"),
      employee_id: typeof c.employee_id === "string" && ID.test(c.employee_id) ? c.employee_id : fail("팀 확인의 직원이 맞지 않아요"),
      answer: c.answer === "ok" || c.answer === "not_ok" ? c.answer : fail("팀 확인은 ok · not_ok 중 하나예요"),
      edited_days: c.edited_days == null ? null : days(c.edited_days, "고친 기간"),
      reason: text(c.reason),
      memo: text(c.memo),
      entered_by: c.entered_by === "chair" ? "chair" : "self",
      spoken_by: c.spoken_by == null ? null : typeof c.spoken_by === "string" && ID.test(c.spoken_by) ? c.spoken_by : fail("말한 사람이 맞지 않아요"),
      at: typeof c.at === "string" && c.at.length <= 40 ? c.at : fail("팀 확인 시각이 맞지 않아요"),
    }))
  }
  return { events, decide, priority, conditions, confirmations }
}

export function parseReviewRequest(raw: unknown): ReviewRequest {
  if (!raw || typeof raw !== "object") fail("요청 형식이 아니에요")
  const r = raw as Record<string, unknown>
  const dataset = typeof r.dataset === "string" && /^[a-z0-9_-]{1,40}$/i.test(r.dataset) ? r.dataset : fail("dataset이 필요해요")
  const change = typeof r.change === "string" && ID.test(r.change) ? r.change : fail("change가 필요해요")
  return { dataset, change, ...parseState(r), before: r.before == null ? undefined : parseState(r.before as Record<string, unknown>) }
}

export function fromQuery(params: URLSearchParams) {
  return Object.fromEntries([...params.keys()].map((k) => [k, params.get(k)]))
}
