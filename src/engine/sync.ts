// ERP · MES 갱신 (기능명세 2-1-b): 회의 전에 자재 조달 기간이나 블록 일정이 바뀌면
// 열린 설계변경의 결정 마감을 다시 계산해, 바뀐 것만 알린다.
import type { Change, Series, SyncEvent } from "../data/types.js"
import { METHOD_LABEL, meetingDeadline } from "./methods.js"
import type { Context } from "./simulate.js"

export type DeadlineShift = {
  code: string
  title: string
  from: string
  to: string
  fromTeams: string
  toTeams: string
  fromMethod?: string // 추천 대응안이 바뀌었으면 "A 일반 조달" → "B 긴급 조달"
  toMethod?: string
  reasons: string[] // 이 변경에 닿은 갱신 (출처: 내용)
}

function touches(event: SyncEvent, change: Change) {
  if (event.material) return change.material?.code === event.material.code
  if (event.block) return change.block === event.block.block
  return false
}

export function applySync(ctx: Context, changes: Change[], events: SyncEvent[]) {
  const { series, next } = apply(ctx, changes, events)
  // 회의를 기다리는 변경만 다시 본다 (결정 마감 날짜나 기준 팀이 바뀐 것)
  const after: Context = { ...ctx, series }
  const shifts: DeadlineShift[] = []
  changes.forEach((before) => {
    if (before.status !== "review" || before.boundary !== "production") return
    const now = next.find((c) => c.code === before.code)!
    const a = meetingDeadline(ctx, before)
    const b = meetingDeadline(after, now)
    if (a.date === b.date && a.teams === b.teams && a.method === b.method) return
    // 이유: 혼자서도 이 마감을 바꾸는 갱신 (그런 게 없으면 이 변경에 닿은 갱신 전부)
    const touching = events.filter((e) => touches(e, before))
    const moving = touching.filter((e) => {
      const one = apply(ctx, changes, [e])
      const d = meetingDeadline({ ...ctx, series: one.series }, one.next.find((c) => c.code === before.code)!)
      return d.date !== a.date || d.teams !== a.teams
    })
    shifts.push({
      code: before.code,
      title: before.title,
      from: a.date,
      to: b.date,
      fromTeams: a.teams,
      toTeams: b.teams,
      ...(a.method !== b.method ? { fromMethod: `${a.method} ${METHOD_LABEL[a.method]}`, toMethod: `${b.method} ${METHOD_LABEL[b.method]}` } : {}),
      reasons: (moving.length ? moving : touching).map((e) => `${e.source}: ${e.title}`),
    })
  })
  return { series, changes: next, shifts }
}

function apply(ctx: Context, changes: Change[], events: SyncEvent[]) {
  let series: Series = ctx.series
  let next = changes
  events.forEach((e) => {
    if (e.material) {
      const m = e.material
      next = next.map((c) => (c.material?.code === m.code ? { ...c, material: { ...c.material, leadTime: m.leadTime } } : c))
    }
    if (e.block) {
      const { vessel, block, ...dates } = e.block
      series = {
        ...series,
        vessels: series.vessels.map((v) =>
          v.id === vessel && v.blocks[block] ? { ...v, blocks: { ...v.blocks, [block]: { ...v.blocks[block], ...dates } } } : v,
        ),
      }
    }
  })
  return { series, next }
}
