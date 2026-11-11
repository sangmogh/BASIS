// Vercel 함수: 연동 수신함
//   POST /api/events  { kind: "plm", change } | { kind: "sync", event }  ← PLM · ERP · MES가 보낸다 (헤더 x-basis-token)
//   GET  /api/events  → { storage, events }                              ← 대시보드가 가져간다
//   DELETE /api/events                                                    ← 수신함 비우기 (시연 다시 하기, POST와 같은 토큰)
// 토큰(BASIS_EVENTS_TOKEN)이 정해져 있으면 POST에 같은 값이 있어야 한다. Vercel에서는 토큰과 서버 저장소(KV)가 둘 다 있어야 받는다
import { clearInbox, inbox, isInvalid, parseIncoming, receive } from "../server/events.js"
import { storageKind } from "../server/kv.js"

export async function GET(): Promise<Response> {
  try {
    return Response.json({ storage: storageKind(), events: await inbox() })
  } catch (error) {
    return Response.json({ storage: storageKind(), events: [], error: error instanceof Error ? error.message : "수신함을 못 읽었어요" }, { status: 502 })
  }
}

// 쓰기 요청 확인: 토큰 · 저장소가 없으면 받지 않는다 (통과하면 null)
function refuse(request: Request): Response | null {
  const secret = process.env.BASIS_EVENTS_TOKEN
  if (process.env.VERCEL && !secret) return Response.json({ error: "연동 토큰(BASIS_EVENTS_TOKEN)이 설정되지 않아 받지 않아요" }, { status: 503 })
  if (storageKind() === "none") return Response.json({ error: "서버 저장소(KV)가 연결되지 않아 받지 않아요" }, { status: 503 })
  if (secret && request.headers.get("x-basis-token") !== secret) return Response.json({ error: "연동 토큰이 맞지 않아요" }, { status: 401 })
  return null
}

export async function DELETE(request: Request): Promise<Response> {
  const refused = refuse(request)
  if (refused) return refused
  await clearInbox()
  return Response.json({ cleared: true })
}

export async function POST(request: Request): Promise<Response> {
  const refused = refuse(request)
  if (refused) return refused
  let event
  try {
    event = parseIncoming(await request.json())
  } catch (error) {
    return Response.json({ error: isInvalid(error) ? (error as Error).message : "JSON 형식이 아니에요" }, { status: 400 })
  }
  try {
    const result = await receive(event)
    return Response.json({ id: event.id, ...result, ...(event.kind === "plm" ? { boundary: event.change.boundary } : {}) }, { status: result.duplicate ? 200 : 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "저장하지 못했어요" }, { status: 502 })
  }
}
