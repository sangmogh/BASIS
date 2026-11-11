// 일정 · 진척(메뉴 1)과 첫 화면 프로젝트 요약: 설계변경 · 회의 화면과 같은 새 엔진 데이터(DB) 한 곳에서 계산한다
//   (11/5 전까지 이 화면들은 옛 JSON(src/data)과 옛 엔진을 써서, 결정 마감 · 인도일 · 진행 중 호선 수가 다른 화면과 어긋났다)
//   - 호선 단계: 마일스톤(착공 = 첫 블록 제작 · 탑재 시작 · 진수 · 인도)과 기준일로 정한다
//   - 진척(일정 기준): 착공 → 인도 사이에서 기준일이 지난 비율. 인도한 배는 100, 착공 전은 0
//   - 블록: 블록 일정(block_window)과 기준일로 생산 전 · 제작 중 · 제작 완료 · 설치 중 · 설치 완료를 센다
//   - 설계변경 영향: 회의 화면과 같은 reviewChange 결과(결정한 변경은 결정한 안, 결정 대기는 추천안)를 호선별로
import { reviewChange, type Ontology, type Tables, type World } from "./engine/index.js"

type Row = Record<string, any>

export const MILESTONES = ["construction_start", "block_erection_start", "launch", "delivery"] as const
type Milestone = (typeof MILESTONES)[number]
const MS_LABEL: Record<Milestone, string> = { construction_start: "착공", block_erection_start: "탑재 시작", launch: "진수", delivery: "인도" }

const PHASES = {
  planning: "계약 · 계획",
  engineering: "설계 · 자재",
  block: "블록 제작",
  erection: "탑재",
  outfitting: "진수 후 의장 · 시운전",
  delivered: "인도 · 운항 중",
} as const
type Phase = keyof typeof PHASES
const IN_PRODUCTION: Phase[] = ["block", "erection", "outfitting"]

// 회의 화면(MeetingView TREAT)과 같은 말
const TREAT: Record<string, string> = { new_spec: "변경 도면 적용 제작", rework: "기존 부품 교체", retrofit: "기존 부품 보강", mixed: "기존 부품 보강 및 교체", post_delivery: "인도 후 개조", not_applicable: "변경 적용 제외" }

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const dayOf = (v: unknown) => (v ? String(v).slice(0, 10) : null)

function milestonesOf(tables: Tables, hullId: string) {
  const rows = (tables.hull_milestone ?? []).filter((m: Row) => m.hull_id === hullId)
  return Object.fromEntries(
    MILESTONES.map((k) => {
      const m = rows.find((r: Row) => r.milestone === k)
      return [k, { label: MS_LABEL[k], planned: dayOf(m?.planned_date), actual: dayOf(m?.actual_date) }]
    }),
  ) as Record<Milestone, { label: string; planned: string | null; actual: string | null }>
}

function phaseOf(h: Row, ms: ReturnType<typeof milestonesOf>, today: string): Phase {
  const at = (k: Milestone) => ms[k].actual ?? ms[k].planned
  if (h.lifecycle_status === "in_service" || h.actual_delivery_date) return "delivered"
  if (at("launch") && at("launch")! <= today) return "outfitting"
  if (at("block_erection_start") && at("block_erection_start")! <= today) return "erection"
  if (at("construction_start") && at("construction_start")! <= today) return "block"
  return h.lifecycle_status === "planning" ? "planning" : "engineering"
}

function progressOf(phase: Phase, ms: ReturnType<typeof milestonesOf>, delivery: string, today: string) {
  if (phase === "delivered") return 100
  const start = ms.construction_start.actual ?? ms.construction_start.planned
  if (!start || today < start) return 0
  return Math.max(0, Math.min(99, Math.round((days(start, today) / Math.max(1, days(start, delivery))) * 100)))
}

function blocksOf(w: World, hullId: string, today: string) {
  const counts = { total: 0, notStarted: 0, fabricating: 0, fabricated: 0, installing: 0, installed: 0 }
  for (const b of w.block.values() as Iterable<Row>) {
    if (b.hull_id !== hullId) continue
    const win = w.window.get(b.block_id)
    if (!win) continue
    counts.total++
    const d = (v: unknown) => dayOf(v) ?? "9999-12-31"
    if (d(win.install_finish) <= today) counts.installed++
    else if (d(win.install_start) <= today) counts.installing++
    else if (d(win.fabrication_finish) <= today) counts.fabricated++
    else if (d(win.fabrication_start) <= today) counts.fabricating++
    else counts.notStarted++
  }
  return counts
}

// 설계변경을 한 번씩 검토해 호선별 영향으로 펼친다 (도면만 바뀌는 변경 · 철회 · 완료는 뺀다)
function changeImpacts(w: World, onto: Ontology | null) {
  const out: { id: string; title: string; decided: boolean; option: string | null; deadline: string | null; hulls: Row[] }[] = []
  for (const c of w.changes) {
    if (c.status === "withdrawn" || c.status === "done") continue
    try {
      const r = reviewChange(w, c.change_id, { ontology: onto })
      if (r.designOnly) continue
      out.push({
        id: c.change_id,
        title: c.title,
        decided: !!r.decision,
        option: r.decision?.label ?? r.recommended?.label ?? null,
        deadline: r.decision ? null : (r.recommended?.deadline?.date ?? null),
        hulls: r.strip,
      })
    } catch {
      // 한 건이 계산되지 않아도 일정 화면은 보여 준다
    }
  }
  return out
}

export function hullSchedule(w: World, tables: Tables, onto: Ontology | null) {
  const today = w.today
  const impacts = changeImpacts(w, onto)
  const hulls = w.hulls.map((h: Row) => {
    const ms = milestonesOf(tables, h.hull_id)
    const planned = dayOf(h.planned_delivery_date)!
    const delivery = dayOf(h.actual_delivery_date) ?? planned
    const phase = phaseOf(h, ms, today)
    const changes = impacts
      .map((c) => {
        const s = c.hulls.find((x: Row) => x.hullId === h.hull_id)
        if (!s || s.treatment === "not_applicable") return null
        return {
          id: c.id,
          title: c.title,
          decided: c.decided,
          option: c.option,
          deadline: c.deadline,
          treatment: TREAT[s.treatment] ?? s.treatment,
          units: s.units,
          newDelivery: dayOf(s.newDelivery),
          deliveryDelay: Number(s.deliveryDelay ?? 0),
          overrun: Number(s.overrun ?? 0),
        }
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
    // 결정한 변경이 인도일을 미루면 그 날 (가장 늦은 것). 결정 대기 변경은 아직 일정에 넣지 않는다
    const shifted = changes.filter((c) => c.decided && c.deliveryDelay > 0).map((c) => c.newDelivery!).sort().at(-1) ?? null
    const finalDelivery = shifted && shifted > delivery ? shifted : delivery
    // 다음 마일스톤: 인도는 결정한 변경으로 밀린 날을 쓴다 (호선 카드의 인도일과 같게)
    const next =
      MILESTONES.map((k) => ({ key: k, label: MS_LABEL[k], date: k === "delivery" ? finalDelivery : (ms[k].actual ?? ms[k].planned) })).find((m) => m.date && m.date > today) ?? null
    return {
      id: h.hull_id as string,
      seq: h.hull_seq as number,
      name: `${h.hull_seq}호선`,
      lifecycle: { code: h.lifecycle_status, label: w.label("lifecycle_status", h.lifecycle_status) },
      phase: { code: phase, label: PHASES[phase] },
      inProduction: IN_PRODUCTION.includes(phase),
      progress: progressOf(phase, ms, delivery, today),
      milestones: ms,
      plannedDelivery: planned,
      actualDelivery: dayOf(h.actual_delivery_date),
      delivery: finalDelivery,
      deliveryShift: shifted && shifted > delivery ? days(delivery, shifted) : 0,
      contractDelivery: dayOf(w.contract.get(h.hull_id)?.contract_delivery_date),
      next,
      blocks: blocksOf(w, h.hull_id, today),
      changes,
    }
  })
  return { today, hulls, inProduction: hulls.filter((h) => h.inProduction).map((h) => h.name) }
}

// 첫 화면 프로젝트 한 줄: 호선 범위 · 건조 단계 · 평균 진척(일정 기준) · 결정 대기 · 가장 가까운 결정 기한
export function datasetSummary(w: World, tables: Tables, changes: { deadline: { date: string; dday: number } | null; decided: unknown; designOnly: boolean; error: unknown }[]) {
  const today = w.today
  const rows = w.hulls.map((h: Row) => {
    const ms = milestonesOf(tables, h.hull_id)
    const phase = phaseOf(h, ms, today)
    return { phase, progress: progressOf(phase, ms, dayOf(h.actual_delivery_date) ?? dayOf(h.planned_delivery_date)!, today) }
  })
  const open = changes.filter((c) => c.deadline && !c.decided && !c.designOnly && !c.error)
  const nearest = open.map((c) => c.deadline!).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null
  const first = w.hulls[0]?.hull_id ?? ""
  const last = w.hulls.at(-1)?.hull_id ?? ""
  const prefix = first.replace(/\d+$/, "")
  const stage = rows.every((r) => r.phase === "delivered") ? "인도 · 보증" : rows.some((r) => IN_PRODUCTION.includes(r.phase)) ? "건조 중" : "설계"
  return {
    hullRange: first && last ? `${first}~${last.startsWith(prefix) ? last.slice(prefix.length) : last}` : "",
    stage,
    inProduction: rows.filter((r) => IN_PRODUCTION.includes(r.phase)).length,
    progress: Math.round(rows.reduce((a, r) => a + r.progress, 0) / Math.max(1, rows.length)),
    open: open.length,
    nearestDeadline: nearest,
  }
}
