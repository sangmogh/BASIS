// 대시보드 전체가 같이 보는 상태: 설계변경, 회의 결정, 진행 보드, 호선 인도일, 변경 이력, 지연 경고, 쌓인 실적 · 사례.
// 새로고침해도 남도록 브라우저에 저장한다. 주소에 ?reset을 붙이면 처음 데이터로 돌아간다.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { type Analysis, ruleAnalysis } from "./ai/analysis"
import { type Opinion, type OpinionInput, opinionKey } from "./ai/opinion"
import { type SummaryInput, summaryFacts } from "./ai/summary"
import { roomName, useRoomSync } from "./sync"
import { aiCacheData, benchmarkData, caseData, changeData, plmEventData, projectData, seriesData, syncEventData } from "./data"
import { DATA_ANCHOR, clockToday, shiftDates } from "./data/clock"
import type { Actual, CaseRecord, Change, Criterion, Decision, InboxEvent, Method, Series, SyncEvent } from "./data/types"
import {
  type Context,
  type DeadlineShift,
  type Evidence,
  type SimOptions,
  type Task,
  type TeamId,
  addDays,
  applySync,
  benchmarksOf,
  caseFromDecision,
  classifyBoundary,
  daysBetween,
  decidedTasks,
  decisionSummary,
  formatShort,
  generateTasks,
  plannedTasks,
  propagate,
  readFeatures,
  review,
  overrunsOf,
  TEAM_INFO,
  withMethod,
  targetRange,
} from "./engine"

export type Draft = {
  target?: string
  prepDays?: number
  overrides: Partial<Record<TeamId, number>>
  excluded: string[]
  method?: Method // 회의에서 고른 대응안 (없으면 추천 안)
  priority?: Criterion[] // 회의에서 바꾼 선주 우선순위 (없으면 프로젝트 기본)
}
export type Alert = { date: string; title: string; lines: string[] }
export type LogEntry = { date: string; text: string }
export type DeadlineAlert = DeadlineShift & { date: string }
// 연동 수신함 · 시연 데이터에서 들어와 아직 반영하지 않은 소식
export type UpdateSource = "inbox" | "demo"
export type Updates = {
  plm: Array<{ change: Change; source: UpdateSource }>
  sync: Array<{ event: SyncEvent; source: UpdateSource }>
  shifts: DeadlineShift[] // 반영하면 바뀔 결정 마감 (미리 보기)
  count: number
}
const INBOX_POLL_MS = 15000
// 생산 할 일의 3단 검증(PLM 요구 도면 · MES 작업지시 · MES 실적이 v2인가)과 증빙 파일 (기능명세 2-2-h). 파일은 이름 · 크기만 기록
export type Verification = { checks: boolean[]; evidence?: { name: string; size: number } }
export const VERIFY_ITEMS = ["PLM 요구 도면이 v2예요", "MES 작업지시가 v2예요", "MES 실적이 v2예요"]

type State = {
  series: Series
  changes: Change[]
  drafts: Record<string, Draft>
  logs: Record<string, LogEntry[]>
  alerts: Record<string, Alert[]>
  actuals: Actual[] // 진행 보드에서 완료하며 적은 실제 일수 → 실적 기준값
  learned: CaseRecord[] // 할 일이 모두 끝나 사례가 된 설계변경 → 사례 목록 · 사례 찾기
  synced: string[] // 받은 ERP · MES 갱신 id
  deadlineAlerts: DeadlineAlert[] // "결정 마감일이 바뀌었어요" (목록 위에 표시, 닫으면 지움)
  verifications: Record<string, Record<string, Verification>> // 변경 → 할 일 → 3단 검증 · 증빙
  analyses: Record<string, Analysis> // AI ①②③ 결과 (미리 계산한 것 + 회의 중 새로 받은 것)
  opinions: Record<string, Opinion> // AI 대안 검토 의견 (같은 입력이면 다시 부르지 않음, 열쇠 = opinionKey)
}

const STORAGE_KEY = "basis-state-v4" // v4: 10척 시연 데이터 (v3 = 5척)
// 저장된 상태가 지금 데이터셋 것인지: 호선 목록이 같아야 한다 (다른 데이터셋의 저장분 · 공유 방은 버리고 처음 데이터로)
const DATASET_VESSELS = seriesData.vessels.map((v) => v.id).join(",")
const sameDataset = (s: Partial<State> | null | undefined) =>
  Array.isArray(s?.series?.vessels) && s!.series!.vessels.map((v) => v.id).join(",") === DATASET_VESSELS

function initialState(): State {
  const logs: Record<string, LogEntry[]> = {}
  live.changes.forEach((c) => {
    logs[c.code] = [{ date: c.receivedOn, text: c.auto ? `등록 · PLM ${c.ecr} 이벤트로 자동 등록` : "등록 · 설계변경 등록" }]
    if (c.decision)
      logs[c.code].push({
        date: c.decision.decidedOn,
        text: `결정 · 회의: ${formatShort(addDays(c.decision.target, -c.decision.prepDays))} 배포로 결정, ${c.decision.baseline} 기준선 채택`,
      })
    if (c.status === "withdrawn") logs[c.code].push({ date: c.receivedOn, text: "철회 · 설계팀 철회" })
  })
  // 처음부터 결정돼 있던 변경도 결정 당시 기준값(사례 실적)으로 고정한다
  const changes = live.changes.map((c) => (c.decision && !c.decision.benchmarks ? { ...c, decision: { ...c.decision, benchmarks: benchmarkData } } : c))
  return {
    series: live.series,
    changes,
    drafts: {},
    logs,
    alerts: {},
    actuals: [],
    learned: [],
    synced: [],
    deadlineAlerts: [],
    verifications: {},
    analyses: { ...live.ai },
    opinions: {},
  }
}

// 주소의 ?room=이름(공유 방) · ?reset(처음 데이터로) · ?today=YYYY-MM-DD(날짜 고정)는 처음 불러올 때 한 번 읽는다
const boot = (() => {
  try {
    const params = new URLSearchParams(window.location.search)
    const pinned = params.get("today")
    const today = clockToday(pinned)
    return { room: roomName(params.get("room")), reset: params.has("reset"), today, pinned: pinned === today ? pinned : null }
  } catch {
    return { room: null, reset: false, today: clockToday(), pinned: null }
  }
})()

// 시연 시계: 합성 데이터(10/28 기준)를 오늘에 맞춰 옮긴다. 마감 D-n · 빨간 날짜 같은 관계는 그대로
export const TODAY = boot.today
export const DEMO_DAYS = daysBetween(DATA_ANCHOR, TODAY)
const live = {
  series: shiftDates(seriesData, DEMO_DAYS),
  changes: shiftDates(changeData, DEMO_DAYS),
  plm: shiftDates(plmEventData, DEMO_DAYS),
  sync: shiftDates(syncEventData, DEMO_DAYS),
  ai: shiftDates(aiCacheData, DEMO_DAYS),
}

// 공유 방을 연 화면은 방마다 따로 저장한다 (평소 시연 상태와 섞이지 않게)
const storageKey = () => (boot.room ? `${STORAGE_KEY}:room:${boot.room}` : STORAGE_KEY)

// 공유 방에서 받은 상태: 형태가 맞으면 빠진 칸은 처음 값으로 채운다
function acceptRemote(remote: unknown): State | null {
  const r = remote as Partial<State> | null
  if (!r || typeof r !== "object" || !Array.isArray(r.changes) || typeof r.series !== "object") return null
  if (!sameDataset(r)) return null // 다른 데이터셋(예: 5척 시절)의 방 상태는 받지 않는다
  return { ...initialState(), ...r }
}

function loadState(): State {
  try {
    if (boot.reset) {
      localStorage.removeItem(storageKey())
      // ?reset만 지우고 공유 방 · 고정 날짜는 남긴다 (새로고침해도 같은 날짜)
      const keep = new URLSearchParams()
      if (boot.room) keep.set("room", boot.room)
      if (boot.pinned) keep.set("today", boot.pinned)
      window.history.replaceState(null, "", window.location.pathname + (keep.size ? `?${keep}` : ""))
    }
    const saved = localStorage.getItem(storageKey())
    if (saved) {
      // 저장한 날과 오늘이 다르면 그만큼 옮긴다 (공유 방에서 받은 상태는 옮기지 않음: 방의 날짜를 따른다)
      const s = JSON.parse(saved) as Partial<State>
      if (sameDataset(s)) return { ...initialState(), ...shiftDates(s, daysBetween(s.series?.today ?? DATA_ANCHOR, TODAY)) }
      localStorage.removeItem(storageKey())
    }
  } catch {
    // 저장소를 못 쓰면 처음 데이터로 시작
  }
  return initialState()
}

const nextBaseline = (v: string) => `v${Number(v.replace("v", "")) + 1}`
const TEAM_DEPT = (team: Task["team"]) => TEAM_INFO[team].label
const taskLabel = (task: Task) => `${task.name}${task.vessel ? ` (${task.vessel})` : ""}`
// 걸린 일수를 세는 할 일: 착수 · 배포 같은 하루짜리 시점과 기한만 있는 작업지시 변경은 빼고
export const isMeasured = (task: Task, planned: Task = task) => !task.window && planned.start !== planned.end

// 실적 기준값은 사례 실적에 진행 보드의 실제 일수를 더해 계산한다
const contextOf = (s: State): Context => ({ series: s.series, benchmarks: benchmarksOf(caseData, s.actuals), costs: projectData.costs })

// 연동 수신함(/api/events). 못 읽거나 2.5초 안에 답이 없으면 null (화면은 시연 데이터를 쓴다)
async function fetchInbox(): Promise<InboxEvent[] | null> {
  try {
    const response = await fetch("/api/events", { signal: AbortSignal.timeout(2500) })
    if (!response.ok) return null
    const body = (await response.json()) as { events?: InboxEvent[] }
    return Array.isArray(body.events) ? body.events : null
  } catch {
    return null
  }
}

// 들어온 변경의 영향 범위를 코드로 정한다. 설계 안에서 끝나면 회의 없이 알림만
export function classified(change: Change): Change {
  const { boundary } = classifyBoundary(change)
  return { ...change, boundary, status: boundary === "design" ? "notified" : change.status }
}
export const boundaryNote = (change: Change) =>
  `영향 범위: ${change.boundary === "design" ? "설계 안에서 끝남 (알림만)" : "생산·구매까지"} (${classifyBoundary(change).why})`

// 지금 회의 화면에서 고른 대로 결정하면 생기는 일정 · 할 일
function planDecision(s: State, code: string) {
  const change = s.changes.find((c) => c.code === code)
  if (!change) return null
  const c = contextOf(s)
  const draft = s.drafts[code]
  const opts = withMethod(c, change, draftOptions(draft))
  const target = draftTarget(c, change, draft)
  const plan = generateTasks(c, change, target, { ...opts, excluded: draft?.excluded, evidence: evidenceOf(s.analyses[code]) })
  return { change, c, draft, opts, target, plan, baseline: nextBaseline(s.series.baseline) }
}

// 회의 조건: 준비 기간 · 팀별 기간 · 고른 대응안 · 선주 우선순위 (대응안이 없으면 화면이 추천 안을 쓴다 — withMethod)
export function draftOptions(draft?: Draft): SimOptions {
  return { prepDays: draft?.prepDays, overrides: draft?.overrides, method: draft?.method, priority: draft?.priority ?? projectData.priority }
}

// 회의 화면의 목표일: 고른 날이 없으면 검토 결론의 우선 검토안 (보통 빨간 날짜. 조건을 바꿔 못 맞추면 맞출 수 있는 안)
export function draftTarget(ctx: Context, change: Change, draft?: Draft) {
  const opts = withMethod(ctx, change, draftOptions(draft))
  const { min, max } = targetRange(ctx, change, opts)
  const rv = draft?.target ? null : review(ctx, change, opts)
  const target = draft?.target ?? rv?.options[rv.recommended]?.to ?? min
  return target < min ? min : target > max ? max : target
}

// AI ③이 고른 담당별 근거 사례
export function evidenceOf(analysis?: Analysis): Evidence | undefined {
  if (!analysis) return undefined
  return Object.fromEntries(analysis.stakeholders.map((s) => [s.party, s.cases])) as Evidence
}

// 결정된 변경의 진행 보드 할 일 (결정 당시 기준값으로 계산)
export function boardTasks(ctx: Context, change: Change, analysis?: Analysis): Task[] {
  return change.decision ? decidedTasks(ctx, change, change.decision, evidenceOf(analysis)).tasks : []
}

function useStoreValue() {
  const [state, setState] = useState<State>(loadState)
  const sync = useRoomSync(boot.room, boot.reset, state, setState, acceptRemote)
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(state))
    } catch {
      // 저장하지 못해도 화면은 그대로 쓴다
    }
  }, [state])

  const ctx: Context = useMemo(() => ({ series: state.series, benchmarks: benchmarksOf(caseData, state.actuals), costs: projectData.costs }), [state.series, state.actuals])
  const cases = useMemo(() => [...caseData, ...state.learned], [state.learned])
  const today = state.series.today

  const update = useCallback((fn: (s: State) => State) => setState(fn), [])
  const log = (s: State, code: string, text: string, date = s.series.today): State => ({
    ...s,
    logs: { ...s.logs, [code]: [...(s.logs[code] ?? []), { date, text }] },
  })
  const patchChange = (s: State, code: string, fn: (c: Change) => Change): State => ({
    ...s,
    changes: s.changes.map((c) => (c.code === code ? fn(c) : c)),
  })

  const setDraft = (code: string, patch: Partial<Draft>, history?: string) =>
    update((s) => {
      const prev: Draft = s.drafts[code] ?? { overrides: {}, excluded: [] }
      const draft = { ...prev, ...patch }
      const next = { ...s, drafts: { ...s.drafts, [code]: draft } }
      return history ? log(next, code, history) : next
    })

  // 결정은 바로 기록하고(정해진 문장 틀의 요약), AI 요약은 뒤에서 받아 검증되면 바꾼다
  const decide = (code: string) => {
    const planned = planDecision(state, code)
    update((s) => {
      const p = planDecision(s, code)
      if (!p) return s
      const { change, c, draft, opts, target, plan, baseline } = p
      // 인도일 = 지연 - 만회로 줄인 날 (계약 여유 안의 지연은 그대로 미루되 계약 납기는 지킨다)
      const recovered = new Map(overrunsOf(plan.sim, c.costs?.recovery).map((o) => [o.vessel, o.recovered.reduce((sum, r) => sum + r.days, 0)]))
      const delays = new Map(plan.sim.rows.filter((r) => r.delay > 0).map((r) => [r.vessel.id, r.delay - (recovered.get(r.vessel.id) ?? 0)]))
      const vessels = s.series.vessels.map((v) => {
        const d = delays.get(v.id)
        return d ? { ...v, previousDelivery: v.delivery, delivery: addDays(v.delivery, d) } : { ...v, previousDelivery: undefined }
      })
      const decision: Decision = {
        decidedOn: s.series.today,
        target,
        prepDays: opts.prepDays ?? s.series.prepDays,
        overrides: draft?.overrides as Record<string, number> | undefined,
        baseline,
        excluded: draft?.excluded ?? [],
        done: [],
        dueOverrides: {},
        summary: decisionSummary(change, plan.sim, plan.tasks, opts.method),
        deliveries: Object.fromEntries(vessels.map((v) => [v.id, v.delivery])),
        benchmarks: c.benchmarks,
        method: opts.method,
        priority: opts.priority,
      }
      let next = patchChange({ ...s, series: { ...s.series, baseline, vessels } }, code, (x) => ({
        ...x,
        status: "decided",
        isNew: false,
        decision,
      }))
      next = log(next, code, `결정 · 회의: ${formatShort(plan.sim.release)} 배포로 결정, ${baseline} 기준선 채택, 할 일 ${plan.tasks.length}건 확정`)
      return next
    })
    if (planned)
      requestSummary({
        code,
        title: planned.change.title,
        facts: summaryFacts(planned.change, planned.plan.sim, planned.plan.tasks, {
          decidedOn: state.series.today,
          baseline: planned.baseline,
          removed: planned.plan.removed,
          method: planned.opts.method,
        }),
      })
  }

  const [summarizing, setSummarizing] = useState<Record<string, boolean>>({})
  const requestSummary = (input: SummaryInput) => {
    setSummarizing((x) => ({ ...x, [input.code]: true }))
    fetch("/api/summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: input }) })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `AI 호출 실패 (${response.status})`)
        return body as { summary: string; provider: "claude" | "gemini" }
      })
      .then(({ summary, provider }) =>
        update((s) =>
          log(
            patchChange(s, input.code, (x) => (x.decision ? { ...x, decision: { ...x.decision, summary, summarySource: provider } } : x)),
            input.code,
            "AI 요약 · 회의 결정 요약을 받았어요 (숫자는 계산값과 대조)",
          ),
        ),
      )
      .catch((error: Error) => update((s) => log(s, input.code, `AI 요약 못 함 · ${error.message}. 정해진 틀의 요약을 그대로 써요`)))
      .finally(() => setSummarizing((x) => ({ ...x, [input.code]: false })))
  }

  // 진행 보드에서 예정일을 바꾸거나 완료하면 뒤 일정과 인도일을 다시 계산한다.
  // 완료하면 실제 걸린 일수(시작일 ~ 완료일)를 실적으로 남기고, 할 일이 모두 끝나면 변경을 사례로 쌓는다
  const changeTaskDue = (code: string, taskId: string, newEnd: string, who: string, completed = false) =>
    update((s) => {
      const change = s.changes.find((c) => c.code === code)
      if (!change?.decision) return s
      const c = contextOf(s)
      const tasks = boardTasks(c, change, s.analyses[code])
      const done = new Set(change.decision.done)
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return s
      let next = s
      let dueOverrides = change.decision.dueOverrides
      if (newEnd !== task.end) {
        const result = propagate(c, tasks, taskId, newEnd, done)
        const before = new Map(tasks.map((t) => [t.id, t]))
        dueOverrides = { ...dueOverrides }
        result.tasks.forEach((t) => {
          const b = before.get(t.id)!
          if (t.start !== b.start || t.end !== b.end) dueOverrides[t.id] = { start: t.start, end: t.end }
        })
        const vessels = s.series.vessels.map((v) => {
          const shift = result.deliveryShift[v.id]
          return shift ? { ...v, previousDelivery: v.previousDelivery ?? v.delivery, delivery: addDays(v.delivery, shift) } : v
        })
        next = {
          ...next,
          series: { ...next.series, vessels },
          alerts: { ...next.alerts, [code]: [{ date: s.series.today, title: `${who}: ${result.title}`, lines: result.lines }, ...(next.alerts[code] ?? [])] },
        }
        next = log(next, code, `예정일 변경 · ${who}: ${task.name}${task.vessel ? ` (${task.vessel})` : ""} ${formatShort(task.end)} → ${formatShort(newEnd)}`)
      }
      if (completed) {
        done.add(taskId)
        const evidence = evidenceOf(s.analyses[code])
        const planned = plannedTasks(c, change, change.decision, evidence).tasks.find((t) => t.id === taskId) ?? task
        if (isMeasured(task, planned)) {
          const record: Actual = {
            code,
            taskId,
            dept: task.party ?? TEAM_DEPT(task.team),
            task: taskLabel(task),
            metric: task.metric,
            planned: daysBetween(planned.start, planned.end),
            actual: Math.max(0, daysBetween(task.start, newEnd)),
            date: s.series.today,
          }
          next = log(next, code, `완료 · ${record.task} · 실제 ${record.actual}일 (계획 ${record.planned}일)`)
          next = { ...next, actuals: [...next.actuals, record] }
        } else next = log(next, code, `완료 · ${taskLabel(task)}`)
        if (tasks.every((t) => done.has(t.id)) && !next.learned.some((x) => x.code === code)) {
          const plan = plannedTasks(c, change, change.decision, evidence)
          const features = s.analyses[code]?.features ?? readFeatures(change)
          next = { ...next, learned: [...next.learned, caseFromDecision(change, plan.sim, tasks, next.actuals, features)] }
          next = log(next, code, `사례 적립 · 할 일 ${tasks.length}건이 모두 끝나 사례 ${code}로 쌓였어요`)
        }
      }
      return patchChange(next, code, (x) => ({ ...x, decision: { ...x.decision!, dueOverrides, done: [...done] } }))
    })

  // 연동 수신함은 15초마다, 창으로 돌아올 때마다 확인한다 (안 보이는 탭은 건너뜀)
  const [inbox, setInbox] = useState<InboxEvent[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const checkInbox = async () => {
    setChecking(true)
    const events = await fetchInbox()
    if (events) setInbox(events)
    setCheckedAt(new Date().toISOString())
    setChecking(false)
  }
  useEffect(() => {
    checkInbox()
    const id = setInterval(() => document.visibilityState === "visible" && checkInbox(), INBOX_POLL_MS)
    const onFocus = () => checkInbox()
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(id)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  // 아직 반영하지 않은 소식: 연동 수신함 + 시연 데이터. 반영하면 바뀔 결정 마감을 미리 계산해 둔다
  const updates = useMemo<Updates>(() => {
    const known = new Set(state.changes.map((c) => c.code))
    const plm: Updates["plm"] = []
    const addPlm = (change: Change, source: UpdateSource) => {
      if (known.has(change.code)) return
      known.add(change.code)
      plm.push({ change: classified(change), source })
    }
    inbox.forEach((e) => e.kind === "plm" && addPlm(e.change, "inbox"))
    live.plm.forEach((c) => addPlm(c, "demo"))
    const seen = new Set(state.synced)
    const sync: Updates["sync"] = []
    const addSync = (event: SyncEvent, source: UpdateSource) => {
      if (seen.has(event.id)) return
      seen.add(event.id)
      sync.push({ event, source })
    }
    inbox.forEach((e) => e.kind === "sync" && addSync(e.event, "inbox"))
    live.sync.forEach((e) => addSync(e, "demo"))
    const shifts = sync.length ? applySync(contextOf(state), state.changes, sync.map((x) => x.event)).shifts : []
    return { plm, sync, shifts, count: plm.length + sync.length }
  }, [state, inbox])

  // 갱신하기: 새 변경 요청은 영향 범위를 나눠 등록하고, ERP · MES 갱신은 일정 · 자재에 반영한 뒤 바뀐 결정 마감을 알린다
  const applyUpdates = () => {
    const u = updates
    if (!u.count) return null
    update((s) => {
      const add = u.plm.map((x) => x.change).filter((c) => !s.changes.some((x) => x.code === c.code))
      let next: State = { ...s, changes: [...add, ...s.changes] }
      u.plm.forEach(({ change, source }) => {
        if (add.includes(change))
          next = log(next, change.code, `등록 · ${source === "inbox" ? "연동 수신함의 " : ""}PLM ${change.ecr ?? ""} 이벤트로 자동 등록 · ${boundaryNote(change)}`)
      })
      const events = u.sync.map((x) => x.event).filter((e) => !s.synced.includes(e.id))
      if (events.length) {
        const fresh = new Set(add.map((c) => c.code))
        const r = applySync(contextOf(next), next.changes, events)
        const shifts = r.shifts.filter((x) => !fresh.has(x.code)) // 방금 들어온 변경은 마감이 '바뀐' 게 아니다
        next = {
          ...next,
          series: r.series,
          changes: r.changes,
          synced: [...next.synced, ...events.map((e) => e.id)],
          deadlineAlerts: [...shifts.map((x) => ({ ...x, date: s.series.today })), ...next.deadlineAlerts],
        }
        shifts.forEach((x) => {
          next = log(next, x.code, `마감 변경 · ${x.reasons.join(", ")} → 결정 마감 ${formatShort(x.from)} → ${formatShort(x.to)} (${x.toTeams} 기준)${x.toMethod ? ` · 추천 ${x.fromMethod} → ${x.toMethod}` : ""}`)
        })
      }
      return next
    })
    return u
  }
  const dismissDeadlineAlerts = () => update((s) => ({ ...s, deadlineAlerts: [] }))

  // 3단 검증 체크 · 증빙 첨부. 세 항목이 다 맞거나 증빙을 붙이면 변경 이력에 남긴다
  const verifyTask = (code: string, task: Task, patch: Partial<Verification>) =>
    update((s) => {
      const prev = s.verifications[code]?.[task.id] ?? { checks: VERIFY_ITEMS.map(() => false) }
      const item = { ...prev, ...patch }
      let next: State = { ...s, verifications: { ...s.verifications, [code]: { ...(s.verifications[code] ?? {}), [task.id]: item } } }
      if (patch.evidence) next = log(next, code, `증빙 첨부 · ${taskLabel(task)}: ${patch.evidence.name}`)
      if (item.checks.every(Boolean) && !prev.checks.every(Boolean))
        next = log(next, code, `3단 검증 완료 · ${taskLabel(task)} (PLM 요구 도면 · MES 작업지시 · MES 실적 모두 v2)`)
      return next
    })

  // AI 결과가 없는 변경은 /api/ai를 부르고, 실패하면 규칙으로 계산한 결과를 쓴다
  const [analyzing, setAnalyzing] = useState<Record<string, boolean>>({})
  const [opining, setOpining] = useState<Record<string, boolean>>({})
  // AI 대안 검토 의견: 버튼으로만 부른다 (같은 입력이면 저장된 것을 쓴다). 실패하면 이유를 남기고 화면은 규칙 의견
  const requestOpinion = (input: OpinionInput) => {
    const key = opinionKey(input)
    if (state.opinions?.[key]?.source !== undefined && state.opinions[key].source !== "rules") return
    if (opining[key]) return
    setOpining((o) => ({ ...o, [key]: true }))
    const save = (opinion: Opinion, history: string) => update((s) => log({ ...s, opinions: { ...s.opinions, [key]: opinion } }, input.code, history))
    fetch("/api/opinion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ opinion: input }) })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `AI 호출 실패 (${response.status})`)
        return body as { opinions: Opinion["opinions"]; provider: "claude" | "gemini" }
      })
      .then((body) =>
        save({ key, source: body.provider, opinions: body.opinions, createdAt: new Date().toISOString() }, `AI 대안 검토 의견 · ${input.priority} 기준`),
      )
      .catch((error: Error) =>
        save({ key, source: "rules", opinions: [], note: error.message, createdAt: new Date().toISOString() }, `AI 대안 의견 못 받음 · ${error.message}`),
      )
      .finally(() => setOpining((o) => ({ ...o, [key]: false })))
  }
  const inFlight = useRef(new Set<string>())
  const requestAnalysis = (change: Change) => {
    if (change.boundary === "design" || change.status === "withdrawn" || state.analyses[change.code] || inFlight.current.has(change.code)) return
    inFlight.current.add(change.code)
    setAnalyzing((a) => ({ ...a, [change.code]: true }))
    const save = (analysis: Analysis, history: string) =>
      update((s) => log({ ...s, analyses: { ...s.analyses, [change.code]: analysis } }, change.code, history))
    // 진행 보드에서 쌓인 사례도 같이 보내 사례 찾기 대상에 넣는다
    fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change, cases: state.learned, today: state.series.today }) })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `AI 호출 실패 (${response.status})`)
        return body as Analysis
      })
      .then((analysis) => save(analysis, `AI 분석 · 특징 태그, 비슷한 사례 ${analysis.similar.length}건, 관계자 ${analysis.stakeholders.length}곳`))
      .catch((error: Error) =>
        save(ruleAnalysis(ctx, change, cases, error.message), `AI 분석 못 함 · ${error.message}. 규칙으로 계산했어요`),
      )
      .finally(() => {
        inFlight.current.delete(change.code)
        setAnalyzing((a) => ({ ...a, [change.code]: false }))
      })
  }

  const register = (input: Change) => {
    const change = classified(input)
    update((s) => log({ ...s, changes: [change, ...s.changes] }, change.code, `등록 · 설계변경 직접 등록 · ${boundaryNote(change)}`))
    return change
  }

  const nextCode = () => {
    const max = Math.max(...[...state.changes, ...live.plm].map((c) => Number(c.code.replace("DC-", ""))))
    return `DC-${String(max + 1).padStart(3, "0")}`
  }

  return {
    state,
    sync,
    ctx,
    cases,
    today,
    setDraft,
    decide,
    changeTaskDue,
    updates,
    applyUpdates,
    checkInbox,
    checkedAt,
    checking,
    dismissDeadlineAlerts,
    verifyTask,
    register,
    nextCode,
    requestAnalysis,
    analyzing,
    summarizing,
    requestOpinion,
    opining,
    addLog: (code: string, text: string) => update((s) => log(s, code, text)),
  }
}

export type Store = ReturnType<typeof useStoreValue>
const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue()
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const value = useContext(StoreContext)
  if (!value) throw new Error("StoreProvider가 필요해요")
  return value
}

// 변경 하나의 AI 결과. 없으면 화면이 열릴 때 한 번 요청한다
export function useAnalysis(change: Change) {
  const { state, requestAnalysis, analyzing } = useStore()
  useEffect(() => {
    requestAnalysis(change)
  }, [change.code]) // eslint-disable-line react-hooks/exhaustive-deps
  return { analysis: state.analyses[change.code], loading: Boolean(analyzing[change.code]) }
}
