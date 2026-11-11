// 팀별 할 일: 처리 유형별 기본 목록(코드)과 관계자 제안(규칙 · AI ③).
// 담당 분류(수정 계획 6번): 할 일은 모두 사내 직무 하나가 맡고, 회사 밖(선주 · 선급 · 협력사 · 공급사)은 "상대"로만 붙는다.
// 할 일 사이 선후 관계(deps, lags)를 이어 두고, 예정일이 바뀌면 뒤 일정과 인도일 영향을 계산한다.
import type { Change, Decision, Metric } from "../data/types.js"
import { addDays, daysBetween, formatShort, maxDate, minDate } from "./dates.js"
import { type Context, type SimOptions, type SimResult, gated, isMandatory, params, reinforceOf, simulate } from "./simulate.js"

// 사내 직무 (할 일을 맡는 쪽)
export type TaskTeam = "control" | "pm" | "design" | "purchase" | "production" | "subcon" | "quality" | "legal" | "cost"
// 회사 밖 상대 (사내 창구를 통해서만 등장)
export type Counterpart = "선주" | "선급" | "협력사" | "공급사"
export type Role = "결정·조율" | "설계" | "조달" | "생산" | "품질" | "지원"
export const TEAM_INFO: Record<TaskTeam, { label: string; role: Role }> = {
  control: { label: "공정관리", role: "결정·조율" },
  pm: { label: "PM·영업", role: "결정·조율" },
  design: { label: "설계", role: "설계" },
  purchase: { label: "구매", role: "조달" },
  production: { label: "생산", role: "생산" },
  subcon: { label: "외주관리", role: "생산" },
  quality: { label: "품질", role: "품질" },
  legal: { label: "계약·법무", role: "지원" },
  cost: { label: "원가", role: "지원" },
}
export const ROLES: Role[] = ["결정·조율", "설계", "조달", "생산", "품질", "지원"]
// AI ③ 관계자(선급 · 선주 · 계약 · 법무 · 품질)를 맡는 사내 직무와 상대
const PARTY_OWNER: Record<Party, { team: TaskTeam; counterpart?: Counterpart }> = {
  선급: { team: "design", counterpart: "선급" },
  선주: { team: "pm", counterpart: "선주" },
  "계약·법무": { team: "legal" },
  품질: { team: "quality" },
}
export type TaskStatus = "완료" | "진행" | "예정" | "선행 대기" | "기한 넘김"
export type Party = "선급" | "선주" | "계약·법무" | "품질"

export type Task = {
  id: string
  team: TaskTeam // 맡는 사내 직무
  counterpart?: Counterpart // 상대 (회사 밖)
  party?: Party // AI ③ 관계자 (근거 사례 · AI 제안 표시)
  name: string
  start: string
  end: string
  vesselId?: string
  vessel?: string // 1호선
  maker?: string // 사내 · 협력사 이름
  deps: string[]
  lags?: Record<string, number> // 선행 일이 끝난 뒤 며칠 뒤에 시작할 수 있나
  flex?: boolean // 작업지시 · 수신 확인처럼 시작만 밀리고 끝은 그대로인 일
  window?: boolean // 기한 안에만 하면 되는 일 (착수 전 작업지시 변경). 걸린 일수를 세지 않는다
  drive?: boolean // 이 일이 밀리면 호선 인도일이 같이 밀린다
  receipt?: boolean // 자재 입고
  ai?: boolean // 관계자 제안 (AI ③ 또는 규칙)
  metric?: Metric // 완료하며 적은 실제 일수가 쌓이는 실적 기준값
  locked?: boolean // 회의에서 뺄 수 없음
  reason?: string
  cases?: string
}

const TEAM_LABEL: Record<TaskTeam, string> = Object.fromEntries(Object.entries(TEAM_INFO).map(([k, v]) => [k, v.label])) as Record<TaskTeam, string>

const EXT_METRIC: Record<string, Metric> = { class: "approval", "owner-delivery": "owner" }

const hullNo = (order: string) => order.replace("호선", "")

export type TaskPlan = { tasks: Task[]; removed: Task[]; sim: SimResult }
// AI ③이 고른 담당별 근거 사례 (없으면 규칙의 기본 근거)
export type Evidence = Partial<Record<Party, string[]>>

export function generateTasks(
  ctx: Context,
  change: Change,
  target: string,
  opts: SimOptions & { excluded?: string[]; evidence?: Evidence } = {},
): TaskPlan {
  const p = params(ctx, change, opts).values
  const today = opts.today ?? ctx.series.today
  const sim = simulate(ctx, change, target, opts)
  const day = sim.release
  const gate = gated(change, opts)
  const reinforce = reinforceOf(change, opts)
  const excluded = new Set(opts.excluded ?? [])
  const tasks: Task[] = []
  const removed: Task[] = []
  const add = (task: Omit<Task, "deps"> & { deps?: string[] }) => {
    const full = { deps: [], ...task }
    tasks.push(full)
    return full
  }
  const ext = (key: string, party: Party, name: string, start: string, end: string, reason: string, deps: string[] = []) => {
    const owner = PARTY_OWNER[party]
    const task: Task = {
      id: `ext:${key}`,
      team: owner.team,
      ...(owner.counterpart ? { counterpart: owner.counterpart } : {}),
      party,
      name,
      start,
      end,
      deps,
      ai: true,
      metric: EXT_METRIC[key],
      locked: key === "class" && gate,
      reason,
      cases: opts.evidence?.[party]?.length ? opts.evidence[party]!.join(" · ") : undefined, // 근거 사례는 AI ③ · 규칙 분석이 찾은 것만
    }
    if (excluded.has(task.id) && !task.locked) {
      removed.push(task)
      return null
    }
    tasks.push(task)
    return task
  }

  const submit = add({
    id: "design:submit",
    team: "design",
    name: reinforce ? "보강안 도면 제출 (선주 · 선급)" : gate ? "선급 지적 반영 도면 제출" : "개정 도면 선급 제출",
    start: gate ? today : day,
    end: gate ? today : addDays(day, 1),
  })
  const approval = ext(
    "class",
    "선급",
    reinforce ? "선급 보강안 승인 받기" : gate ? "선급 지적 반영 도면 승인 받기" : "선급 개정 도면 승인 받기",
    gate ? addDays(today, 1) : addDays(day, 1),
    gate ? addDays(today, p.class) : addDays(day, 1 + p.class),
    reinforce ? "기존 부품을 보강해 쓰려면 승인이 먼저라서" : gate ? "선급 지적이라 승인 전에는 도면을 배포할 수 없어서" : "구조 부재가 바뀌어서",
    [submit.id],
  )
  const release = add({
    id: "design:release",
    team: "design",
    name: "v2 도면 배포 (PLM 승인 · MES 전송)",
    start: day,
    end: day,
    deps: gate && approval ? [approval.id] : [],
  })

  let receive: Task | null = null
  if (change.material) {
    const m = change.material
    const stockN = sim.rows.filter((r) => r.source === "stock").length
    const buyN = sim.rows.filter((r) => r.source === "buy").length
    const orderDay = minDate(day, today)
    if (stockN) add({ id: "purchase:stock", team: "purchase", name: `${m.item} 재고 할당 (${stockN}척분)`, start: orderDay, end: orderDay })
    const supplier = { counterpart: "공급사" as const }
    if (buyN) {
      const order = add({ id: "purchase:order", team: "purchase", ...supplier, name: `${m.item} ${opts.method === "B" ? "긴급 발주" : "신규 발주"} (${buyN}척분)`, start: orderDay, end: orderDay })
      receive = add({
        id: "purchase:receive",
        team: "purchase",
        ...supplier,
        name: `${m.item} 입고`,
        start: orderDay,
        end: addDays(orderDay, p.purchase),
        deps: [order.id],
        receipt: true,
        metric: "procure",
      })
    }
    if (m.old) add({ id: "purchase:old", team: "purchase", ...supplier, name: `${m.old.item} 발주 변경 · 취소 (${m.old.open}척분)`, start: day, end: addDays(day, 1) })
  }

  sim.rows.forEach((row) => {
    const v = row.vessel
    const b = row.block
    const base = { team: "production" as const, vesselId: v.id, vessel: v.order, maker: b.partner ?? "사내" }
    const materialDeps = row.source === "buy" && receive ? [receive.id] : []
    const lags = { [release.id]: p.prep }
    const receiptTask = b.partner
      ? add({ ...base, team: "subcon", counterpart: "협력사", id: `${v.id}:receipt`, name: `${b.partner} 새 도면 수신 확인`, start: day, end: addDays(day, p.production), deps: [release.id], flex: true })
      : null
    if (row.kind === "apply") {
      const wo = add({ ...base, id: `${v.id}:wo`, name: "작업지시 v2로 변경", start: day, end: maxDate(day, addDays(b.start, -1)), deps: [release.id], flex: true, window: true })
      const s = addDays(b.start, row.materialWait)
      add({ ...base, id: `${v.id}:start`, name: "블록 착수 (v2)", start: s, end: s, deps: [release.id, wo.id, ...(receiptTask ? [receiptTask.id] : []), ...materialDeps], lags, drive: true })
    } else if (row.kind === "hold") {
      const wo = add({ ...base, id: `${v.id}:wo`, name: "제작 중단 · 수정 결정", start: day, end: addDays(day, 1), deps: [release.id], flex: true })
      const s = addDays(target, row.materialWait)
      add({ ...base, id: `${v.id}:fix`, name: "수정 작업", start: s, end: addDays(s, row.processDays), deps: [release.id, wo.id, ...materialDeps], lags, drive: true, metric: "hold" })
    } else {
      const wo = add({ ...base, id: `${v.id}:wo`, name: "처리 방법 결정", start: day, end: addDays(day, 2), deps: [release.id], flex: true })
      const s = addDays(target, row.materialWait)
      const rework = add({
        ...base,
        id: `${v.id}:rework`,
        name: row.reinforced ? (row.kind === "rework" ? "기존 부품 보강" : "선상 보강") : row.kind === "rework" ? "블록 재작업" : "선상 재작업",
        start: s,
        end: addDays(s, row.processDays),
        deps: [release.id, wo.id, ...materialDeps],
        lags,
        ...(row.reinforced ? {} : { metric: row.kind === "rework" ? ("rework" as const) : ("reworkErected" as const) }),
      })
      add({ ...base, team: "quality", id: `${v.id}:inspect`, name: "재검사", start: rework.end, end: addDays(rework.end, 1), deps: [rework.id], drive: true })
    }
  })

  const hit = sim.rows.filter((r) => r.delay > 0)
  const fix = sim.rows.filter((r) => r.kind !== "apply")
  if (reinforce?.approvals.includes("선주"))
    ext("owner-reinforce", "선주", "선주 보강안 승인 받기 (기존 부품 활용)", day, addDays(day, 2), "바꾸지 않고 보강하면 사양이 달라져 선주 동의가 필요해서", [submit.id])
  if (change.reason === "선주 요청")
    ext("owner-spec", "선주", "선주와 변경 사양 · 추가 비용 확인", day, addDays(day, 2), "선주 요청 변경이라 계약 변경이 필요할 수 있어서")
  if (hit.length) {
    ext("owner-delivery", "선주", `선주와 인도일 변경 협의 (${hit.map((r) => hullNo(r.vessel.order)).join(", ")}호선)`, day, addDays(day, ctx.benchmarks.owner), "인도일이 바뀌는 호선이 있어서")
    ext("legal", "계약·법무", "인도 지연 조항 검토 (확인 필요)", day, addDays(day, 3), "조항은 계약마다 달라 사람이 확인")
  }
  if (fix.length)
    ext("quality", "품질", `재검사 계획 (${fix.map((r) => hullNo(r.vessel.order)).join(", ")}호선)`, day, addDays(day, 2), "재작업 · 수정 작업이 생겨서")

  // 공정관리: 결정을 부서에 나누고 착수를 확인, 원가: 고른 안의 변경 원가를 확정 (기한 안에만 하면 되는 일)
  const today2 = minDate(day, today)
  add({ id: "control:share", team: "control", name: "결정 공유 · 부서별 착수 확인", start: today2, end: day, window: true })
  add({
    id: "cost:settle",
    team: "cost",
    name: opts.method === "B" ? "긴급 조달 비용 승인 · 변경 원가 확정" : opts.method === "C" ? "보강 비용 · 변경 원가 확정" : "변경 원가 확정 (자재 · 작업)",
    start: today2,
    end: addDays(today2, 2),
    window: true,
  })
  return { tasks, removed, sim }
}

// 결정한 변경은 결정 당시의 실적 기준값으로 계산한다 (실제 일수가 쌓여도 정한 일정이 저절로 바뀌지 않게)
export const decisionContext = (ctx: Context, decision: Decision): Context =>
  decision.benchmarks ? { ...ctx, benchmarks: decision.benchmarks } : ctx

// 결정할 때 만든 할 일 목록 (담당자가 예정일을 바꾸기 전)
export function plannedTasks(ctx: Context, change: Change, decision: Decision, evidence?: Evidence): TaskPlan {
  return generateTasks(decisionContext(ctx, decision), change, decision.target, {
    evidence,
    prepDays: decision.prepDays,
    overrides: decision.overrides,
    method: decision.method,
    today: decision.decidedOn,
    excluded: decision.excluded,
  })
}

// 결정된 변경의 할 일: 결정할 때 만든 목록에 담당자가 바꾼 예정일을 덮는다
export function decidedTasks(ctx: Context, change: Change, decision: Decision, evidence?: Evidence): TaskPlan {
  const plan = plannedTasks(ctx, change, decision, evidence)
  plan.tasks = plan.tasks.map((t) => {
    const o = decision.dueOverrides[t.id]
    return o ? { ...t, start: o.start ?? (t.start > o.end ? o.end : t.start), end: o.end } : t
  })
  return plan
}

export function taskStatus(task: Task, tasks: Task[], done: Set<string>, today: string): TaskStatus {
  if (done.has(task.id)) return "완료"
  if (task.end < today) return "기한 넘김"
  const waiting = task.deps.some((id) => tasks.some((t) => t.id === id) && !done.has(id))
  if (waiting && task.start > today) return "선행 대기"
  return task.start <= addDays(today, 7) ? "진행" : "예정"
}

export type Propagation = {
  tasks: Task[]
  title: string
  lines: string[]
  deliveryShift: Record<string, number> // 호선별 인도일 변화(일)
}

const who = (t: Task) => `${t.party ?? TEAM_LABEL[t.team]}${t.vessel ? ` ${t.vessel}` : ""}`

// 담당자가 예정일을 바꾸면, 선행 일보다 먼저 잡힌 뒤 일을 밀고(앞당기지는 않음) 인도일 영향을 계산한다
export function propagate(
  ctx: Context,
  current: Task[],
  taskId: string,
  newEnd: string,
  done: Set<string> = new Set(),
): Propagation {
  const tasks = current.map((t) => ({ ...t }))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const before = new Map(current.map((t) => [t.id, { start: t.start, end: t.end }]))
  const target = byId.get(taskId)
  if (!target) throw new Error(`없는 할 일: ${taskId}`)
  const was = target.end
  target.end = newEnd
  if (target.start > target.end) target.start = target.end

  for (let guard = 0, moved = true; moved && guard < 100; guard++) {
    moved = false
    for (const x of tasks) {
      if (done.has(x.id)) continue
      const deps = x.deps.map((id) => byId.get(id)).filter((d): d is Task => Boolean(d))
      if (!deps.length) continue
      const required = maxDate(...deps.map((d) => addDays(d.end, x.lags?.[d.id] ?? 0)))
      if (required <= x.start) continue
      if (x.flex) {
        x.start = required
        if (x.end < x.start) x.end = x.start
      } else {
        const shift = daysBetween(x.start, required)
        x.start = required
        x.end = addDays(x.end, shift)
      }
      moved = true
    }
  }

  const vessels = new Map(ctx.series.vessels.map((v) => [v.id, v]))
  const lines: string[] = []
  const deliveryShift: Record<string, number> = {}
  tasks.forEach((x) => {
    const b = before.get(x.id)!
    if (x.id === taskId || x.end === b.end) return
    lines.push(`${who(x)} '${x.name}' ${formatShort(b.end)} → ${formatShort(x.end)}`)
    if (x.drive && x.vesselId) {
      const delta = daysBetween(b.end, x.end)
      const v = vessels.get(x.vesselId)!
      const from = addDays(v.delivery, deliveryShift[x.vesselId] ?? 0)
      deliveryShift[x.vesselId] = (deliveryShift[x.vesselId] ?? 0) + delta
      lines.push(`→ ${v.order} 인도 ${formatShort(from)} → ${formatShort(addDays(from, delta))} (${delta > 0 ? "+" : ""}${delta}일)`)
    }
  })
  if (newEnd > was) {
    let roomy = 0
    tasks
      .filter((x) => x.deps.includes(taskId) && x.end === before.get(x.id)!.end)
      .forEach((x) => {
        const slack = daysBetween(newEnd, x.start) - (x.lags?.[taskId] ?? 0)
        if (slack > 7) roomy++
        else lines.push(`${who(x)} '${x.name}' ${formatShort(x.start)}: 여유 ${slack}일 남아 영향 없음`)
      })
    if (roomy) lines.push(`나머지 ${roomy}건은 여유가 일주일 넘게 남아 영향 없음`)
  }
  if (!lines.length) lines.push(newEnd < was ? "앞당겨졌어요. 이어진 일정은 그대로 둬요" : "이어진 할 일과 인도일에 영향 없음")
  return {
    tasks,
    title: `${who(target)} '${target.name}' 예정일 ${formatShort(was)} → ${formatShort(newEnd)}`,
    lines,
    deliveryShift,
  }
}

// 회의 결정 요약 (AI ④ 자리. 날짜와 숫자는 계산 결과를 그대로 넣는다)
// "으로/로": 받침이 있으면(ㄹ 빼고) "으로"
const ro = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  const jong = code % 28
  return code >= 0 && code <= 11171 && jong !== 0 && jong !== 8 ? "으로" : "로"
}
const METHOD_NAME: Record<string, string> = { A: "A 일반 조달", B: "B 긴급 조달", C: "C 기존 부품 보강" }

export function decisionSummary(change: Change, sim: SimResult, tasks: Task[], method?: string) {
  const how = method && METHOD_NAME[method] ? `${METHOD_NAME[method]}${ro(METHOD_NAME[method])} ` : ""
  const lines = [`${how}현장 반영 목표 ${formatShort(sim.target)}로 결정 (v2 도면 배포 ${formatShort(sim.release)}).`]
  sim.rows
    .filter((r) => r.delay > 0)
    .forEach((r) => {
      const wait = r.materialWait ? `(자재 대기 ${r.materialWait}일 포함)` : ""
      lines.push(
        `${r.vessel.order} ${change.block}은 ${r.handling}${ro(r.handling)} 처리${wait}, 인도 ${formatShort(r.vessel.delivery)} → ${formatShort(addDays(r.vessel.delivery, r.delay))}.`,
      )
    })
  const ok = sim.rows.filter((r) => r.delay === 0).map((r) => hullNo(r.vessel.order))
  if (ok.length) lines.push(`${ok.join(", ")}호선은 작업지시 변경으로 일정 영향 없이 반영.`)
  const receive = tasks.find((t) => t.receipt)
  if (receive && change.material) lines.push(`구매는 ${change.material.item}를 발주, ${formatShort(receive.end)} 입고 예정.`)
  const approval = tasks.find((t) => t.id === "ext:class")
  if (approval) lines.push(`${approval.name.replace(": ", " ")}은 ${formatShort(approval.end)}까지.`)
  const owner = tasks.find((t) => t.id === "ext:owner-delivery")
  if (owner) lines.push(`선주와 인도일 변경을 ${formatShort(owner.end)}까지 협의, 계약 조항은 법무 확인.`)
  return lines.join(" ")
}
