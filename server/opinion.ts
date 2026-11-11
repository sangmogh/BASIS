// AI 대안 검토 의견 (Gemini 또는 Claude, llm.ts): 안마다 장점 · 단점 · 추가 확인사항.
// 안을 고르지 않는다. 숫자는 "계산된 사실"과 사례에 있는 것만. 어기면 버린다 (화면은 규칙 의견)
import type { Method } from "../src/data/types.js"
import { type OpinionInput, type OptionOpinion, unknownOpinionNumbers } from "../src/ai/opinion.js"
import { type Effort, type Generate, generateJson } from "./llm.js"

const SYSTEM = `당신은 조선소 설계변경 회의를 돕는 검토 담당입니다. 엔진이 계산한 대응안별 사실과 과거 사례 교훈을 읽고, 안마다 장점 · 단점 · 추가 확인사항을 씁니다.

- 어느 안을 고를지는 정하지 않습니다. 추천은 이미 엔진이 선주 우선순위로 정했습니다
- 안마다 장점 1~3개, 단점 1~3개, 추가 확인사항 1~3개. 한 줄에 한 가지, 짧은 해요체 문장
- 날짜 · 일수 · 금액 · 척 수 · 호선 번호 같은 숫자는 "계산된 사실"이나 "과거 사례"에 적힌 그대로만 씁니다. 더하거나 빼서 새 숫자를 만들지 않습니다
- 추가 확인사항은 과거 사례 교훈과 승인 · 조달 · 납기에서 사람이 확인해야 할 것을 씁니다
- 사실에 없는 내용(원인 추정, 책임 소재, 계약 조항 해석)은 단정하지 않습니다`

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opinions"],
  properties: {
    opinions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["method", "pros", "cons", "checks"],
        properties: {
          method: { type: "string", enum: ["A", "B", "C"] },
          pros: { type: "array", items: { type: "string" } },
          cons: { type: "array", items: { type: "string" } },
          checks: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
}

export class OpinionRejected extends Error {}

const clean = (list: unknown) =>
  (Array.isArray(list) ? list : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 3)

export async function reviewOptions(input: OpinionInput, generate: Generate = generateJson, effort: Effort = "low") {
  const user = [
    `설계변경 ${input.code} ${input.title}`,
    `선주 우선순위: ${input.priority} (엔진 추천: ${input.recommended ?? "없음"})`,
    "",
    "계산된 사실",
    ...input.methods.flatMap((m) => [`[${m.label}]`, ...m.facts.map((f) => `- ${f}`)]),
    "",
    "과거 사례",
    ...(input.cases.length ? input.cases.map((c) => `- ${c}`) : ["- 없음"]),
  ].join("\n")
  const result = await generate({ system: SYSTEM, user, schema: SCHEMA, effort, maxTokens: 8000 })
  const raw = (result.json as { opinions?: unknown[] } | null)?.opinions ?? []
  const wanted = new Set(input.methods.map((m) => m.method))
  const opinions: OptionOpinion[] = []
  for (const o of raw) {
    const x = o as Record<string, unknown>
    const method = x.method as Method
    if (!wanted.has(method) || opinions.some((y) => y.method === method)) continue
    opinions.push({ method, pros: clean(x.pros), cons: clean(x.cons), checks: clean(x.checks) })
  }
  if (opinions.length !== wanted.size) throw new OpinionRejected("AI 의견에 빠진 대응안이 있어요")
  const unknown = unknownOpinionNumbers(opinions, input)
  if (unknown.length) throw new OpinionRejected(`AI 의견에 계산에 없는 숫자가 있어요 (${unknown.join(", ")})`)
  return { opinions, provider: result.provider }
}

// 요청으로 들어온 재료 확인 (화면이 엔진으로 계산해 보낸 것)
export function parseOpinionInput(body: unknown): OpinionInput {
  const s = (body as { opinion?: OpinionInput })?.opinion
  const ok =
    s &&
    typeof s.code === "string" &&
    /^DC-\d{3}$/.test(s.code) &&
    typeof s.title === "string" &&
    s.title.length <= 120 &&
    typeof s.priority === "string" &&
    s.priority.length <= 60 &&
    Array.isArray(s.methods) &&
    s.methods.length >= 1 &&
    s.methods.length <= 3 &&
    s.methods.every((m) => ["A", "B", "C"].includes(m.method) && typeof m.label === "string" && Array.isArray(m.facts) && m.facts.length <= 10 && m.facts.every((f) => typeof f === "string" && f.length <= 400)) &&
    Array.isArray(s.cases) &&
    s.cases.length <= 3 &&
    s.cases.every((c) => typeof c === "string" && c.length <= 600)
  if (!ok) throw new Error("대안 검토 재료가 맞지 않아요")
  return { code: s.code, title: s.title, priority: s.priority, recommended: s.recommended ?? null, methods: s.methods, cases: s.cases }
}
