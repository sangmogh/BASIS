// 공개 주소에서 AI 사용량(학교 키 · 구입한 키)이 새지 않게 IP마다 10분에 30번까지만 부른다.
// 성공한 호출만 센다. 세는 데 실패하면 막지 않는다 (시연 중에 AI가 멈추는 것보다 낫다)
import { counterAdd, counterGet } from "./kv.js"

export const AI_LIMIT = 30
const WINDOW_SECONDS = 600

const keyOf = (request: Request) => {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local"
  return `basis:ai-quota:${ip}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`
}

// 넘었으면 429 응답, 아니면 null
export async function overQuota(request: Request): Promise<Response | null> {
  try {
    if ((await counterGet(keyOf(request))) < AI_LIMIT) return null
  } catch {
    return null
  }
  const minutes = Math.ceil((WINDOW_SECONDS - ((Date.now() / 1000) % WINDOW_SECONDS)) / 60)
  return Response.json({ error: `AI 요청이 너무 많아요. ${minutes}분 뒤에 다시 해요` }, { status: 429 })
}

export async function countAi(request: Request) {
  try {
    await counterAdd(keyOf(request), WINDOW_SECONDS)
  } catch {
    // 못 세도 응답은 그대로 보낸다
  }
}
