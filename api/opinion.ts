// Vercel 함수: POST /api/opinion  { opinion: { code, title, priority, recommended, methods, cases } } → { opinions, provider }
// AI 대안 검토 의견. 사실에 없는 숫자 · 빠진 안이 있으면 422, 호출 실패는 502. 화면은 규칙 의견을 그대로 쓴다
import { aiErrorMessage } from "../server/errors.js"
import { OpinionRejected, parseOpinionInput, reviewOptions } from "../server/opinion.js"
import { countAi, overQuota } from "../server/quota.js"

export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  let input
  try {
    input = parseOpinionInput(await request.json())
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "잘못된 요청이에요" }, { status: 400 })
  }
  const over = await overQuota(request)
  if (over) return over
  try {
    const result = await reviewOptions(input)
    await countAi(request)
    return Response.json(result)
  } catch (error) {
    return Response.json({ error: aiErrorMessage(error) }, { status: error instanceof OpinionRejected ? 422 : 502 })
  }
}
