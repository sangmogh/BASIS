// AI ①②③: 변경 읽기 · 비슷한 사례 · 관계자 제안 (AI 호출은 llm.ts, Gemini 또는 Claude)
import { type Analysis, analysisSchema, ruleAnalysis, similarity, validateAnalysis } from "../src/ai/analysis.js"
import { systemPrompt, userPrompt } from "../src/ai/prompt.js"
import { DATA_ANCHOR, isIsoDate, shiftDates } from "../src/data/clock.js"
import { benchmarkData, caseData, seriesData } from "../src/data/index.js"
import type { CaseRecord, Change } from "../src/data/types.js"
import { type Context, daysBetween, readFeatures } from "../src/engine/index.js"
import { type Effort, type Generate, generateJson } from "./llm.js"

// AI에 보여줄 후보 사례 수. 다섯 기준 점수로 먼저 추려 지시문을 짧게 한다 (회의 중 응답 시간)
export const SHORTLIST = 20

export function shortlist(ctx: Context, change: Change, cases: CaseRecord[], size = SHORTLIST) {
  const features = readFeatures(change)
  return cases
    .map((record) => ({ record, score: similarity(ctx, change, features, record).score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, size)
    .map((x) => x.record)
}

export async function analyzeChange(
  change: Change,
  generate: Generate = generateJson,
  effort: Effort = "medium",
  learned: CaseRecord[] = [], // 진행 보드에서 쌓인 사례 (화면이 보낸 것)
  today: string = DATA_ANCHOR, // 화면의 오늘 (시연 시계). 합성 데이터를 같은 만큼 옮겨 계산한다
): Promise<Analysis> {
  const ctx: Context = { series: shiftDates(seriesData, daysBetween(DATA_ANCHOR, today)), benchmarks: benchmarkData }
  const pool = [...caseData, ...learned]
  const candidates = shortlist(ctx, change, pool)
  const caseCodes = candidates.map((c) => c.code)
  const result = await generate({
    system: systemPrompt(candidates),
    user: userPrompt(ctx, change),
    schema: analysisSchema(caseCodes),
    effort,
    maxTokens: 16000,
  })
  const analysis = validateAnalysis(result.json, change.code, caseCodes, result.provider)
  // 계산상 반드시 엮이는 담당(인도 지연 → 선주 · 계약·법무, 재작업 → 품질 등)을 AI가 빠뜨리면 규칙으로 채운다
  const parties = new Set(analysis.stakeholders.map((s) => s.party))
  const missing = ruleAnalysis(ctx, change, pool)
    .stakeholders.filter((s) => !parties.has(s.party))
    .map((s) => ({ ...s, byRule: true }))
  return { ...analysis, stakeholders: [...analysis.stakeholders, ...missing] }
}

// 요청으로 들어온 설계변경이 계산할 수 있는 형태인지 확인한다
export function parseChange(input: unknown): Change {
  const c = (input as { change?: Change })?.change
  if (!c || typeof c.code !== "string" || typeof c.title !== "string" || typeof c.block !== "string")
    throw new Error("설계변경 정보가 부족해요")
  if (!seriesData.vessels.some((v) => v.blocks[c.block])) throw new Error(`모르는 블록이에요: ${c.block}`)
  if (JSON.stringify(c).length > 20000) throw new Error("설계변경 정보가 너무 길어요")
  return c
}

const TIMINGS = ["생산 전", "블록 제작 중", "블록 완성", "탑재 후"]
const isText = (v: unknown, max = 300) => typeof v === "string" && v.length <= max
const isRows = (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "object" && x !== null)

// 진행 보드에서 쌓인 사례: 화면이 보낸 것이라 형태 · 크기를 확인하고, 이미 있는 사례 번호는 받지 않는다
export function parseLearned(input: unknown): CaseRecord[] {
  const list = (input as { cases?: unknown })?.cases
  if (list == null) return []
  if (!Array.isArray(list) || list.length > 20 || JSON.stringify(list).length > 60000) throw new Error("쌓인 사례 정보가 너무 많아요")
  const known = new Set(caseData.map((c) => c.code))
  return list.filter(
    (c): c is CaseRecord =>
      typeof c === "object" &&
      c !== null &&
      /^DC-\d{3}$/.test(c.code) &&
      !known.has(c.code) &&
      ["title", "member", "trade", "area", "reason", "vessel", "v1", "v2", "result", "problem", "lesson"].every((k) => isText(c[k])) &&
      Array.isArray(c.types) &&
      c.types.every((t: unknown) => isText(t, 30)) &&
      TIMINGS.includes(c.timing) &&
      typeof c.maxDelay === "number" &&
      isRows(c.treatments) &&
      isRows(c.execution),
  )
}

// 화면이 보낸 오늘 날짜 (형식이 맞고 기준일에서 3년 안일 때만, 아니면 기준일)
export function parseToday(input: unknown) {
  const t = (input as { today?: unknown })?.today
  return typeof t === "string" && isIsoDate(t) && Math.abs(daysBetween(DATA_ANCHOR, t)) <= 3 * 366 ? t : DATA_ANCHOR
}
