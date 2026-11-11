// Vercel 함수: POST /api/ai  { change, cases?, today? } → AI 분석 결과 (cases: 진행 보드에서 쌓인 사례, today: 화면의 오늘)
// 실패하면 502를 돌려주고, 화면은 규칙 대체 결과를 쓴다
import { analyzeChange, parseChange, parseLearned, parseToday } from "../server/analyze.js"
import { aiErrorMessage } from "../server/errors.js"
import { countAi, overQuota } from "../server/quota.js"

export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  let change, learned, today
  try {
    const body = await request.json()
    change = parseChange(body)
    learned = parseLearned(body)
    today = parseToday(body)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "잘못된 요청이에요" }, { status: 400 })
  }
  const over = await overQuota(request)
  if (over) return over
  try {
    // 회의 중 실시간 호출은 응답 시간을 위해 낮은 effort (미리 계산은 medium)
    const analysis = await analyzeChange(change, undefined, "low", learned, today)
    await countAi(request)
    return Response.json(analysis)
  } catch (error) {
    return Response.json({ error: aiErrorMessage(error) }, { status: 502 })
  }
}
