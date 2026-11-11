// AI 결과의 형태 · 검증 · 규칙 대체 (기능명세 5장).
// AI는 ① 변경 읽기(다섯 기준 태그) ② 비슷한 사례 + 이번에 참고할 점 ③ 외부 · 관련 담당 제안만 한다.
// 날짜와 숫자는 엔진이 계산하고, AI 결과는 여기서 검증해야 화면에 나간다.
import type { CaseRecord, Change, Features } from "../data/types.js"
import { type Context, meetingDeadline, readFeatures, simulate, timingOf } from "../engine/index.js"

export const TRADES = ["선체", "배관", "의장", "전기", "도장"] as const
export const CHANGE_TYPES = ["두께·치수 변경", "위치 이동", "등급·사양 변경", "자재 교체"] as const
export const ZONES = ["화물창 (E)", "화물창 배관 (E)", "거주구 (A)", "기관실", "갑판"] as const
export const PARTIES = ["선급", "선주", "계약·법무", "품질"] as const
export type Party = (typeof PARTIES)[number]

export type SimilarCase = { code: string; why: string[]; takeaway: string }
export type Stakeholder = { party: Party; reason: string; cases: string[]; byRule?: boolean } // byRule: AI가 빠뜨려 규칙으로 채움

export type Analysis = {
  code: string
  source: "claude" | "gemini" | "seed" | "rules" // 어떤 AI가 냈나. seed: 데모용으로 미리 써 둔 결과, rules: AI 없이 규칙
  createdAt: string
  features: Features
  similar: SimilarCase[]
  stakeholders: Stakeholder[]
  note?: string
}

// Claude 구조화 출력 스키마. 사례 번호는 실제 있는 것만 고를 수 있게 enum으로 묶는다
export function analysisSchema(caseCodes: string[]) {
  const codes = { type: "string", enum: caseCodes }
  return {
    type: "object",
    additionalProperties: false,
    required: ["features", "similar", "stakeholders"],
    properties: {
      features: {
        type: "object",
        additionalProperties: false,
        required: ["part", "trade", "types", "zone"],
        properties: {
          part: { type: "string" },
          trade: { type: "string", enum: [...TRADES] },
          types: { type: "array", items: { type: "string", enum: [...CHANGE_TYPES] } },
          zone: { type: "string", enum: [...ZONES] },
        },
      },
      similar: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "why", "takeaway"],
          properties: { code: codes, why: { type: "array", items: { type: "string" } }, takeaway: { type: "string" } },
        },
      },
      stakeholders: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["party", "reason", "cases"],
          properties: {
            party: { type: "string", enum: [...PARTIES] },
            reason: { type: "string" },
            cases: { type: "array", items: codes },
          },
        },
      },
    },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "")

// AI 결과 검증: 형태가 틀리면 버리고(예외), 없는 사례 번호 · 정해진 값 밖의 태그는 걸러낸다
export function validateAnalysis(
  raw: unknown,
  code: string,
  caseCodes: string[],
  source: Analysis["source"],
): Analysis {
  if (!isObject(raw) || !isObject(raw.features) || !Array.isArray(raw.similar) || !Array.isArray(raw.stakeholders))
    throw new Error("AI 결과 형태가 맞지 않아요")
  const known = new Set(caseCodes)
  const f = raw.features
  const features: Features = {
    part: text(f.part, 30) || "-",
    trade: (TRADES as readonly string[]).includes(f.trade as string) ? (f.trade as string) : "-",
    types: Array.isArray(f.types) ? [...new Set(f.types.filter((t): t is string => (CHANGE_TYPES as readonly string[]).includes(t as string)))] : [],
    zone: (ZONES as readonly string[]).includes(f.zone as string) ? (f.zone as string) : "-",
  }
  const seen = new Set<string>()
  const similar = raw.similar
    .filter(isObject)
    .filter((s) => known.has(s.code as string) && !seen.has(s.code as string) && seen.add(s.code as string))
    .map((s) => ({
      code: s.code as string,
      why: (Array.isArray(s.why) ? s.why : []).map((w) => text(w, 20)).filter(Boolean).slice(0, 5),
      takeaway: text(s.takeaway, 200),
    }))
    .filter((s) => s.takeaway)
    .slice(0, 3)
  const parties = new Set<string>()
  const stakeholders = raw.stakeholders
    .filter(isObject)
    .filter((s) => (PARTIES as readonly string[]).includes(s.party as string) && !parties.has(s.party as string) && parties.add(s.party as string))
    .map((s) => ({
      party: s.party as Party,
      reason: text(s.reason, 120),
      cases: (Array.isArray(s.cases) ? s.cases : []).filter((c): c is string => known.has(c as string)).slice(0, 3),
    }))
    .filter((s) => s.reason)
  return { code, source, createdAt: new Date().toISOString(), features, similar, stakeholders }
}

// 다섯 기준이 겹치는 정도 (AI가 없을 때 비슷한 사례를 고르는 규칙)
export function similarity(ctx: Context, change: Change, features: Features, record: CaseRecord) {
  const why: string[] = []
  let score = 0
  if (features.part === record.member) {
    score += 3
    why.push("같은 부재")
  } else if (features.trade === record.trade) {
    score += 1
    why.push("같은 공종")
  }
  const overlap = record.types.filter((t) => features.types.includes(t))
  if (overlap.length) {
    score += 2
    why.push(overlap.join(" · "))
  }
  if (features.zone === record.area) {
    score += 1
    why.push("같은 구역")
  }
  if (change.reason === record.reason) {
    score += 1
    why.push(record.reason)
  }
  if (timingOf(ctx, change).includes(record.timing)) {
    score += 1
    why.push(`${record.timing} 시점`)
  }
  return { score, why }
}

// 진행 보드 할 일 상세의 "비슷한 누락 사례" (기능명세 2-2-h): 바뀐 도면 · 작업지시가 현장에 제대로 안 넘어간 사례 중
// 이번 변경과 가장 비슷한 것. 협력사가 만드는 블록이면 협력사 사례만 본다
const MISS = /v1대로|버전이 달랐|수신 확인이 지연|넘어가지 않아|누락/
export function missCase(ctx: Context, change: Change, features: Features, cases: CaseRecord[], partner: boolean) {
  return cases
    .filter((record) => MISS.test(record.problem) && (!partner || record.problem.includes("협력사")))
    .map((record) => ({ record, score: similarity(ctx, change, features, record).score }))
    .sort((a, b) => b.score - a.score)[0]?.record
}

const PARTY_KEYWORD: Record<Party, RegExp> = {
  선급: /선급/,
  선주: /선주/,
  "계약·법무": /지연 배상|계약/,
  품질: /재검사|품질/,
}

// 규칙 대체: AI 호출이 실패하거나 키가 없을 때
export function ruleAnalysis(ctx: Context, change: Change, cases: CaseRecord[], note?: string): Analysis {
  const features = readFeatures(change)
  const scored = cases
    .map((record) => ({ record, ...similarity(ctx, change, features, record) }))
    // 부재나 공종이 같아야 비슷하다고 본다 (유형 · 구역 · 시점만 겹치는 건 다른 일)
    .filter((x) => x.score >= 4 && (features.part === x.record.member || features.trade === x.record.trade))
    .sort((a, b) => b.score - a.score || b.record.maxDelay - a.record.maxDelay)
  const similar = scored.slice(0, 3).map(({ record, why }) => ({ code: record.code, why, takeaway: record.lesson }))
  const red = meetingDeadline(ctx, change).red
  const sim = simulate(ctx, change, red)
  const delayHit = sim.rows.some((r) => r.delay > 0)
  // 근거: 비슷한 사례 중 그 담당이 실제로 참여했던 사례
  const evidence = (party: Party) =>
    scored
      .filter(
        ({ record }) =>
          record.participants?.some((p) => p.dept === party) ||
          record.execution.some((e) => e.dept === party || PARTY_KEYWORD[party].test(e.task)) ||
          PARTY_KEYWORD[party].test(record.problem),
      )
      .slice(0, 2)
      .map(({ record }) => record.code)
  const stakeholders: Stakeholder[] = []
  if (change.boundary === "production") {
    stakeholders.push({
      party: "선급",
      reason: change.reason === "선급·규정" ? "선급 지적 반영분이라 재승인 필요. 승인 전 배포 불가" : "개정 도면 승인 필요",
      cases: evidence("선급"),
    })
    if (change.reason === "선주 요청" || delayHit)
      stakeholders.push({
        party: "선주",
        reason: change.reason === "선주 요청" ? "선주 요청 변경. 사양 · 추가 비용 확인 필요" : "인도일이 바뀌면 협의 필요",
        cases: evidence("선주"),
      })
    if (delayHit) stakeholders.push({ party: "계약·법무", reason: "인도일이 바뀌면 지연 조항 검토 (확인 필요)", cases: evidence("계약·법무") })
    if (sim.rows.some((r) => r.kind !== "apply")) stakeholders.push({ party: "품질", reason: "재작업 호선 재검사 필요", cases: evidence("품질") })
  }
  return { code: change.code, source: "rules", createdAt: new Date().toISOString(), features, similar, stakeholders, note }
}

// 화면 표시용 이름: 진짜 AI 결과만 "AI"라고 부른다
export const analysisLabel = (a: Analysis | undefined) => (a?.source === "rules" ? "규칙 추천" : "AI 추천")
// AI가 직접 고른 관계자 (규칙 결과 · 규칙으로 채운 담당은 빼고)
export const aiParties = (a: Analysis | undefined) =>
  new Set<string>(a && a.source !== "rules" ? a.stakeholders.filter((s) => !s.byRule).map((s) => s.party) : [])
export const featuresLabel = (a: Analysis | undefined) => (a?.source === "rules" ? "규칙으로 읽은 특징" : "AI가 읽은 특징")
