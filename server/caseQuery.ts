// 사례 검색 (메뉴 3): 자기 말로 묻고, 실제 기록에서 찾는다
//   ① 질문 → 검색 조건: AI가 있으면 AI, 없거나 실패하면 규칙. 부재 이름은 온톨로지 용어 체계(다른 이름 · 계열)로도 맞춘다
//   ② 조건 → 기록 찾기: 엔진 데이터 + 문장 검색. AI 없음
//   ③ 찾은 기록만 읽고 설명: AI가 있으면 AI(기록에 없는 숫자가 나오면 버림), 아니면 정해진 틀 문장
//   기록에 없는 것(예: 아직 기록이 없는 처리 방식)을 물으면 비슷한 기록을 억지로 붙이지 않고 '없다'고 답한다
import { createHash } from "node:crypto"
import { matchPartKinds, similarCases, type Ontology, type World } from "./engine/index.js"
import { searchCases as textScores } from "./engine/rag.js"
import { caseInState, GROUPS, openChangeContext, toCard, type CaseCard, type GroupKey } from "./caseSearch.js"
import { josa } from "./explain.js"
import { generateJson, type Generate } from "./llm.js"

type Row = Record<string, any>

export type Conditions = {
  partKinds: string[]
  states: GroupKey[]
  handlings: string[]
  reasons: string[]
  changeTypes: string[]
  zoneKinds: string[]
  keywords: string[]
  missing: string[] // 질문에 있었지만 기록에 그런 처리가 없는 것
  strictReason: boolean // 사유를 꼭 맞춰야 하나 ('선주 요청 건만')
  outOfScope: boolean
  partVia: Record<string, string> // 부재 코드 → 어떻게 알아들었나 ("행거 → 배관 서포트 (온톨로지 용어)")
}

// ── 사전: 기록의 코드로 바꿀 수 있는 말
const STATE_RULES: [RegExp, GroupKey][] = [
  [/인도\s*(된|한|후|선)|운항/, "delivered"],
  [/(설치|탑재)\s*(하기\s*)?전/, "fabricated"],
  [/(제작|생산|만들기)\s*(하기\s*)?전|미착수|착수\s*전|아직\s*안\s*만/, "not_started"],
  [/설치|탑재|붙인|달린|달아\s*놓/, "installed"],
  [/(?<!다시\s{0,2})만든|만들어\s*(둔|놓)|제작\s*(중|된|한|완료)|기제작|블록\s*(완성|제작)/, "fabricated"], // '다시 만든'은 새로 만든 것
]
// 처리 방식: 질문의 말(q)과 기록의 처리 이름(label)을 짝짓는다. 데이터에 없는 처리면 '없음'으로 답한다
const HANDLING_CONCEPTS = [
  { name: "바로 반영", q: /바로\s*(반영|적용)|그대로\s*(반영|적용)|즉시\s*반영/, label: /바로 반영/ },
  // '재작업을 최소화 · 줄인 · 피한 · 없이'는 재작업을 찾는 게 아니라 피하려는 것
  { name: "재작업", q: /(재작업|다시\s*(작업|만들|제작)|재제작|뜯어|떼어)(?!\s*(을|를|이|가)?\s*(최소|줄|피|안\s*하|않|없이))/, label: /재작업/ },
  { name: "중단 검토", q: /중단|보류|멈추|멈춘/, label: /중단/ },
  { name: "인도 후 개조", q: /개조/, label: /개조/ },
  // '기존 제작품을 폐기'처럼 기존품이 목적어일 뿐인 경우는 빼고, 살리는 동사가 있을 때만
  { name: "기존품 활용", q: /살린|살려|살릴|재사용|재활용|그대로\s*(쓰|썼|사용)|보강해서\s*(쓰|썼|활용)|(기존품|기존\s*부품|기존\s*제작품)\s*(을|를)?\s*(보강|활용)/, label: /기존|활용|재사용/ },
  { name: "긴급 조달", q: /긴급/, label: /긴급/ },
  { name: "폐기 · 재발주", q: /폐기|버리|버린|재발주/, label: /폐기|재발주/ },
]
const REASON_RULES: [RegExp, string][] = [[/선주/, "owner_request"], [/선급|규정|규칙|협약/, "class_rule"], [/내부\s*오류|설계\s*(오류|실수)|실수|오류/, "internal_error"], [/개선/, "improvement"]]
const TYPE_RULES: [RegExp, string][] = [[/두께|치수|강도|두껍|보강판/, "dimension"], [/위치|이동|옮/, "relocation"], [/등급|사양|규격|A-?60|A-?0\b/i, "grade_spec"], [/자재|재질|소재|교체/, "material_swap"]]
const ZONE_RULES: [RegExp, string][] = [[/거주구/, "accommodation"], [/화물창\s*배관|화물\s*배관|카고\s*파이프/, "cargo_piping"], [/화물창(?!\s*배관)/, "cargo_hold"], [/기관실|엔진\s*룸/, "engine_room"], [/갑판/, "deck"]]

// 데이터에 실제로 있는 코드만 (없는 코드로 찾으면 늘 비니까)
function vocabulary(w: World) {
  const handlings = [...new Set([...w.caseResults.values()].flat().map((r: Row) => r.handling as string))]
  const uniq = (k: string) => [...new Set(w.cases.map((c: Row) => c[k] as string).filter(Boolean))]
  const changeTypes = [...new Set(w.cases.flatMap((c: Row) => JSON.parse(c.change_types || "[]") as string[]))]
  return { partKinds: uniq("part_kind"), handlings, reasons: uniq("reason"), changeTypes, zoneKinds: uniq("zone_kind") }
}
type Vocab = ReturnType<typeof vocabulary>

const empty = (): Conditions => ({ partKinds: [], states: [], handlings: [], reasons: [], changeTypes: [], zoneKinds: [], keywords: [], missing: [], strictReason: false, outOfScope: false, partVia: {} })

// 부재: 온톨로지 용어 체계(이름 · 다른 이름). 온톨로지가 없으면 기록의 부재 이름으로
function partsFrom(w: World, onto: Ontology | null, vocab: Vocab, text: string) {
  const via: Record<string, string> = {}
  if (onto) {
    const found = matchPartKinds(onto, text, 5).filter((c) => vocab.partKinds.includes(c.code))
    const top = found[0]?.score ?? 0
    for (const c of found.filter((x) => x.score >= top * 0.75)) {
      const term = c.matched.includes(c.label) ? null : c.matched[0] // 정식 이름으로 물었으면 그대로, 다른 이름이면 '행거 → 배관 서포트'
      via[c.code] = term ? `"${term}" → ${c.label} (온톨로지 용어)` : c.label
    }
  } else
    for (const code of vocab.partKinds) {
      const label = w.label("part_kind", code)
      if (text.replace(/\s/g, "").includes(label.replace(/\s/g, ""))) via[code] = label
    }
  return via
}

// ① 규칙으로 알아듣기
export function ruleConditions(w: World, onto: Ontology | null, text: string): Conditions {
  const vocab = vocabulary(w)
  const c = empty()
  c.partVia = partsFrom(w, onto, vocab, text)
  c.partKinds = Object.keys(c.partVia)
  let rest = text
  for (const [re, key] of STATE_RULES)
    if (re.test(rest)) {
      if (!c.states.includes(key)) c.states.push(key)
      rest = rest.replace(new RegExp(re.source, "g"), " ") // '설치 전'을 '설치'로 다시 읽지 않게
    }
  for (const concept of HANDLING_CONCEPTS) {
    if (!concept.q.test(text)) continue
    const codes = vocab.handlings.filter((h) => concept.label.test(w.label("handling", h)))
    if (codes.length) c.handlings.push(...codes.filter((h) => !c.handlings.includes(h)))
    else c.missing.push(concept.name)
  }
  const pick = (rules: [RegExp, string][], allowed: string[]) => [...new Set(rules.filter(([re, code]) => re.test(text) && allowed.includes(code)).map(([, code]) => code))]
  c.reasons = pick(REASON_RULES, vocab.reasons)
  c.changeTypes = pick(TYPE_RULES, vocab.changeTypes)
  c.zoneKinds = pick(ZONE_RULES, vocab.zoneKinds)
  return c
}

// ① AI로 알아듣기 (코드 목록 안에서만 고르게 하고, 다시 걸러 낸다). 부재는 온톨로지 용어로 맞춘 것을 더한다
//   규칙이 집어낸 상태 · 처리는 AI보다 먼저 쓴다. 같은 말이면 늘 같은 조건으로 찾게 하려는 것
//   (11/5 로컬에서 실제 Haiku에 "기존품을 살려서 반영한 사례 있어?"를 4번 물었더니 3번은 목록에 있는 처리를 missing에 적었다.
//    지시문에 남아 있던 옛 missing 예시 탓. 같은 날 배포 사이트에서 본 오독은 점검용 curl이 한글을 CP949로 보낸 탓이었다)
const PARSE_SYSTEM = `조선소 생산관리자가 과거 설계변경 사례를 찾으려고 쓴 질문을 검색 조건으로 바꿉니다.

- 각 항목은 주어진 목록의 코드만 고릅니다. 질문에 분명히 드러난 것만 고르고, 애매하면 비워 둡니다
- partKinds: 질문 속 부재(부품 종류)
- states: 그 부재가 놓인 진행 상태. delivered = 인도 후 운항 중, installed = 설치(탑재) 후, fabricated = 만들었지만 설치 전, not_started = 아직 안 만듦
- handlings: 질문이 특정 처리 방식을 콕 집어 찾을 때만 고릅니다 (예: "재작업한 사례", "긴급 조달한 적"). 목록의 처리 이름과 뜻이 같으면 그 코드를 고릅니다 (예: "살린 · 재사용 · 기존품을 살려서" = 기존품 보강 활용). "반영"이라는 말만으로 "바로 반영"을 고르지 않습니다. "어떻게 처리했어?"처럼 처리 방식을 묻는 질문이면 비워 둡니다
- missing: 질문이 찾는 처리가 목록 어디에도 없을 때만 그 이름을 적습니다 (예: "외주 위탁", "설계 취소"). 목록에 있는 처리는 missing에 적지 않습니다
- reasons · changeTypes · zoneKinds: 질문에 말로 드러난 변경 사유 · 변경 유형 · 구역만 (추측해서 더하지 않습니다)
- keywords: 사례 문장에서 찾을 핵심 낱말 2~4개 (한국어)
- 조선 설계변경 사례와 관계없는 질문이면 outOfScope = true`

const arr = (items: object) => ({ type: "array", items })
const codeArr = (codes: string[]) => arr(codes.length ? { type: "string", enum: codes } : { type: "string" })

export async function aiConditions(w: World, onto: Ontology | null, text: string, generate: Generate = generateJson): Promise<Conditions> {
  const vocab = vocabulary(w)
  const list = (type: string, codes: string[]) => codes.map((code) => `${code} = ${w.label(type, code)}`).join(", ")
  const user = [
    `질문: ${text}`,
    "",
    `partKinds: ${list("part_kind", vocab.partKinds)}`,
    `states: delivered, installed, fabricated, not_started`,
    `handlings: ${list("handling", vocab.handlings)}`,
    `reasons: ${list("reason", vocab.reasons)}`,
    `changeTypes: ${list("change_type", vocab.changeTypes)}`,
    `zoneKinds: ${list("zone_kind", vocab.zoneKinds)}`,
  ].join("\n")
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["partKinds", "states", "handlings", "missing", "reasons", "changeTypes", "zoneKinds", "keywords", "outOfScope"],
    properties: {
      partKinds: codeArr(vocab.partKinds),
      states: codeArr(GROUPS.map((g) => g.key)),
      handlings: codeArr(vocab.handlings),
      missing: arr({ type: "string" }),
      reasons: codeArr(vocab.reasons),
      changeTypes: codeArr(vocab.changeTypes),
      zoneKinds: codeArr(vocab.zoneKinds),
      keywords: arr({ type: "string" }),
      outOfScope: { type: "boolean" },
    },
  }
  const result = await generate({ system: PARSE_SYSTEM, user, schema, effort: "low", maxTokens: 2000 })
  const raw = (result.json ?? {}) as Record<string, unknown>
  const only = (v: unknown, allowed: readonly string[]) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => allowed.includes(x)))]
  const ai = empty()
  const ontoParts = partsFrom(w, onto, vocab, text)
  for (const code of only(raw.partKinds, vocab.partKinds)) ai.partVia[code] = ontoParts[code] ?? `${w.label("part_kind", code)} (AI 해석)`
  Object.assign(ai.partVia, ontoParts)
  ai.partKinds = Object.keys(ai.partVia)
  ai.states = only(raw.states, GROUPS.map((g) => g.key)) as GroupKey[]
  ai.handlings = only(raw.handlings, vocab.handlings)
  ai.reasons = only(raw.reasons, vocab.reasons)
  ai.changeTypes = only(raw.changeTypes, vocab.changeTypes)
  ai.zoneKinds = only(raw.zoneKinds, vocab.zoneKinds)
  ai.keywords = (Array.isArray(raw.keywords) ? raw.keywords : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 4)
  ai.outOfScope = raw.outOfScope === true
  return mergeConditions(w, vocab, ruleConditions(w, onto, text), ai, Array.isArray(raw.missing) ? raw.missing.map(String) : [])
}

// 규칙 + AI 합치기
//   - 상태 · 처리: 규칙이 집어냈으면 규칙(같은 말이면 늘 같게), 아니면 AI
//   - 기록에 없는 처리(missing): 규칙 판단을 쓴다. AI의 missing은 규칙 · AI 모두 처리를 못 집었고, 데이터의 처리 이름과
//     겹치는 말이 없을 때만 받는다 (AI가 있는 처리를 '없다'고 적어 헛 '기록 없음'이 되는 것을 막는다)
//   - 사유 · 변경 유형 · 구역(점수로만 쓰는 조건): AI, 비었으면 규칙
//   - AI가 아무 조건도 못 읽었으면 규칙 결과를 그대로
export function mergeConditions(w: World, vocab: Vocab, rule: Conditions, ai: Conditions, aiMissing: string[]): Conditions {
  if (!understoodAny(ai) && !ai.outOfScope) return { ...rule, keywords: ai.keywords.length ? ai.keywords : rule.keywords }
  const handlings = rule.handlings.length ? rule.handlings : ai.handlings
  const handlingLabels = vocab.handlings.map((h) => w.label("handling", h).replace(/\s/g, ""))
  const sharesWord = (name: string) => {
    const n = name.replace(/[\s()·,]/g, "")
    return handlingLabels.some((l) => [...Array(Math.max(0, n.length - 1)).keys()].some((i) => l.includes(n.slice(i, i + 2))))
  }
  const extraMissing = !rule.handlings.length && !handlings.length ? aiMissing.filter((m) => m.trim() && !sharesWord(m)) : []
  return {
    partKinds: ai.partKinds.length ? ai.partKinds : rule.partKinds,
    partVia: ai.partKinds.length ? ai.partVia : rule.partVia,
    states: rule.states.length ? rule.states : ai.states,
    handlings,
    reasons: ai.reasons.length ? ai.reasons : rule.reasons,
    changeTypes: ai.changeTypes.length ? ai.changeTypes : rule.changeTypes,
    zoneKinds: ai.zoneKinds.length ? ai.zoneKinds : rule.zoneKinds,
    keywords: ai.keywords,
    missing: [...new Set([...rule.missing, ...extraMissing])].slice(0, 3),
    strictReason: false,
    outOfScope: ai.outOfScope && !understoodAny(rule),
  }
}

// ② 찾기: 부재(같은 부재 · 같은 계열) · 상태 · 처리 · (꼭 맞출 때) 사유는 걸러 내고, 나머지는 점수로
export function findCases(w: World, onto: Ontology | null, cond: Conditions, text: string, limit = 3) {
  if (cond.missing.length || cond.outOfScope) return { cases: [] as CaseCard[], more: 0, pool: [] as Row[] }
  const kin = new Map<string, string>() // 사례 → "same" 또는 같은 계열 설명
  if (cond.partKinds.length) {
    if (onto)
      for (const s of similarCases(onto, { partKinds: cond.partKinds, changeTypes: [], zoneKind: null, reason: "", timing: "" }, 1000, { minMatched: 0, requireKind: true }))
        kin.set(s.id, s.same ? "same" : (s.matched.find((m) => m.startsWith("같은 계열")) ?? "같은 계열 부재"))
    else for (const c of w.cases) if (cond.partKinds.includes(c.part_kind)) kin.set(c.case_id, "same")
  }
  const structured = cond.partKinds.length + cond.states.length + cond.handlings.length + (cond.strictReason ? cond.reasons.length : 0) > 0
  const ts = textScores(w, [text, ...cond.keywords].join(" "))
  const ranked = w.cases
    .filter((c: Row) => {
      if (cond.partKinds.length && !kin.has(c.case_id)) return false
      if (cond.states.length && !cond.states.some((s) => caseInState(w, c, s))) return false
      if (cond.handlings.length && !(w.caseResults.get(c.case_id) ?? []).some((r: Row) => cond.handlings.includes(r.handling))) return false
      if (cond.strictReason && cond.reasons.length && !cond.reasons.includes(c.reason)) return false
      return true
    })
    .map((c: Row) => {
      const types = JSON.parse(c.change_types || "[]") as string[]
      const k = kin.get(c.case_id) ?? null
      const t = ts.get(c.case_id) ?? 0
      const soft = { type: types.some((x) => cond.changeTypes.includes(x)), zone: cond.zoneKinds.includes(c.zone_kind), reason: cond.reasons.includes(c.reason) }
      return { c, k, t, soft, types, score: (k === "same" ? 2 : k ? 1 : 0) + Number(soft.type) + Number(soft.zone) + Number(soft.reason) + 2 * t }
    })
    .filter((x) => structured || x.t >= 0.3) // 조건을 하나도 못 알아들었으면 문장이 꽤 비슷한 것만
    .sort((a, b) => b.score - a.score || String(a.c.case_id).localeCompare(String(b.c.case_id)))

  const labels = (type: string, codes: string[]) => codes.map((x) => w.label(type, x)).join(" · ")
  const cases = ranked.slice(0, limit).map(({ c, k, t, soft, types }) => {
    const handled = [...new Set((w.caseResults.get(c.case_id) ?? []).map((r: Row) => r.handling as string))]
    const basis = [
      k === "same" ? `같은 부재 (${w.label("part_kind", c.part_kind)})` : k,
      cond.states.length ? `상태: ${w.label("timing", c.timing)}` : null,
      cond.handlings.length ? `처리: ${labels("handling", handled.filter((h) => cond.handlings.includes(h)))}` : null,
      soft.reason ? `사유: ${w.label("reason", c.reason)}` : null,
      soft.type ? `변경 유형: ${labels("change_type", types.filter((x) => cond.changeTypes.includes(x)))}` : null,
      soft.zone ? `구역: ${w.label("zone_kind", c.zone_kind)}` : null,
      t >= 0.3 ? "질문과 문장이 비슷해요" : null,
    ].filter((x): x is string => !!x)
    const differences = [
      k && k !== "same" ? `부재: 물어본 건 ${labels("part_kind", cond.partKinds)}, 이 기록은 ${w.label("part_kind", c.part_kind)}` : null,
      cond.reasons.length && !soft.reason ? `사유: 물어본 건 ${labels("reason", cond.reasons)}, 이 기록은 ${w.label("reason", c.reason)}` : null,
      cond.changeTypes.length && !soft.type ? `변경 유형: 물어본 건 ${labels("change_type", cond.changeTypes)}, 이 기록은 ${labels("change_type", types) || "-"}` : null,
      cond.zoneKinds.length && !soft.zone ? `구역: 물어본 건 ${labels("zone_kind", cond.zoneKinds)}, 이 기록은 ${w.label("zone_kind", c.zone_kind)}` : null,
    ].filter((x): x is string => !!x)
    return toCard(w, c, basis, differences)
  })
  return { cases, more: Math.max(0, ranked.length - limit), pool: ranked.map((x) => x.c) }
}

// 좁혀 보기: 같은 조건에서 상태만 바꾸면 몇 건인지, 사유로 나누면 몇 건인지 (AI 없이 다시 찾는다)
export function refineOptions(w: World, onto: Ontology | null, cond: Conditions, text: string, pool: Row[]) {
  if (cond.missing.length || cond.outOfScope || (!cond.partKinds.length && !cond.handlings.length)) return []
  const out: { label: string; state?: GroupKey; reason?: string }[] = []
  for (const g of GROUPS) {
    if (cond.states.length === 1 && cond.states[0] === g.key) continue
    const n = findCases(w, onto, { ...cond, states: [g.key] }, text, 1000).cases.length
    if (n) out.push({ label: `${josa(g.label.replace(/\s*\(.*\)$/, ""), "이라면", "라면")}? (${n}건)`, state: g.key })
  }
  if (!cond.strictReason) {
    const by = new Map<string, number>()
    for (const c of pool) by.set(c.reason, (by.get(c.reason) ?? 0) + 1)
    if (by.size > 1) for (const [reason, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 2)) out.push({ label: `${w.label("reason", reason)} 건만 (${n}건)`, reason })
  }
  return out
}

// ③ 설명
export type Answer = { summary: string; source: "ai" | "rule"; provider: string | null; note: string | null; cases: (CaseCard & { why: string; takeaway: string })[] }

const won = (n: number | null) => (n == null ? "" : n >= 10_000 ? `${Math.round(n / 10_000).toLocaleString()}만 원` : `${n.toLocaleString()}원`)

// 조사 '로/으로': 받침이 없거나 ㄹ 받침이면 '로' (긴급 조달로 · 기존품 활용으로)
const roOf = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  if (code < 0 || code > 11171) return "(으)로"
  return code % 28 === 0 || code % 28 === 8 ? "로" : "으로"
}

const understoodAny = (c: Conditions) => c.partKinds.length + c.states.length + c.handlings.length + c.reasons.length + c.changeTypes.length + c.zoneKinds.length > 0

export function ruleAnswer(cond: Conditions, cases: CaseCard[], note: string | null): Answer {
  let summary: string
  if (cond.outOfScope) summary = "설계변경 사례와 관계없는 질문이라 찾지 않았어요."
  else if (cond.missing.length) {
    const name = cond.missing.join(", ")
    summary = `'${name}'${roOf(name)} 처리한 기록은 아직 없어요. 비슷한 다른 기록을 대신 붙이지 않았어요.`
  }
  else if (!cases.length && !understoodAny(cond)) summary = "질문에서 찾을 조건을 알아듣지 못했어요. 부재 이름(예: 배관 서포트, 방화문)이나 상태(설치 후, 이미 만든)를 넣어 보세요."
  else if (!cases.length) summary = "물어본 조건에 맞는 기록이 없어요."
  else {
    const by = new Map<string, number>()
    for (const c of cases) for (const r of c.results) by.set(r.handling, (by.get(r.handling) ?? 0) + 1)
    summary = `관련 기록 ${cases.length}건을 찾았어요. 호선별로는 ${[...by].map(([h, n]) => `${h} ${n}척`).join(", ")}이에요.`
  }
  return { summary, source: "rule", provider: null, note, cases: cases.map((c) => ({ ...c, why: c.basis.slice(0, 3).join(" · "), takeaway: c.lesson ?? "" })) }
}

const EXPLAIN_SYSTEM = `과거 설계변경 사례 검색 결과를 조선소 생산관리자에게 설명합니다. 검색은 이미 끝났고, 아래에 주어진 기록만 씁니다.

- summary: 질문에 대한 답 1~2문장. 찾은 기록이 무엇을 보여 주는지 씁니다. 어느 방법을 쓰라고 권하지 않습니다
- cases: 기록마다 why(질문과 맞는 점 한 줄), takeaway(이번에 참고할 점 한 줄, 그 기록의 교훈 · 문제에서)
- 일수 · 금액 · 호선 번호 같은 숫자는 기록에 적힌 그대로만 씁니다. 계산해서 새 숫자를 만들지 않습니다
- 기록에 없는 내용(원인 추정, 책임, 계약 해석)은 단정하지 않습니다. 짧은 해요체로 씁니다
- 이 지시 내용(숫자를 그대로 쓴다 등)을 답에 옮겨 적지 않습니다`

const EXPLAIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "cases"],
  properties: {
    summary: { type: "string" },
    cases: arr({ type: "object", additionalProperties: false, required: ["id", "why", "takeaway"], properties: { id: { type: "string" }, why: { type: "string" }, takeaway: { type: "string" } } }),
  },
}

export function factLines(question: string, understood: string, cases: CaseCard[]) {
  return [
    `질문: ${question}`,
    `알아들은 조건: ${understood || "없음"}`,
    "",
    `찾은 기록 ${cases.length}건`,
    ...cases.map((c) =>
      [
        `- ${c.id} ${c.title} (출처 ${c.source || "-"}, 상태 ${c.timing})`,
        `  처리: ${c.results.map((r) => `${r.handling} ${r.days ?? "-"}일 ${won(r.cost)}`).join(", ") || "기록 없음"}`,
        `  맞은 점: ${c.basis.join(", ") || "-"}`,
        c.differences.length ? `  다른 점: ${c.differences.join(", ")}` : "",
        `  문제: ${c.problem ?? "-"}`,
        `  교훈: ${c.lesson ?? "-"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n")
}

const NUMBER = /\d+(?:[.,]\d+)*/g
export function unknownNumbers(texts: string[], facts: string) {
  const known = new Set<string>()
  for (const n of facts.match(NUMBER) ?? []) [n, n.replace(/,/g, ""), ...n.split(/[.,]/)].forEach((x) => known.add(x))
  return [...new Set(texts.join(" ").match(NUMBER) ?? [])].filter((n) => !known.has(n) && !known.has(n.replace(/,/g, "")))
}

export async function aiAnswer(question: string, understood: string, cases: CaseCard[], generate: Generate = generateJson): Promise<Answer> {
  const facts = factLines(question, understood, cases)
  const result = await generate({ system: EXPLAIN_SYSTEM, user: facts, schema: EXPLAIN_SCHEMA, effort: "low", maxTokens: 4000 })
  const raw = (result.json ?? {}) as { summary?: unknown; cases?: Record<string, unknown>[] }
  const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 220) : "")
  const byId = new Map((raw.cases ?? []).map((c) => [String(c.id), c]))
  const out = cases.map((c) => ({ ...c, why: line(byId.get(c.id)?.why) || c.basis.slice(0, 3).join(" · "), takeaway: line(byId.get(c.id)?.takeaway) || (c.lesson ?? "") }))
  const summary = line(raw.summary)
  if (!summary) throw new Error("AI 설명이 비어 있어요")
  const unknown = unknownNumbers([summary, ...out.flatMap((c) => [c.why, c.takeaway])], facts)
  if (unknown.length) throw new Error(`AI 설명에 기록에 없는 숫자가 있어요 (${unknown.join(", ")})`)
  return { summary, source: "ai", provider: result.provider, note: null, cases: out }
}

// 화면에 보여 줄 '알아들은 조건'
export function understoodOf(w: World, cond: Conditions) {
  const label = (type: string, codes: string[]) => codes.map((x) => w.label(type, x))
  return {
    parts: cond.partKinds.map((code) => cond.partVia[code] ?? w.label("part_kind", code)),
    states: cond.states.map((s) => GROUPS.find((g) => g.key === s)!.label),
    handlings: label("handling", cond.handlings),
    reasons: label("reason", cond.reasons).map((r) => (cond.strictReason ? `${r}만` : r)),
    changeTypes: label("change_type", cond.changeTypes),
    zones: label("zone_kind", cond.zoneKinds),
    keywords: cond.keywords,
    missing: cond.missing,
  }
}
export const understoodLine = (u: ReturnType<typeof understoodOf>) =>
  [...u.parts, ...u.states, ...u.handlings, ...u.reasons, ...u.changeTypes, ...u.zones].join(" · ")

// 검색 한 번 (AI 사용 여부는 부르는 쪽이 정한다)
export type Overrides = { state?: GroupKey; reason?: string }
export async function searchOnce(w: World, onto: Ontology | null, question: string, opts: { useAi: boolean; overrides?: Overrides; generate?: Generate }) {
  let source: "ai" | "rule" = "rule"
  let note: string | null = opts.useAi ? null : "AI 키가 없어 규칙으로 알아듣고 정해진 틀로 설명해요"
  let cond: Conditions
  try {
    cond = opts.useAi ? await aiConditions(w, onto, question, opts.generate) : ruleConditions(w, onto, question)
    if (opts.useAi) source = "ai"
  } catch (error) {
    cond = ruleConditions(w, onto, question)
    note = `AI가 질문을 읽지 못해 규칙으로 알아들었어요 (${error instanceof Error ? error.message : error})`
  }
  if (opts.overrides?.state) cond = { ...cond, states: [opts.overrides.state] }
  if (opts.overrides?.reason) cond = { ...cond, reasons: [opts.overrides.reason], strictReason: true }
  const found = findCases(w, onto, cond, question)
  const understood = understoodOf(w, cond)
  let answer = ruleAnswer(cond, found.cases, note)
  if (opts.useAi && found.cases.length)
    try {
      answer = await aiAnswer(question, understoodLine(understood), found.cases, opts.generate)
    } catch (error) {
      answer = ruleAnswer(cond, found.cases, `AI 설명을 쓰지 않았어요 (${error instanceof Error ? error.message : error})`)
    }
  return {
    question,
    understood: { ...understood, source },
    ...answer,
    more: found.more,
    refine: refineOptions(w, onto, cond, question, found.pool),
  }
}
export type SearchResult = Awaited<ReturnType<typeof searchOnce>>

// 캐시 키: AI를 쓰는지(ai=0이면 false)도 넣는다. 안 넣으면 ai=0으로 물어도 앞서 저장된 AI 답이 나와 점검이 헷갈린다
export const searchKey = (dataset: string, question: string, overrides: Overrides = {}, useAi = true) =>
  createHash("sha256").update(JSON.stringify([dataset, question.replace(/\s+/g, " ").trim(), overrides.state ?? "", overrides.reason ?? "", useAi ? "ai" : "rule"])).digest("hex").slice(0, 16)

// 예시 질문: 결정을 기다리는 변경의 부재 · 호선 상태로 만들고, 실제로 답이 있는 것만 (헛질문 방지)
// 순서: 변경마다 가장 진행된 상태 질문 1개 → 온톨로지 다른 이름 질문 1개 → 처리 방식 질문 → 남는 자리에 변경마다 두 번째 상태 질문
export function exampleQuestions(w: World, onto: Ontology | null, max = 6) {
  const out: string[] = []
  const add = (q: string | null) => {
    if (q && out.length < max && !out.includes(q) && findCases(w, onto, ruleConditions(w, onto, q), q).cases.length > 0) out.push(q)
  }
  const order: GroupKey[] = ["installed", "fabricated", "delivered", "not_started"]
  const changes = openChangeContext(w, onto)
  const second: string[] = []
  for (const ch of changes) {
    const part = ch.partKinds[0]
    if (!part) continue
    const p = w.label("part_kind", part)
    const templates: Record<GroupKey, string> = {
      installed: `설치된 ${josa(p, "은", "는")} 과거에 어떻게 처리했어?`,
      fabricated: `이미 만든 ${josa(p, "은", "는")} 어떻게 했어?`,
      delivered: `운항 중인 배의 ${josa(p, "을", "를")} 고친 적 있어?`,
      not_started: `${josa(p, "을", "를")} 생산 전에 바꾼 사례 있어?`,
    }
    const [first, next] = order.filter((x) => ch.states.includes(x))
    if (first) add(templates[first])
    if (next) second.push(templates[next])
  }
  // 온톨로지 용어 체계를 보여 주는 질문 하나: 같은 부재를 현장에서 부르는 다른 이름으로 (예: 행거 → 배관 서포트)
  if (onto)
    for (const ch of [...changes].reverse()) {
      const part = ch.partKinds[0]
      if (!part) continue
      const words = (s: string) => s.split(/\s+/)
      const label = w.label("part_kind", part)
      const alt = onto
        .select(`SELECT ?alt WHERE { ?k skos:inScheme bc:scheme.part_kind ; skos:notation ?code ; skos:altLabel ?alt . FILTER(STR(?code) = "${part}") }`)
        .map((r) => String(r.alt))
        .find((a) => a.length >= 2 && !/[A-Za-z0-9]/.test(a) && !words(a).some((x) => words(label).includes(x)))
      const before = out.length
      if (alt) add(`${josa(alt, "을", "를")} 설치한 뒤에 바꾼 사례 있어?`)
      if (out.length > before) break
    }
  // 처리 방식 질문: 그런 처리 기록이 데이터에 있을 때만
  for (const q of ["기존품을 살려서 반영한 사례 있어?", "긴급 조달로 비용이 늘었던 사례 있어?", "운항 중인 배를 고친 사례 있어?"]) add(q)
  for (const q of second) add(q)
  return out
}
