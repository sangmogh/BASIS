// 공유 방: 회의 참석자 화면들이 같은 상태(결정 · 진행 보드 · 인도일 · 이력 · 쌓인 실적)를 보게 한다 (기능명세 0-1 "누구나 조회 · 입력").
// 방 하나 = 상태 한 덩어리 + 버전. 쓸 때는 읽었던 버전을 같이 보내고, 그사이 다른 화면이 먼저 썼으면 거절(409)해 덮어쓰지 않는다.
import { kvDel, kvGet, kvSet } from "./kv.js"

export type Room = { version: number; updatedAt: string; state: unknown }

export const MAX_STATE = 900_000 // 저장소 한 번 요청 한도(1MB) 안
const key = (room: string) => `basis:room:${room}`

export const roomName = (value: string | null) => (value && /^[a-z0-9-]{3,32}$/.test(value) ? value : null)

export async function readRoom(room: string): Promise<Room> {
  const raw = await kvGet(key(room))
  return raw ? (JSON.parse(raw) as Room) : { version: 0, updatedAt: "", state: null }
}

export async function writeRoom(room: string, baseVersion: number, state: unknown) {
  const current = await readRoom(room)
  if (current.version !== baseVersion) return { ok: false as const, room: current }
  const next: Room = { version: current.version + 1, updatedAt: new Date().toISOString(), state }
  await kvSet(key(room), JSON.stringify(next))
  return { ok: true as const, room: next }
}

export const clearRoom = (room: string) => kvDel(key(room))

// 대시보드 상태처럼 생겼는지만 본다 (화면이 만든 것)
export const looksLikeState = (s: unknown) =>
  typeof s === "object" && s !== null && Array.isArray((s as { changes?: unknown }).changes) && typeof (s as { series?: unknown }).series === "object"
