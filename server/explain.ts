// RAG의 G(설명): 엔진이 계산한 사실 + 찾은 사례만 AI에게 주고 → 안마다 장점 · 단점 · 확인할 것, 사례마다 '비슷한 점 · 이번에 참고할 점', 한 줄 요약.
// AI는 안을 고르지 않는다(추천은 엔진). 사실에 없는 숫자가 하나라도 나오면 버리고 정해진 틀 문장(규칙)을 쓴다.
// 키가 없거나 호출이 실패해도 규칙 문장으로 돌아간다 → 화면 · 시연이 AI 상태에 좌우되지 않는다
import { createHash } from "node:crypto"
import { won } from "./engine/basics.js"
import type { Review } from "./engine/review.js"
import { type Effort, type Generate, generateJson } from "./llm.js"

export type ExplainFacts = {
  change: string
  recommended: string | null
  priority: string
  options: { key: string; label: string; facts: string[] }[]
  cases: { id: string; title: string; matched: string[]; lesson: string | null }[]
  suggestions: string[]
}
export type OptionText = { key: string; pros: string[]; cons: string[]; checks: string[] }
export type CaseText = { id: string; similar: string; takeaway: string }
export type Explanation = {
  key: string
  source: "ai" | "rule"
  provider: string | null
  note: string | null
  summary: string
  options: OptionText[]
  cases: CaseText[]
}

// ── 엔진 결과 → 사실 문장 (AI가 쓸 수 있는 숫자는 여기 있는 것뿐)
export function explainFacts(review: Review): ExplainFacts {
  const s = review.summary
  return {
    change: `${s.id} ${s.title}: ${s.oneLine}${s.mandatory ? " · 반드시 해야 하는 변경" : ""} · 반영 시점 ${s.timing.label}`,
    recommended: review.recommended?.label ?? null,
    priority: `${review.priority.order.join(" > ")} (${review.priority.source})`,
    options: review.options.map((o) => {
      const over = o.hulls.filter((h) => h.overrun > 0)
      const tight = o.hulls.filter((h) => h.treatment !== "post_delivery" && h.treatment !== "not_applicable").sort((a, b) => a.contractDate.localeCompare(b.contractDate))[0]
      return {
        key: o.key,
        label: o.label,
        facts: [
          over.length ? `계약 납기 초과: ${over.map((h) => `${h.seq}호선 ${h.overrun}일`).join(", ")}` : "모든 적용 호선 계약 납기 안",
          `인도 지연 합계 ${o.metrics.deliveryDelaySum}일, 공정 지연 합계 ${o.metrics.localDelaySum}일, 재작업 ${Math.round(o.metrics.reworkHours)}시간`,
          `총비용 ${won(o.cost.total)}, 조선소 실부담 ${won(o.cost.yardShare)} (선주 부담 ${o.cost.ownerPct}%)`,
          ...(o.metrics.ldSum ? [`지체상금 위험 ${won(o.metrics.ldSum)}`] : []),
          ...(o.deadline ? [`결정 기한 ${o.deadline.date}`] : []),
          ...(o.needsClass ? ["선급 승인 필요"] : []),
          ...(o.approval.needed ? [`PM 결재 필요: ${o.approval.triggers.map((t) => t.label).join(", ")}`] : []),
          ...(o.metrics.retrofitUnits ? [`기존 부품 보강 ${o.metrics.retrofitUnits}개`] : []),
          ...(tight ? [`가장 빠듯한 호선: ${tight.seq}호선 (인도 ${tight.newDelivery}, 계약 ${tight.contractDate})`] : []),
        ],
      }
    }),
    cases: review.cases.map((c) => ({ id: c.id, title: c.title, matched: c.matched, lesson: c.lesson })),
    suggestions: review.suggestions.map((x) => `${x.party}: ${x.share}${x.reason ? ` (${x.reason})` : ""}`),
  }
}

export const explainKey = (facts: ExplainFacts) => createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16)

// ── 숫자 검사: 답에 나온 숫자가 모두 사실에 있어야 한다
const NUMBER = /\d+(?:[/.:~,-]\d+)*/g
export function unknownNumbers(texts: string[], facts: ExplainFacts) {
  const factText = [facts.change, facts.recommended ?? "", ...facts.options.flatMap((o) => [o.label, ...o.facts]), ...facts.cases.flatMap((c) => [c.id, c.title, c.lesson ?? "", ...c.matched]), ...facts.suggestions].join(" ")
  const known = new Set(factText.match(NUMBER) ?? [])
  for (const n of [...known]) n.split(/[~,]/).forEach((p) => known.add(p))
  return [...new Set(texts.join(" ").match(NUMBER) ?? [])].filter((n) => !known.has(n) && !known.has(n.replace(/,/g, "")))
}

// ── 규칙 문장 (AI가 없거나 실패할 때)
// 받침에 맞는 조사: 사유가 · 구역이
export const josa = (word: string, withFinal: string, withoutFinal: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  return word + (code >= 0 && code <= 11171 && code % 28 !== 0 ? withFinal : withoutFinal)
}

export function ruleExplanation(review: Review, facts: ExplainFacts, note: string | null): Explanation {
  type Option = Review["options"][number]
  // '가장 ~해요'는 안끼리 차이가 있을 때만 (모두 같으면 비교 근거가 안 된다)
  const isBest = (o: Option, pick: (x: Option) => number) => {
    const values = review.options.map(pick)
    return values.some((v) => v !== values[0]) && pick(o) === Math.min(...values)
  }
  const yardTied = review.options.every((x) => x.cost.yardShare === review.options[0].cost.yardShare)
  const options: OptionText[] = review.options.map((o) => {
    const pros: string[] = []
    const cons: string[] = []
    const checks: string[] = []
    if (o.metrics.overrunSum === 0) pros.push("모든 적용 호선이 계약 납기 안에 끝나요")
    else cons.push(`계약 납기를 넘기는 호선이 있어요 (최대 ${o.metrics.overrunMax}일)`)
    if (isBest(o, (x) => x.cost.yardShare)) pros.push("조선소 실부담이 가장 적어요")
    else if (yardTied && isBest(o, (x) => x.cost.total)) pros.push("총비용이 가장 적어요 (조선소 실부담은 모든 안이 같아요)")
    if (isBest(o, (x) => x.metrics.localDelaySum)) pros.push("공정 지연이 가장 적어요")
    if (isBest(o, (x) => x.metrics.reworkHours)) pros.push("재작업이 가장 적어요")
    if (o.metrics.reworkHours > 0) cons.push(`재작업 ${Math.round(o.metrics.reworkHours)}시간이 생겨요`)
    if (o.metrics.ldSum) cons.push(`지체상금 위험 ${won(o.metrics.ldSum)}`)
    if (o.needsClass) checks.push("선급 승인을 먼저 요청하세요")
    if (o.approval.needed) checks.push(`PM 결재가 필요해요 (${o.approval.triggers.map((t) => t.label).join(", ")})`)
    if (o.deadline) checks.push(`결정 기한 ${o.deadline.date} 안에 정해야 해요`)
    return { key: o.key, pros: pros.slice(0, 3), cons: cons.slice(0, 3), checks: checks.slice(0, 3) }
  })
  return {
    key: explainKey(facts),
    source: "rule",
    provider: null,
    note,
    summary: review.recommended ? `${review.recommended.label}: ${review.recommended.reasons[0] ?? ""}` : review.designOnly ? "도면만 바뀌는 변경이라 대응안 없이 할 일만 있어요" : "",
    options,
    cases: review.cases.map((c) => ({ id: c.id, similar: `${josa(c.matched.join(" · "), "이", "가")} 같아요`, takeaway: c.lesson ?? "" })),
  }
}

// ── AI 설명
const SYSTEM = `당신은 조선소 설계변경 회의를 돕는 검토 담당입니다. 엔진이 계산한 대응안별 사실과, 비슷한 과거 사례(제목 · 맞은 기준 · 교훈)를 읽고 씁니다.

- 어느 안을 고를지는 정하지 않습니다. 추천은 이미 엔진이 계약 납기 관문과 선주 우선순위로 정했습니다
- summary: 회의 참석자가 먼저 읽을 한 줄 (추천안과 그 이유를 사실 그대로)
- options: 안마다 장점 1~3개, 단점 1~3개, 확인할 것 1~3개. 한 줄에 한 가지, 짧은 해요체
- cases: 사례마다 similar(이번 변경과 비슷한 점 한 줄), takeaway(이번에 참고할 점 한 줄, 사례 교훈에서)
- 날짜 · 일수 · 금액 · 척 수 · 호선 번호 같은 숫자는 사실과 사례에 적힌 그대로만 씁니다. 계산해서 새 숫자를 만들지 않습니다
- 사실에 없는 내용(원인 추정, 책임 소재, 계약 조항 해석)은 단정하지 않습니다`

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "options", "cases"],
  properties: {
    summary: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "pros", "cons", "checks"],
        properties: { key: { type: "string" }, pros: { type: "array", items: { type: "string" } }, cons: { type: "array", items: { type: "string" } }, checks: { type: "array", items: { type: "string" } } },
      },
    },
    cases: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "similar", "takeaway"], properties: { id: { type: "string" }, similar: { type: "string" }, takeaway: { type: "string" } } },
    },
  },
}

export class ExplanationRejected extends Error {}
const clean = (v: unknown, max = 3) =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, max)
const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "")

export function userPrompt(facts: ExplainFacts) {
  return [
    `설계변경 ${facts.change}`,
    `엔진 추천: ${facts.recommended ?? "없음"} · 선주 우선순위: ${facts.priority}`,
    "",
    "대응안별 사실",
    ...facts.options.flatMap((o) => [`[${o.key}] ${o.label}`, ...o.facts.map((f) => `- ${f}`)]),
    "",
    "비슷한 과거 사례",
    ...(facts.cases.length ? facts.cases.map((c) => `- ${c.id} ${c.title} (맞은 기준: ${c.matched.join(", ")}) 교훈: ${c.lesson ?? "없음"}`) : ["- 없음"]),
    ...(facts.suggestions.length ? ["", "사례에 자주 관여했는데 이번 할 일에 없는 쪽", ...facts.suggestions.map((s) => `- ${s}`)] : []),
  ].join("\n")
}

// AI 답을 받아 검사. 빠진 안 · 모르는 사례 · 사실에 없는 숫자가 있으면 ExplanationRejected
export async function aiExplanation(facts: ExplainFacts, generate: Generate = generateJson, effort: Effort = "low"): Promise<Explanation> {
  const result = await generate({ system: SYSTEM, user: userPrompt(facts), schema: SCHEMA, effort, maxTokens: 8000 })
  const raw = (result.json ?? {}) as { summary?: unknown; options?: unknown[]; cases?: unknown[] }
  const wanted = facts.options.map((o) => o.key)
  const options: OptionText[] = []
  for (const o of (raw.options ?? []) as Record<string, unknown>[]) {
    const key = String(o.key ?? "")
    if (!wanted.includes(key) || options.some((x) => x.key === key)) continue
    options.push({ key, pros: clean(o.pros), cons: clean(o.cons), checks: clean(o.checks) })
  }
  if (options.length !== wanted.length) throw new ExplanationRejected("AI 설명에 빠진 대응안이 있어요")
  const caseIds = facts.cases.map((c) => c.id)
  const cases: CaseText[] = ((raw.cases ?? []) as Record<string, unknown>[])
    .filter((c) => caseIds.includes(String(c.id)))
    .map((c) => ({ id: String(c.id), similar: line(c.similar), takeaway: line(c.takeaway) }))
  const summary = line(raw.summary)
  const unknown = unknownNumbers([summary, ...options.flatMap((o) => [...o.pros, ...o.cons, ...o.checks]), ...cases.flatMap((c) => [c.similar, c.takeaway])], facts)
  if (unknown.length) throw new ExplanationRejected(`AI 설명에 계산에 없는 숫자가 있어요 (${unknown.join(", ")})`)
  return { key: explainKey(facts), source: "ai", provider: result.provider, note: null, summary, options, cases }
}

// 설명 하나: AI를 쓸 수 있으면 AI, 아니면(또는 실패하면) 규칙 문장
export async function explain(review: Review, opts: { generate?: Generate; useAi?: boolean; effort?: Effort } = {}): Promise<Explanation> {
  const facts = explainFacts(review)
  if (opts.useAi === false) return ruleExplanation(review, facts, "AI 키가 없어 정해진 틀로 설명해요")
  try {
    return await aiExplanation(facts, opts.generate, opts.effort)
  } catch (error) {
    return ruleExplanation(review, facts, error instanceof Error ? error.message : "AI 설명 실패")
  }
}

export const aiConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
