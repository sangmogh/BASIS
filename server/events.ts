// 연동 수신함 (기능명세 0-1 · 1장 표): PLM · ERP · MES가 보낸 이벤트를 받아 두면 대시보드가 가져간다.
// PLM 변경 요청(ECR)은 영향 범위를 코드로 분류해서 넣고, ERP · MES 갱신은 형태만 확인해 넣는다.
import { seriesData } from "../src/data/index.js"
import type { BlockSchedule, Change, InboxEvent, Material, SyncEvent } from "../src/data/types.js"
import { classifyBoundary } from "../src/engine/index.js"
import { listAll, listClear, listPush, storageKind } from "./kv.js"

const KEY = "basis:events"
const MAX = 200
const REASONS = ["선주 요청", "선급·규정", "내부 오류", "개선"]
const DATE = /^\d{4}-\d{2}-\d{2}$/

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message)
}
const text = (v: unknown, name: string, max = 200, optional = false) => {
  if (v == null && optional) return undefined
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(`${name}이(가) 맞지 않아요`)
  return (v as string).trim()
}
const knownBlock = (block: string) => seriesData.vessels.some((v) => v.blocks[block]) // 한 척이라도 그 블록이 있으면 (데이터셋마다 블록 구성이 다를 수 있음)

function parseMaterial(m: unknown): Material | undefined {
  if (m == null) return undefined
  const x = m as Material
  const ok = Number.isInteger(x.stock) && x.stock >= 0 && Number.isInteger(x.leadTime) && x.leadTime >= 0 && x.leadTime <= 365
  if (!ok) fail("자재 재고 · 조달 기간이 맞지 않아요")
  return { item: text(x.item, "자재 품목", 80)!, code: text(x.code, "자재 코드", 40)!, stock: x.stock, leadTime: x.leadTime }
}

// PLM 변경 요청 → 설계변경 한 건 (필요한 칸만 골라 받는다)
export function parsePlm(input: unknown): Change {
  const c = (input ?? {}) as Record<string, unknown>
  const code = text(c.code, "변경 번호", 10)!
  if (!/^DC-\d{3}$/.test(code)) fail("변경 번호는 DC-000 형식이에요")
  const block = text(c.block, "블록", 10)!
  if (!knownBlock(block)) fail(`모르는 블록이에요: ${block}`)
  if (!REASONS.includes(c.reason as string)) fail(`사유는 ${REASONS.join(" / ")} 중 하나예요`)
  const receivedOn = text(c.receivedOn, "접수일", 10)!
  if (!DATE.test(receivedOn)) fail("접수일은 YYYY-MM-DD 형식이에요")
  const bom = c.bom == null ? undefined : c.bom
  if (bom !== undefined && (!Array.isArray(bom) || bom.length > 20 || !bom.every((b) => (b?.op === "+" || b?.op === "-") && typeof b.item === "string" && typeof b.qty === "string")))
    fail("부품 목록(BOM) 형식이 맞지 않아요")
  const d = c.drawing as Change["drawing"] | undefined
  const change: Change = {
    code,
    ecr: text(c.ecr, "ECR 번호", 30, true),
    title: text(c.title, "제목", 80)!,
    reason: c.reason as Change["reason"],
    requester: text(c.requester, "요청 부서", 30)!,
    receivedOn,
    auto: true,
    isNew: true,
    status: "review",
    boundary: "production",
    block,
    member: text(c.member, "부재", 60, true),
    v1: text(c.v1, "변경 전", 80, true),
    v2: text(c.v2, "변경 후", 80, true),
    ecrText: text(c.ecrText, "변경 요청 글", 1500, true),
    drawing: d ? { no: text(d.no, "도면 번호", 40)!, from: text(d.from, "개정 전", 20)!, to: text(d.to, "개정 후", 20)!, note: text(d.note, "개정 내용", 80)! } : undefined,
    bom: bom as Change["bom"],
    material: parseMaterial(c.material),
  }
  const { boundary } = classifyBoundary(change)
  return { ...change, boundary, status: boundary === "design" ? "notified" : "review" }
}

// ERP · MES 갱신
export function parseSync(input: unknown): SyncEvent {
  const e = (input ?? {}) as Record<string, unknown>
  const id = text(e.id, "이벤트 id", 40)!
  if (e.source !== "ERP" && e.source !== "MES") fail("출처는 ERP 또는 MES예요")
  const title = text(e.title, "내용", 120)!
  if (e.source === "ERP") {
    const m = (e.material ?? {}) as { code?: unknown; leadTime?: unknown }
    if (!Number.isInteger(m.leadTime) || (m.leadTime as number) < 0 || (m.leadTime as number) > 365) fail("ERP 갱신에는 자재 코드와 조달 기간(일)이 필요해요")
    return { id, source: "ERP", title, material: { code: text(m.code, "자재 코드", 40)!, leadTime: m.leadTime as number } }
  }
  const b = (e.block ?? {}) as Record<string, unknown>
  const vessel = seriesData.vessels.find((v) => v.id === b.vessel)
  const block = text(b.block, "블록", 10)!
  if (!vessel || !vessel.blocks[block]) fail("MES 갱신의 호선 · 블록을 모르겠어요")
  const dates: Partial<BlockSchedule> = {}
  for (const k of ["start", "end", "mount"] as const)
    if (b[k] != null) {
      if (typeof b[k] !== "string" || !DATE.test(b[k] as string)) fail("블록 날짜는 YYYY-MM-DD 형식이에요")
      dates[k] = b[k] as string
    }
  if (!Object.keys(dates).length) fail("바뀐 블록 날짜(start · end · mount)가 없어요")
  return { id, source: "MES", title, block: { vessel: vessel!.id, block, ...dates } }
}

export function parseIncoming(body: unknown): InboxEvent {
  if (JSON.stringify(body ?? null).length > 20000) fail("이벤트가 너무 커요")
  const b = (body ?? {}) as { kind?: unknown; change?: unknown; event?: unknown }
  const receivedAt = new Date().toISOString()
  if (b.kind === "plm") {
    const change = parsePlm(b.change)
    return { id: `plm:${change.code}`, receivedAt, kind: "plm", change }
  }
  if (b.kind === "sync") {
    const event = parseSync(b.event)
    return { id: `sync:${event.id}`, receivedAt, kind: "sync", event }
  }
  return fail('kind는 "plm" 또는 "sync"예요')
}

export const isInvalid = (error: unknown) => error instanceof Invalid

export async function inbox() {
  return storageKind() === "none" ? [] : listAll<InboxEvent>(KEY)
}

// 같은 id는 한 번만 받는다
export async function receive(event: InboxEvent) {
  const list = await inbox()
  if (list.some((x) => x.id === event.id)) return { duplicate: true }
  await listPush(KEY, event, MAX)
  return { duplicate: false }
}

// 수신함 비우기 (시연을 처음부터 다시 할 때)
export const clearInbox = () => listClear(KEY)
