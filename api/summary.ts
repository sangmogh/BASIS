// Vercel 함수: POST /api/summary  { summary: { code, title, facts } } → { summary, provider } (AI ④ 결정 요약)
// 사실에 없는 숫자가 나오면 422, 호출 실패는 502. 화면은 정해진 틀의 요약을 그대로 쓴다
import { aiErrorMessage } from "../server/errors.js"
import { countAi, overQuota } from "../server/quota.js"
import { SummaryRejected, parseSummaryInput, summarizeDecision } from "../server/summarize.js"

export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  let input
  try {
    input = parseSummaryInput(await request.json())
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "잘못된 요청이에요" }, { status: 400 })
  }
  const over = await overQuota(request)
  if (over) return over
  try {
    const result = await summarizeDecision(input)
    await countAi(request)
    return Response.json(result)
  } catch (error) {
    return Response.json({ error: aiErrorMessage(error) }, { status: error instanceof SummaryRejected ? 422 : 502 })
  }
}
