// 부품 상태: MES 실적(제작 · 설치)으로 생산 전 / 제작 완료 / 설치 완료 수량을 센다.
// 실적이 없는데 블록 일정상 끝났어야 하면 일정으로 짐작하고 '가정'. 결정일이 오늘보다 뒤면 그 사이는 계획대로 진행한다고 본다('잠정')
import { addDays, diffDays, dayOf, weakest, type Certainty, type Row } from "./basics.js"
import type { World } from "./world.js"

export type OccState = {
  occurrence: Row
  part: Row
  hullId: string
  blockId: string
  builderId: string | null
  qty: number
  notStarted: number
  fabricated: number // 제작은 끝났고 아직 설치 전
  installed: number
  fabStart: string
  fabFinish: string
  installStart: string
  installFinish: string
  fabGroup: string | null
  installGroup: string | null
  certainty: Certainty
  source: string
}

const share = (qty: number, start: string, finish: string, day: string) => {
  if (dayOf(finish) <= day) return qty
  if (dayOf(start) > day) return 0
  const span = Math.max(1, diffDays(start, finish))
  return Math.floor((qty * diffDays(start, day)) / span)
}

export function occurrenceState(w: World, occ: Row, day = w.today): OccState {
  const part = w.part.get(occ.part_id)!
  const block = w.block.get(occ.block_id)
  const win = w.window.get(occ.block_id)
  const item = w.itemOfOccurrence.get(occ.occurrence_id)
  const ops = item ? (w.operationsOfItem.get(item.production_item_id) ?? []) : []
  const fab = ops.find((o) => o.operation_type === "fabrication")
  const ins = ops.find((o) => o.operation_type === "installation")
  const qty = Number(occ.required_qty)
  const fabStart = fab?.planned_start ?? win?.fabrication_start ?? w.today
  const fabFinish = fab?.planned_finish ?? win?.fabrication_finish ?? addDays(fabStart, 1)
  const installStart = ins?.planned_start ?? win?.install_start ?? fabFinish
  const installFinish = ins?.planned_finish ?? win?.install_finish ?? addDays(installStart, 1)

  const events = item ? (w.eventsOfItem.get(item.production_item_id) ?? []) : []
  let fabricatedQty = Math.min(qty, events.filter((e) => e.event_kind === "fabricated").reduce((a, e) => a + Number(e.qty), 0))
  let installedQty = Math.min(fabricatedQty, events.filter((e) => e.event_kind === "installed").reduce((a, e) => a + Number(e.qty), 0))
  let certainty: Certainty = "confirmed"
  let source = "MES 실적"
  if (!events.length && dayOf(fabFinish) <= w.today) {
    // 실적이 없는데 일정상 제작이 끝났어야 함 → 일정으로 짐작
    fabricatedQty = qty
    installedQty = dayOf(installFinish) <= w.today ? qty : 0
    certainty = "assumption"
    source = "블록 일정으로 짐작 (MES 실적 없음)"
  }
  if (day > w.today) {
    // 결정일까지 계획대로 진행된다고 보고 더한다
    const f = Math.max(fabricatedQty, share(qty, fabStart, fabFinish, day))
    const i = Math.min(f, Math.max(installedQty, share(qty, installStart, installFinish, day)))
    if (f !== fabricatedQty || i !== installedQty) {
      certainty = weakest(certainty, "provisional")
      source = `${source} + ${day}까지 계획대로 진행 가정`
    }
    fabricatedQty = f
    installedQty = i
  }
  return {
    occurrence: occ,
    part,
    hullId: occ.hull_id,
    blockId: occ.block_id,
    builderId: block?.builder_id ?? null,
    qty,
    notStarted: qty - fabricatedQty,
    fabricated: fabricatedQty - installedQty,
    installed: installedQty,
    fabStart: dayOf(fabStart),
    fabFinish: dayOf(fabFinish),
    installStart: dayOf(installStart),
    installFinish: dayOf(installFinish),
    fabGroup: fab?.resource_group ?? null,
    installGroup: ins?.resource_group ?? null,
    certainty,
    source,
  }
}

// 사례의 '언제(반영 시점)'와 같은 말로: 가장 앞선 호선 기준
export function timingOf(states: OccState[]) {
  if (states.some((s) => s.installed > 0)) return "after_erection"
  if (states.some((s) => s.fabricated > 0 && s.notStarted === 0)) return "block_complete"
  if (states.some((s) => s.fabricated > 0)) return "block_fabrication"
  return "before_production"
}
