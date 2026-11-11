// AI 호출은 여기 한 곳에서 한다 (서버에서만. 키는 브라우저로 나가지 않는다).
// Gemini 키(GEMINI_API_KEY)가 있으면 Gemini, 없으면 Claude(Anthropic 키 또는 학교 BAZE 게이트웨이)를 쓴다.
// 두 경우 모두 JSON 스키마에 맞춘 답을 받아 그대로 돌려주고, 검증은 부르는 쪽(validateAnalysis 등)이 한다.
import Anthropic from "@anthropic-ai/sdk"

export type Effort = "low" | "medium" | "high"
export type Provider = "gemini" | "claude"
export type JsonRequest = {
  system: string // 바뀌지 않는 지시문 (사례 목록 등)
  user: string
  schema: object
  effort: Effort
  maxTokens: number
}
export type JsonResult = { json: unknown; provider: Provider }
export type Generate = (request: JsonRequest) => Promise<JsonResult>

// CLAUDE_MODEL로 바꿀 수 있다 (예: claude-haiku-5-5 — BAZE 크레딧을 아낄 때). 없으면 claude-opus-5-5
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5"
export const geminiModel = () => process.env.GEMINI_MODEL || "gemini-3.8-flash"
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
export const providerOf = (): Provider => (geminiKey() ? "gemini" : "claude")

// 호출 실패 (화면에 보여줄 한국어 문장은 errors.ts가 만든다)
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export const generateJson: Generate = (request) => (providerOf() === "gemini" ? gemini(request) : claude(request))

// 코드 블록(```json)으로 감싸 보내는 경우도 받는다
function parseJson(text: string) {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "")
  try {
    return JSON.parse(body)
  } catch {
    throw new LlmError("AI 응답이 JSON 형식이 아니에요")
  }
}

const THINKING: Record<Effort, string> = { low: "LOW", medium: "MEDIUM", high: "HIGH" }

// Gemini generateContent (REST). 출력 형식은 새 필드(responseFormat)로 요청하고,
// 요청 형식 때문에 400으로 거절되면 예전 필드(responseMimeType + responseJsonSchema)로 다시 시도한다
async function gemini(request: JsonRequest): Promise<JsonResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`
  const base = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.user }] }],
  }
  const config = { maxOutputTokens: request.maxTokens, thinkingConfig: { thinkingLevel: THINKING[request.effort] } }
  const attempts = [
    { ...config, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: request.schema } } },
    { ...config, responseMimeType: "application/json", responseJsonSchema: request.schema },
    { maxOutputTokens: request.maxTokens, responseMimeType: "application/json", responseJsonSchema: request.schema }, // 생각 설정을 못 받는 모델
  ]
  let last: LlmError | null = null
  for (const generationConfig of attempts) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey()! },
      body: JSON.stringify({ ...base, generationConfig }),
    })
    const body = (await response.json().catch(() => ({}))) as GeminiResponse
    if (!response.ok) {
      last = new LlmError(body.error?.message ?? `Gemini 호출 실패 (${response.status})`, response.status)
      // 키가 틀린 게 아니라 요청 형식 문제일 때만 예전 필드로 다시
      if (response.status === 400 && !/api key/i.test(last.message)) continue
      throw last
    }
    if (body.promptFeedback?.blockReason) throw new LlmError("AI가 이 요청을 처리하지 않았어요")
    const candidate = body.candidates?.[0]
    if (candidate?.finishReason === "MAX_TOKENS") throw new LlmError("AI 응답이 길이 제한에 걸렸어요")
    if (candidate?.finishReason && candidate.finishReason !== "STOP") throw new LlmError("AI가 이 요청을 처리하지 않았어요")
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
    if (!text) throw new LlmError("AI 응답이 비어 있어요")
    return { json: parseJson(text), provider: "gemini" }
  }
  throw last!
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>
  promptFeedback?: { blockReason?: string }
  error?: { message?: string; status?: string }
}

// Claude (Anthropic SDK). 사례 목록 같은 지시문은 캐시해 다시 보낼 때 빠르게
async function claude(request: JsonRequest): Promise<JsonResult> {
  const response = await new Anthropic().beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: request.maxTokens,
    // 안전 분류기가 거절하면 서버에서 권장 모델로 다시 돌린다
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: request.effort, format: { type: "json_schema", schema: request.schema as Record<string, unknown> } },
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.user }],
  })
  if (response.stop_reason === "refusal") throw new LlmError("AI가 이 요청을 처리하지 않았어요")
  if (response.stop_reason === "max_tokens") throw new LlmError("AI 응답이 길이 제한에 걸렸어요")
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  return { json: parseJson(text), provider: "claude" }
}
