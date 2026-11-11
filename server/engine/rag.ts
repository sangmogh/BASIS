// RAG의 R(찾기): 비슷한 과거 사례 = 온톨로지(다섯 기준 · 부재 계층) + 문장 검색(BM25, 글자 2개씩) → 사례 통계 · 관계자 제안
// AI 없이 돈다. AI 설명(G)은 server/explain.ts가 여기서 찾은 사례만 읽고 쓴다
import { median, type Row } from "./basics.js"
import { similarCases, type CaseQuery, type Ontology } from "./ontology.js"
import type { World } from "./world.js"

// ── 문장 검색: 글자 2개 단위(한글) + 영숫자 낱말, BM25
const STOP = new Set(["변경", "관련", "합성", "사례", "검토", "사건"])
export function terms(text: string) {
  const out: string[] = []
  for (const word of String(text ?? "").toLowerCase().split(/[^0-9a-z가-힣]+/).filter(Boolean)) {
    if (/^[0-9a-z]+$/.test(word)) {
      if (word.length > 1) out.push(word)
      continue
    }
    if (word.length === 1) continue
    if (STOP.has(word)) continue
    for (let i = 0; i + 2 <= word.length; i++) out.push(word.slice(i, i + 2))
  }
  return out
}
const caseText = (c: Row) => [c.title, c.title, c.original_text, c.problem, c.lesson, c.spec_before, c.spec_after].filter(Boolean).join(" ")

export function searchCases(w: World, query: string) {
  const docs = w.cases.map((c) => ({ id: c.case_id as string, tf: counts(terms(caseText(c))) }))
  const avg = docs.reduce((a, d) => a + d.tf.total, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.map.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const q = [...new Set(terms(query))]
  const k1 = 1.2
  const b = 0.75
  const scores = docs.map((d) => {
    let s = 0
    for (const t of q) {
      const f = d.tf.map.get(t) ?? 0
      if (!f) continue
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tf.total) / avg)))
    }
    return { id: d.id, score: s }
  })
  const max = Math.max(0, ...scores.map((x) => x.score))
  return new Map(scores.map((x) => [x.id, max ? x.score / max : 0]))
}
function counts(list: string[]) {
  const map = new Map<string, number>()
  for (const t of list) map.set(t, (map.get(t) ?? 0) + 1)
  return { map, total: list.length }
}

// ── 다섯 기준 (온톨로지가 없을 때 DB에서 같은 부재만)
function structuredFromDb(w: World, q: CaseQuery) {
  return w.cases.map((c) => {
    const ct = JSON.parse(c.change_types || "[]") as string[]
    const same = q.partKinds.includes(c.part_kind)
    const matched = [same && "부재", ct.some((x) => q.changeTypes.includes(x)) && "변경 유형", c.zone_kind === q.zoneKind && "구역", c.reason === q.reason && "사유", c.timing === q.timing && "시점"].filter(Boolean) as string[]
    return { id: c.case_id as string, matched, same, sibling: false }
  })
}

export type RetrievedCase = {
  id: string
  title: string
  matched: string[] // 다섯 기준 중 맞은 것 (같은 계열 부재 포함)
  textScore: number // 문장 검색 점수 (0~1)
  score: number
  via: string
  lesson: string | null
  results: { handling: string; days: number | null; cost: number | null }[]
}

// 찾기: 구조 점수(같은 부재 2 · 같은 계열 1 · 나머지 기준 1씩) + 문장 점수 × 2
export function retrieveCases(w: World, args: { ontology: Ontology | null; query: CaseQuery; text: string; limit?: number; pool?: number }) {
  const { ontology, query, text, limit = 3, pool = 10 } = args
  const structured = ontology ? similarCases(ontology, query, 1000, { minMatched: 0, requireKind: false }) : structuredFromDb(w, query)
  const textScores = searchCases(w, text)
  const caseById = new Map(w.cases.map((c) => [c.case_id as string, c]))
  const ranked = structured
    .map((s) => {
      const structure = s.matched.reduce((a, m) => a + (m === "부재" ? 2 : 1), 0)
      const t = textScores.get(s.id) ?? 0
      return { ...s, structure, textScore: Math.round(t * 100) / 100, score: structure + 2 * t }
    })
    .filter((s) => s.structure >= 2 || s.textScore >= 0.5)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const via = ontology ? "온톨로지 + 문장 검색" : "DB + 문장 검색"
  const toCase = (s: (typeof ranked)[number]): RetrievedCase => {
    const c = caseById.get(s.id)!
    return {
      id: s.id,
      title: c.title,
      matched: s.matched,
      textScore: s.textScore,
      score: Math.round(s.score * 100) / 100,
      via: s.matched.some((m) => m.startsWith("같은 계열")) ? `${via} (부재 계층: 같은 계열)` : via,
      lesson: c.lesson ?? null,
      results: (w.caseResults.get(s.id) ?? []).map((r) => ({ handling: w.label("handling", r.handling), days: r.actual_duration_days ?? null, cost: r.actual_cost_krw ?? null })),
    }
  }
  return { top: ranked.slice(0, limit).map(toCase), pool: ranked.slice(0, pool).map((s) => s.id) }
}

// ── 사례 통계: 비슷한 사례(pool)의 처리 방법별 건수 · 실제 일수 · 비용 중간값
export function caseStats(w: World, ids: string[]) {
  const results = ids.flatMap((id) => w.caseResults.get(id) ?? [])
  const by = new Map<string, Row[]>()
  for (const r of results) by.set(r.handling, [...(by.get(r.handling) ?? []), r])
  const delays = ids.map((id) => w.cases.find((c) => c.case_id === id)?.delivery_delay_days).filter((x): x is number => x != null)
  return {
    basis: ids.length,
    byHandling: [...by].map(([handling, rows]) => ({
      handling: w.label("handling", handling),
      hulls: rows.length,
      medianDays: median(rows.map((r) => Number(r.actual_duration_days)).filter(Number.isFinite)),
      medianCost: median(rows.map((r) => Number(r.actual_cost_krw)).filter(Number.isFinite)),
    })),
    medianDeliveryDelay: median(delays),
    certainty: "case" as const,
  }
}

// ── 관계자 제안: 비슷한 사례에 자주 관여한 쪽이 이번 할 일에 없으면 '추가로 부를 쪽'으로 (근거 사례와 함께)
export function suggestParties(w: World, ids: string[], present: { roles: string[]; counterparts: string[] }, minShare = 0.4) {
  const tally = new Map<string, { kind: string; code: string; cases: string[]; reason: string | null }>()
  for (const id of ids)
    for (const p of w.caseParticipants.get(id) ?? []) {
      const key = `${p.party_kind}:${p.party_code}`
      const t = tally.get(key) ?? { kind: String(p.party_kind), code: String(p.party_code), cases: [] as string[], reason: (p.reason_text as string | null) ?? null }
      if (!t.cases.includes(id)) t.cases.push(id)
      tally.set(key, t)
    }
  return [...tally.values()]
    .filter((t) => t.cases.length / Math.max(1, ids.length) >= minShare)
    .filter((t) => (t.kind === "role" ? !present.roles.includes(t.code) : !present.counterparts.includes(t.code)))
    .sort((a, b) => b.cases.length - a.cases.length)
    .map((t) => ({
      party: t.kind === "role" ? w.label("role", t.code) : w.label("counterparty_kind", t.code),
      kind: t.kind,
      code: t.code,
      share: `비슷한 사례 ${ids.length}건 중 ${t.cases.length}건`,
      reason: t.reason,
      cases: t.cases.slice(0, 3),
    }))
}
