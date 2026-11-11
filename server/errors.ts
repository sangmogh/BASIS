// AI 호출 실패를 화면에 보여줄 한국어 문장으로 (화면은 규칙 · 정해진 틀로 대신한다)
import Anthropic from "@anthropic-ai/sdk"
import { LlmError } from "./llm.js"

export function aiErrorMessage(error: unknown) {
  if (error instanceof LlmError && error.status) {
    if (error.status === 401 || error.status === 403 || /api key/i.test(error.message)) return "AI 키가 맞지 않아요"
    if (error.status === 429) return "AI 요청이 몰리거나 사용량을 넘었어요. 잠시 뒤에 다시 해요"
    if (error.status === 402) return "AI 사용 한도를 다 썼어요 (게이트웨이 월 한도)"
    return `AI 호출 실패 (${error.status})`
  }
  const noKey = error instanceof Error && /authentication method|api.?key/i.test(error.message)
  return error instanceof Anthropic.AuthenticationError || noKey
    ? "AI 키가 설정되지 않았어요"
    : error instanceof Anthropic.RateLimitError
      ? "AI 요청이 몰려 잠시 뒤에 다시 해요"
      : error instanceof Anthropic.APIError
        ? error.status === 402
          ? "AI 사용 한도를 다 썼어요 (게이트웨이 월 한도)"
          : `AI 호출 실패 (${error.status})`
        : error instanceof Error
          ? error.message
          : "AI 호출 실패"
}
