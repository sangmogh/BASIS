// Vercel 함수: 공유 방 상태
//   GET    /api/state?room=이름                         → { storage, version, updatedAt, state }
//   PUT    /api/state?room=이름  { baseVersion, state }  → 새 버전 (그사이 다른 화면이 먼저 썼으면 409 + 지금 상태)
//   DELETE /api/state?room=이름                         → 방 비우기 (?reset)
// 서버 저장소가 없으면(Vercel에 KV 미연결) storage: "none" — 화면은 이 브라우저에만 저장한다
import { storageKind } from "../server/kv.js"
import { MAX_STATE, clearRoom, looksLikeState, readRoom, roomName, writeRoom } from "../server/rooms.js"

const roomOf = (request: Request) => roomName(new URL(request.url).searchParams.get("room"))
const noRoom = () => Response.json({ error: "방 이름은 영문 소문자 · 숫자 · - 3~32자예요" }, { status: 400 })
const noStorage = () => Response.json({ storage: "none", error: "서버 저장소(KV)가 연결되지 않아 공유하지 않아요" }, { status: 503 })

export async function GET(request: Request): Promise<Response> {
  const room = roomOf(request)
  if (!room) return noRoom()
  if (storageKind() === "none") return Response.json({ storage: "none", version: 0, updatedAt: "", state: null })
  return Response.json({ storage: storageKind(), ...(await readRoom(room)) })
}

export async function PUT(request: Request): Promise<Response> {
  const room = roomOf(request)
  if (!room) return noRoom()
  if (storageKind() === "none") return noStorage()
  const text = await request.text()
  if (text.length > MAX_STATE) return Response.json({ error: "상태가 너무 커요" }, { status: 413 })
  let body: { baseVersion?: unknown; state?: unknown }
  try {
    body = JSON.parse(text)
  } catch {
    return Response.json({ error: "JSON 형식이 아니에요" }, { status: 400 })
  }
  if (!Number.isInteger(body.baseVersion) || !looksLikeState(body.state)) return Response.json({ error: "상태 형식이 맞지 않아요" }, { status: 400 })
  const result = await writeRoom(room, body.baseVersion as number, body.state)
  return Response.json(result.room, { status: result.ok ? 200 : 409 })
}

export async function DELETE(request: Request): Promise<Response> {
  const room = roomOf(request)
  if (!room) return noRoom()
  if (storageKind() === "none") return noStorage()
  await clearRoom(room)
  return Response.json({ cleared: true })
}
