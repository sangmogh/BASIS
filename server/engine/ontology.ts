// 엔진이 온톨로지를 읽는 곳 (public/ontology/schema.ttl + <데이터셋>.ttl → 그래프 DB Oxigraph → SPARQL)
//   숫자 계산(날짜 · 비용)은 DB(연동 시스템 데이터)로 하고, 아래 다섯 가지는 온톨로지로 한다
//   ① 비슷한 사례: 부재 계층(skos:broader)을 따라 같은 부재가 없으면 같은 계열 부재 사례까지
//   ② 직접 입력: 용어 체계(skos:prefLabel · altLabel)로 문장을 부재 종류에 맞춘다
//   ③ 근거 연결 경로: 설계변경 → 부품 → 호선 위치 → 블록 → 담당자 (그래프를 따라감)
//   ④ 시리즈 공통 / 호선마다 다름: 개념 분류(bo:SeriesCommon · bo:PerHull)로 변경에 걸린 사실을 나눈다
//   ⑤ 대응안 규칙의 사실: B는 긴급 조달 견적, C는 보강 설계안 · 대상 부품 위치 · 호선 운항 여부 (review.ts optionRules)
// 시점: 온톨로지 파일은 DB 행을 전부 담는다. 엔진과 같은 시점(horizon = as_of 또는 반영한 새 소식의 마지막 시각)까지
//   알려진 사실(bo:knownAt ≤ horizon)만 보도록 질의마다 거른다
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const PREFIX = `PREFIX bo: <https://basis.local/onto#>
PREFIX bc: <https://basis.local/code#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`
export type Ontology = { datasetId: string; base: string; triples: number; schemaHash: string | null; select: (q: string) => Record<string, string>[] }

export const ontologyDir = () => resolve(process.env.BASIS_ONTOLOGY_DIR ?? join(process.cwd(), "public", "ontology"))
const cache = new Map<string, Ontology | null>()

// 데이터셋의 온톨로지 (없으면 null → 엔진은 DB 규칙으로 대신하고 '대체값'에 적는다)
export function loadOntology(datasetId: string): Ontology | null {
  if (cache.has(datasetId)) return cache.get(datasetId)!
  const dir = ontologyDir()
  const schemaFile = join(dir, "schema.ttl")
  const dataFile = join(dir, `${datasetId}.ttl`)
  if (!/^[a-z0-9_-]{1,40}$/i.test(datasetId) || !existsSync(schemaFile) || !existsSync(dataFile)) {
    cache.set(datasetId, null)
    return null
  }
  const require = createRequire(import.meta.url)
  const { Store } = require("oxigraph") as typeof import("oxigraph")
  const store = new Store()
  store.load(readFileSync(schemaFile, "utf8"), { format: "text/turtle" })
  store.load(readFileSync(dataFile, "utf8"), { format: "text/turtle" })
  const select = (q: string) =>
    (store.query(PREFIX + q) as Map<string, { value: string }>[]).map((m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.value])))
  const index = join(dir, "index.json")
  const onto: Ontology = {
    datasetId,
    base: `https://basis.local/data/${datasetId}/`,
    triples: store.size,
    schemaHash: existsSync(index) ? ((JSON.parse(readFileSync(index, "utf8")) as { schema?: { hash?: string } }).schema?.hash ?? null) : null,
    select,
  }
  cache.set(datasetId, onto)
  return onto
}

const iri = (o: Ontology, table: string, key: string) => `<${o.base}${table}/${encodeURIComponent(key)}>`
// horizon 뒤에 알게 된 행은 뺀다 (bo:knownAt이 없는 행은 늘 알려진 것). 시각은 변환기와 같이 초까지 맞춘다
const knownBy = (v: string, horizon?: string) =>
  horizon ? `FILTER NOT EXISTS { ${v} bo:knownAt ${v}_known . FILTER(${v}_known > "${horizon.replace(/(T\d{2}:\d{2})(Z|[+-]|$)/, "$1:00$2")}"^^xsd:dateTime) }` : ""
const keyOf = (value: string) => decodeURIComponent(value.split("/").pop() ?? "")
const code = (scheme: string, c: string) => `bc:${scheme}.${encodeURIComponent(c)}`
// https://basis.local/code#part_kind.pipe_support → pipe_support ('#' 뒤, 용어 체계 이름 다음 점부터)
const local = (value: string) => {
  const frag = value.includes("#") ? value.slice(value.indexOf("#") + 1) : value
  return decodeURIComponent(frag.slice(frag.indexOf(".") + 1))
}

// ── ① 비슷한 사례 (다섯 기준: 부재 · 변경 유형 · 구역 · 사유 · 시점). 부재는 같은 종류 → 같은 계열(부재 계층) 순
export type CaseQuery = { partKinds: string[]; changeTypes: string[]; zoneKind: string | null; reason: string; timing: string }
export function similarCases(o: Ontology, q: CaseQuery, limit = 3, opts: { minMatched?: number; requireKind?: boolean } = {}) {
  const { minMatched = 2, requireKind = true } = opts
  if (!q.partKinds.length) return []
  const targets = q.partKinds.map((k) => code("part_kind", k)).join(" ")
  // 부재 계층: 바뀌는 부재와 같은 계열(같은 skos:broader)의 부재 종류
  const family = new Map(
    o
      .select(`SELECT ?k ?groupLabel WHERE { VALUES ?t { ${targets} } ?t skos:broader ?g . ?k skos:broader ?g . ?g skos:prefLabel ?groupLabel . }`)
      .map((r) => [local(r.k), r.groupLabel]),
  )
  const rows = o.select(`SELECT ?case ?label ?kind ?kindLabel ?zone ?reason ?timing ?lesson ?at (GROUP_CONCAT(STR(?ct); separator=" ") AS ?types) WHERE {
    ?case a bo:PastCase ; rdfs:label ?label ; bo:PastCase.partKind ?kind .
    ?kind skos:prefLabel ?kindLabel .
    OPTIONAL { ?case bo:PastCase.zoneKind ?zone } OPTIONAL { ?case bo:PastCase.reason ?reason } OPTIONAL { ?case bo:PastCase.timing ?timing }
    OPTIONAL { ?case bo:PastCase.lesson ?lesson } OPTIONAL { ?case bo:PastCase.occurredAt ?at } OPTIONAL { ?case bo:PastCase.changeTypes ?ct }
  } GROUP BY ?case ?label ?kind ?kindLabel ?zone ?reason ?timing ?lesson ?at`)
  return rows
    .map((r) => {
      const kind = local(r.kind)
      const types = String(r.types ?? "").split(" ").filter(Boolean).map(local)
      const same = q.partKinds.includes(kind)
      const sibling = !same && family.has(kind)
      const hits = [
        same ? "부재" : sibling ? `같은 계열 부재 (${family.get(kind)} · ${r.kindLabel})` : null,
        types.some((t) => q.changeTypes.includes(t)) ? "변경 유형" : null,
        q.zoneKind && r.zone && local(r.zone) === q.zoneKind ? "구역" : null,
        r.reason && local(r.reason) === q.reason ? "사유" : null,
        r.timing && local(r.timing) === q.timing ? "시점" : null,
      ].filter((x): x is string => !!x)
      return { id: keyOf(r.case), title: String(r.label).replace(/^\S+\s/, ""), matched: hits, same, sibling, lesson: r.lesson ?? null, at: r.at ?? "" }
    })
    .filter((c) => c.matched.length >= minMatched && (!requireKind || c.same || c.sibling))
    .sort((a, b) => b.matched.length - a.matched.length || Number(b.same) - Number(a.same) || b.at.localeCompare(a.at))
    .slice(0, limit)
}

// ── ② 직접 입력 문장 → 부재 종류 후보 (이름 · 다른 이름이 문장에 들어 있으면 점수). 사람이 확인해서 고른다
export function matchPartKinds(o: Ontology, text: string, limit = 3) {
  const squash = (s: string) => s.replace(/[\s·・\-_/]+/g, "").toLowerCase()
  const t = squash(text)
  const rows = o.select(`SELECT ?k ?code ?label ?alt ?groupLabel WHERE {
    ?k skos:inScheme bc:scheme.part_kind ; skos:notation ?code ; skos:prefLabel ?label .
    OPTIONAL { ?k skos:altLabel ?alt } OPTIONAL { ?k skos:broader ?g . ?g skos:prefLabel ?groupLabel }
  }`)
  const byCode = new Map<string, { code: string; label: string; group: string | null; terms: Set<string>; score: number }>()
  for (const r of rows) {
    const e = byCode.get(r.code) ?? { code: r.code, label: r.label, group: r.groupLabel ?? null, terms: new Set<string>(), score: 0 }
    for (const [term, weight] of [
      [r.label, 1],
      [r.alt, 0.8],
    ] as const) {
      if (!term || !t.includes(squash(term)) || e.terms.has(term)) continue
      e.terms.add(term)
      e.score += squash(term).length * weight
    }
    byCode.set(r.code, e)
  }
  return [...byCode.values()]
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ code: e.code, label: e.label, group: e.group, matched: [...e.terms], score: Math.round(e.score * 10) / 10 }))
}

// 부재 종류의 부품들 (직접 입력에서 고를 후보: 부품 → 놓인 블록 · 구역)
export function partsOfKind(o: Ontology, kind: string) {
  return o
    .select(`SELECT ?part ?label (COUNT(DISTINCT ?occ) AS ?places) (SAMPLE(?zoneLabel) AS ?zone) WHERE {
      ?part a bo:Part ; bo:Part.partKind ${code("part_kind", kind)} ; rdfs:label ?label .
      OPTIONAL { ?occ bo:PartOccurrence.part ?part ; bo:PartOccurrence.block ?b . OPTIONAL { ?b bo:Block.zoneCode ?z . ?z rdfs:label ?zoneLabel } }
    } GROUP BY ?part ?label ORDER BY ?label`)
    .map((r) => ({ partId: keyOf(r.part), label: r.label, places: Number(r.places ?? 0), zone: r.zone ?? null }))
}

// ── ③ 근거 연결 경로: 설계변경 → 부품 → 호선 위치 → 블록 → 담당자 (+ 도면 담당 · 자재 담당)
//   연결표의 지름길(bo:affectsPart · bo:changesMaterial)은 알게 된 시각이 없어서, 시점을 거를 때는 연결표 행을 따라간다
export function connectionPaths(o: Ontology, changeId: string, horizon?: string) {
  const c = iri(o, "change", changeId)
  const classLabel = Object.fromEntries(
    o.select(`SELECT ?c ?l WHERE { VALUES ?c { bo:DesignChange bo:Part bo:PartOccurrence bo:Block bo:Employee bo:Material bo:Hull } ?c rdfs:label ?l }`).map((r) => [r.c.split("#")[1], r.l]),
  )
  const rows = o.select(`SELECT ?part ?partLabel ?designerLabel ?hull ?hullLabel ?block ?blockLabel ?foremanLabel WHERE {
    ?cap bo:ChangeAffectedPart.change ${c} ; bo:ChangeAffectedPart.part ?part . ${knownBy("?cap", horizon)}
    ?part rdfs:label ?partLabel . ${knownBy("?part", horizon)}
    OPTIONAL { ?designer bo:responsibleFor ?part ; rdfs:label ?designerLabel }
    OPTIONAL { ?occ bo:PartOccurrence.part ?part ; bo:PartOccurrence.hull ?hull ; bo:PartOccurrence.block ?block .
               ?hull rdfs:label ?hullLabel . ?block rdfs:label ?blockLabel . ${knownBy("?occ", horizon)}
               OPTIONAL { ?foreman bo:responsibleFor ?block ; rdfs:label ?foremanLabel } }
  }`)
  const materials = o.select(`SELECT ?m ?label ?buyerLabel WHERE {
    ?cm bo:ChangeMaterial.change ${c} ; bo:ChangeMaterial.material ?m . ${knownBy("?cm", horizon)}
    ?m rdfs:label ?label . ${knownBy("?m", horizon)}
    OPTIONAL { ?buyer bo:responsibleFor ?m ; rdfs:label ?buyerLabel } }`)
  const count = (key: string) => new Set(rows.map((r) => r[key]).filter(Boolean)).size
  const people = new Set([...rows.flatMap((r) => [r.designerLabel, r.foremanLabel]), ...materials.map((m) => m.buyerLabel)].filter(Boolean))
  return {
    chips: [
      { kind: classLabel.DesignChange ?? "설계변경", count: 1 },
      { kind: classLabel.Part ?? "부품", count: count("part") },
      { kind: classLabel.Hull ?? "호선", count: count("hull") },
      { kind: classLabel.Block ?? "블록", count: count("block") },
      { kind: classLabel.Employee ?? "직원", count: people.size },
    ],
    paths: rows
      .filter((r) => r.hull)
      .map((r) => ({ hullId: keyOf(r.hull), hull: r.hullLabel, part: r.partLabel, block: r.blockLabel, foreman: r.foremanLabel ?? null, designer: r.designerLabel ?? null }))
      .sort((a, b) => a.hullId.localeCompare(b.hullId) || a.part.localeCompare(b.part)),
    materials: materials.map((m) => ({ material: m.label, buyer: m.buyerLabel ?? null })),
  }
}

// ── ④ 시리즈 공통 / 호선마다 다름: 변경과 이어진 사실을 개념 분류로 나눈다
//   시점까지 알려진 사실만, 다른 견적으로 대체된 견적은 뺀다 (엔진의 견적 목록과 같게)
export function seriesSplit(o: Ontology, changeId: string, horizon?: string) {
  const c = iri(o, "change", changeId)
  const rows = o.select(`SELECT DISTINCT ?scope ?cls ?clsLabel ?x ?xLabel WHERE {
    { ?x ?p ${c} }
    UNION { ${c} ?p ?x . FILTER(?p NOT IN (bo:affectsPart, bo:changesMaterial, bo:scopeHull)) }
    UNION { ?l bo:ChangeAffectedPart.change ${c} ; bo:ChangeAffectedPart.part ?x . ${knownBy("?l", horizon)} }
    UNION { ?l bo:ChangeMaterial.change ${c} ; bo:ChangeMaterial.material ?x . ${knownBy("?l", horizon)} }
    UNION { ?l bo:ChangeHullScope.change ${c} ; bo:ChangeHullScope.hull ?x . ${knownBy("?l", horizon)} }
    UNION { ?l bo:ChangeAffectedPart.change ${c} ; bo:ChangeAffectedPart.part ?pt . ${knownBy("?l", horizon)} ?x ?q ?pt }
    UNION { ?l bo:ChangeAffectedPart.change ${c} ; bo:ChangeAffectedPart.part ?pt . ${knownBy("?l", horizon)} ?occ bo:PartOccurrence.part ?pt . ?x ?r ?occ }
    ${knownBy("?x", horizon)}
    FILTER NOT EXISTS { ?newer bo:SupplierQuote.supersedesQuote ?x . ${knownBy("?newer", horizon)} }
    ?x a ?cls . ?cls rdfs:subClassOf ?scope . FILTER(?scope = bo:SeriesCommon || ?scope = bo:PerHull)
    ?cls rdfs:label ?clsLabel . OPTIONAL { ?x rdfs:label ?xLabel }
  }`)
  const group = (scope: string) => {
    const by = new Map<string, { concept: string; count: number; examples: string[] }>()
    for (const r of rows.filter((x) => x.scope.endsWith(scope))) {
      const g = by.get(r.clsLabel) ?? { concept: r.clsLabel, count: 0, examples: [] }
      g.count++
      if (g.examples.length < 3 && r.xLabel) g.examples.push(r.xLabel)
      by.set(r.clsLabel, g)
    }
    return [...by.values()].sort((a, b) => a.concept.localeCompare(b.concept))
  }
  return { common: group("SeriesCommon"), perHull: group("PerHull") }
}

// ── ⑤ 대응안 규칙의 사실 (시점까지 알려진 것만). 규칙 자체는 review.ts optionRules
//   견적: 이 변경의 견적 중 다른 견적으로 대체되지 않은 것 (조달 경로 = 견적 채널)
//   설계안: 이 변경의 설계안과 그 대상 부품 위치 · 위치가 놓인 호선의 운항 여부
export type OptionFacts = {
  quotes: { id: string; channel: string; supplier: string | null }[]
  solutions: { id: string; kind: string; targets: { occurrenceId: string; inService: boolean }[] }[]
}
export function optionFacts(o: Ontology, changeId: string, horizon?: string): OptionFacts {
  const c = iri(o, "change", changeId)
  const quotes = o.select(`SELECT ?q ?ch ?supplier WHERE {
    ?q a bo:SupplierQuote ; bo:SupplierQuote.change ${c} ; bo:SupplierQuote.channel ?ch . ${knownBy("?q", horizon)}
    FILTER NOT EXISTS { ?newer bo:SupplierQuote.supersedesQuote ?q . ${knownBy("?newer", horizon)} }
    OPTIONAL { ?q bo:SupplierQuote.supplier ?s . ?s rdfs:label ?supplier }
  } ORDER BY ?q`)
  const solutions = o.select(`SELECT ?s ?kind WHERE {
    ?s a bo:EngineeringSolution ; bo:EngineeringSolution.change ${c} ; bo:EngineeringSolution.kind ?kind . ${knownBy("?s", horizon)}
  } ORDER BY ?s`)
  const targets = o.select(`SELECT ?s ?occ ?life WHERE {
    ?s bo:EngineeringSolution.change ${c} . ${knownBy("?s", horizon)}
    ?t a bo:SolutionTarget ; bo:SolutionTarget.solution ?s ; bo:SolutionTarget.occurrence ?occ . ${knownBy("?t", horizon)}
    OPTIONAL { ?occ bo:PartOccurrence.hull ?h . ?h bo:Hull.lifecycleStatus ?life }
  }`)
  return {
    quotes: quotes.map((q) => ({ id: keyOf(q.q), channel: local(q.ch), supplier: q.supplier ?? null })),
    solutions: solutions.map((s) => ({
      id: keyOf(s.s),
      kind: local(s.kind),
      targets: targets.filter((t) => t.s === s.s).map((t) => ({ occurrenceId: keyOf(t.occ), inService: !!t.life && local(t.life) === "in_service" })),
    })),
  }
}
