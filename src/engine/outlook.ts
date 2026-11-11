// 호선 · 블록 하나에서 본 설계변경: "다음 문턱(착수 · 제작 완료 · 탑재) 전에 반영돼야 손해가 안 커진다. 그러려면 언제까지 결정해야 하나"
// 검토 결론과 같은 엔진 계산(simulate · teamCheck)을 호선 하나로 잘라 본다.
import type { BlockSchedule, Change } from "../data/types.js"
import { addDays } from "./dates.js"
import { type Context, type SimOptions, type SimRow, earliestFeasible, simulate, targetRange, teamCheck } from "./simulate.js"

export type Threshold = { event: "착수" | "제작 완료" | "탑재"; date: string }

export type BlockOutlook = {
  stage: "착수 전" | "제작 중" | "제작 완료 · 탑재 대기" | "탑재 완료"
  missed: Threshold[] // 아직 안 지났지만 팀이 그 전에 반영을 못 맞추는 문턱
  next?: {
    threshold: Threshold
    keep: SimRow // 문턱 전에 반영하면
    after: SimRow // 문턱을 넘기면
    decideBy: string // 문턱 전에 반영하려면 늦어도 결정할 날
    teams: string
  }
  final?: SimRow // 더 나빠질 문턱이 없음 (이미 탑재) — 지금 반영해도 이 처리
}

export function stageOf(block: BlockSchedule, today: string): BlockOutlook["stage"] {
  return today < block.start ? "착수 전" : today <= block.end ? "제작 중" : today <= block.mount ? "제작 완료 · 탑재 대기" : "탑재 완료"
}

export function blockOutlook(ctx: Context, change: Change, vesselId: string, opts: SimOptions = {}): BlockOutlook | null {
  const vessel = ctx.series.vessels.find((v) => v.id === vesselId)
  const block = vessel?.blocks[change.block]
  if (!vessel || !block || vessel.status === "in_service") return null
  const today = opts.today ?? ctx.series.today
  const { min } = targetRange(ctx, change, opts)
  const row = (target: string) => simulate(ctx, change, target, opts).rows.find((r) => r.vessel.id === vesselId)!
  const thresholds: Threshold[] = [
    { event: "착수" as const, date: block.start },
    { event: "제작 완료" as const, date: block.end },
    { event: "탑재" as const, date: block.mount },
  ].filter((t) => t.date >= today)
  const missed: Threshold[] = []
  for (const t of thresholds) {
    const check = t.date >= min ? teamCheck(ctx, change, t.date, opts) : null
    if (!check?.ok) {
      missed.push(t)
      continue
    }
    return {
      stage: stageOf(block, today),
      missed,
      next: { threshold: t, keep: row(t.date), after: row(addDays(t.date, 1)), decideBy: check.decideBy, teams: check.decideTeams },
    }
  }
  // 더 지킬 문턱이 없으면: 팀이 맞출 수 있는 가장 빠른 날에 반영할 때의 처리
  return { stage: stageOf(block, today), missed, final: row(earliestFeasible(ctx, change, opts) ?? min) }
}
