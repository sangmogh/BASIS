// AI ④ 결정 요약: 회의에서 정한 것을 회의록 맨 위에 둘 몇 문장으로 (AI 호출은 llm.ts, Gemini 또는 Claude)
import { type SummaryInput, unknownNumbers } from "../src/ai/summary.js"
import { type Effort, type Generate, generateJson } from "./llm.js"

const SYSTEM = `당신은 조선소 설계변경 회의의 기록 담당입니다. 회의에서 정한 내용을 회의록 맨 위에 둘 요약으로 씁니다.

- 3~4문장, 회의록 문체(…로 결정, …예정, …까지)로 씁니다
- 순서: 무엇을 언제로 정했는지 → 인도일이 바뀌는 호선 → 부서별로 먼저 챙길 일과 기한 → 외부 협의
- 날짜 · 일수 · 척 수 · 호선 번호 · 기준선 같은 숫자는 "계산된 사실"에 적힌 그대로만 씁니다. 더하거나 빼서 새 숫자를 만들지 않습니다
- 사실에 없는 내용(비용, 원인 추정, 책임 소재)은 쓰지 않습니다`

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
}

export class SummaryRejected extends Error {}

export async function summarizeDecision(input: SummaryInput, generate: Generate = generateJson, effort: Effort = "low") {
  const result = await generate({
    system: SYSTEM,
    user: `설계변경 ${input.code} ${input.title}\n\n계산된 사실\n${input.facts.map((f) => `- ${f}`).join("\n")}`,
    schema: SCHEMA,
    effort,
    maxTokens: 8000,
  })
  const summary = String((result.json as { summary?: unknown } | null)?.summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700)
  if (!summary) throw new SummaryRejected("AI 요약이 비어 있어요")
  const unknown = unknownNumbers(summary, [input.code, input.title, ...input.facts])
  if (unknown.length) throw new SummaryRejected(`AI 요약에 계산에 없는 숫자가 있어요 (${unknown.join(", ")})`)
  return { summary, provider: result.provider }
}

// 요청으로 들어온 사실 문장 확인 (화면이 엔진으로 계산해 보낸 것)
export function parseSummaryInput(input: unknown): SummaryInput {
  const s = (input as { summary?: SummaryInput })?.summary
  if (
    !s ||
    typeof s.code !== "string" ||
    !/^DC-\d{3}$/.test(s.code) ||
    typeof s.title !== "string" ||
    s.title.length > 120 ||
    !Array.isArray(s.facts) ||
    !s.facts.length ||
    s.facts.length > 12 ||
    !s.facts.every((f) => typeof f === "string" && f.length <= 1500)
  )
    throw new Error("결정 요약 재료가 맞지 않아요")
  return { code: s.code, title: s.title, facts: s.facts }
}
