// 온톨로지 그래프 탐색: 객체 하나에서 이웃을 펼치는 질의들 (화면 · 테스트 공통, 브라우저 · Node Oxigraph 모두)
// 점 = 개념(owl:Class)의 개별 객체 + 일부 용어(SKOS). 선 = 객체 사이 관계.
// 특정 데이터셋 · 변경 번호를 박지 않는다. 숨길 표 · 용어 체계는 스키마 수준 이름이라 어느 데이터셋에도 같다
import { PREFIXES, select, type SparqlStore } from "./queries"

const BO = "https://basis.local/onto#"
const BC = "https://basis.local/code#"

export type Kind = "change" | "common" | "perHull" | "person" | "case" | "concept" | "other"
export type GNode = { id: string; label: string; cls: string; clsLabel: string; kind: Kind }
export type GLink = { id: string; source: string; target: string; label: string }
export type Neighbor = { node: GNode; link: GLink; group: string }
export type ClassInfo = { id: string; name: string; label: string; group: string; section: string; scope: "" | "SeriesCommon" | "PerHull"; systems: string; count: number }

// 점으로 그리지 않는 표: 연결표 · 기록 행. 바로 가는 관계(affectsPart · scopeHull · responsibleFor …)나 아래 조직표 관계로 대신 잇는다
const HIDDEN = ["ChangeAffectedPart", "ChangeMaterial", "ChangeHullScope", "SolutionTarget", "OperationDependency", "Responsibility", "ProjectAssignment", "CaseParticipant", "CaseTask", "CaseHullResult", "Dataset"].map((n) => BO + n)
// 점으로 그리는 용어 체계: 부품 ↔ 과거 사례를 잇는 부재 종류, 변경 ↔ 사례를 잇는 변경 사유. 나머지 코드값은 상세의 속성으로
const NODE_SCHEMES = ["scheme.part_kind", "scheme.reason"].map((n) => BC + n)
// 관계로 치지 않는 것 (거의 모든 객체에 붙는 확실성 · 출처 시스템 코드)
const SKIP_PROPS = ["http://www.w3.org/1999/02/22-rdf-syntax-ns#type", `${BO}certainty`, `${BO}sourceSystem`, "http://www.w3.org/2004/02/skos/core#inScheme", "http://www.w3.org/2004/02/skos/core#topConceptOf"]

// 외래키 열 이름 → 관계 이름 (스키마 열 이름이라 데이터셋과 무관)
const ROLE_NAMES: Record<string, string> = {
  owner_id: "선주",
  class_society_id: "선급",
  supplier_id: "공급사",
  builder_id: "제작사",
  registered_by: "등록자",
  decided_by: "결정자",
  start_hull_id: "적용 시작 호선",
  detected_hull_id: "발견 호선",
  applies_from_hull: "적용 시작 호선",
  contact_employee_id: "창구 직원",
  foreman_employee_id: "반장",
  revision_before: "변경 전 개정",
  revision_after: "변경 후 개정",
  baseline_revision_id: "기준 개정",
  observed_revision_id: "확인된 개정",
  instruction_revision_id: "지시 개정",
  from_revision_id: "기존 개정",
  to_revision_id: "적용 개정",
  supersedes_quote_id: "이전 견적",
  related_event_id: "관련 생산 실적",
  successor_id: "후행 작업",
  predecessor_id: "선행 작업",
}
export function propName(label: string) {
  const m = label.match(/^(.*?)\s*\(([a-z_]+)\)$/)
  if (!m) return label
  return ROLE_NAMES[m[2]] ?? m[1]
}

const q = (store: SparqlStore, body: string) => select(store, `${PREFIXES}${body}`)
const iri = (s: string) => `<${s}>`
export const local = (id: string) => id.replace(/^.*[#/]/, "")

// 그래프 하나를 그리는 동안 바뀌지 않는 것: 개념 · 관계 이름표
export type Catalog = { classes: Map<string, ClassInfo>; props: Map<string, string>; schemes: Map<string, string> }

export function catalog(store: SparqlStore): Catalog {
  const classes = new Map<string, ClassInfo>()
  for (const r of q(
    store,
    `SELECT ?c ?label ?group ?section ?scope ?systems (COUNT(?x) AS ?n) WHERE {
      ?c a owl:Class ; rdfs:label ?label . FILTER(isIRI(?c))
      OPTIONAL { ?c bo:group ?group } OPTIONAL { ?c bo:section ?section } OPTIONAL { ?c bo:sourceSystems ?systems }
      OPTIONAL { ?c rdfs:subClassOf ?top . VALUES ?top { bo:SeriesCommon bo:PerHull } BIND(STRAFTER(STR(?top), "#") AS ?scope) }
      OPTIONAL { ?x a ?c }
    } GROUP BY ?c ?label ?group ?section ?scope ?systems`,
  )) {
    classes.set(r.c, {
      id: r.c,
      name: local(r.c),
      label: r.label,
      group: r.group ?? "",
      section: r.section ?? "",
      scope: (r.scope ?? "") as ClassInfo["scope"],
      systems: r.systems ?? "",
      count: Number(r.n ?? 0),
    })
  }
  // 관계 이름표는 열 이름 꼬리 '(owner_id)'까지 그대로 둔다 (역할 이름을 고를 때 쓴다)
  const props = new Map(q(store, `SELECT ?p ?l WHERE { ?p rdfs:label ?l . ?p a ?k . VALUES ?k { owl:ObjectProperty owl:DatatypeProperty } }`).map((r) => [r.p, r.l]))
  props.set("http://www.w3.org/2004/02/skos/core#broader", "상위 종류")
  const schemes = new Map(q(store, `SELECT ?s ?l WHERE { ?c skos:inScheme ?s . ?s rdfs:label|skos:prefLabel ?l }`).map((r) => [r.s, r.l]))
  return { classes, props, schemes }
}

function kindOf(info: ClassInfo | undefined): Kind {
  if (!info) return "other"
  if (info.name === "DesignChange") return "change"
  if (info.group === "과거 사례") return "case"
  if (info.group === "사람 · 조직" || info.name === "Department") return "person"
  if (info.scope === "PerHull") return "perHull"
  if (info.scope === "SeriesCommon") return "common"
  return "other"
}

// 객체 하나의 이름 · 종류. 숨긴 표의 행이나 속성으로만 보이는 코드값이면 null
export function nodeOf(store: SparqlStore, cat: Catalog, id: string): GNode | null {
  const rows = q(store, `SELECT ?c ?sch ?l WHERE { OPTIONAL { ${iri(id)} a ?c . ?c a owl:Class } OPTIONAL { ${iri(id)} skos:inScheme ?sch } OPTIONAL { ${iri(id)} rdfs:label|skos:prefLabel ?l } }`)
  return toNode(cat, id, rows)
}

function toNode(cat: Catalog, id: string, rows: Array<Record<string, string>>): GNode | null {
  const label = rows.find((r) => r.l)?.l ?? local(id)
  const cls = rows.map((r) => r.c).find((c) => c && cat.classes.has(c) && !HIDDEN.includes(c))
  if (cls) {
    const info = cat.classes.get(cls)!
    return { id, label, cls, clsLabel: info.label, kind: kindOf(info) }
  }
  const sch = rows.map((r) => r.sch).find((s) => s && NODE_SCHEMES.includes(s))
  if (sch) return { id, label, cls: sch, clsLabel: cat.schemes.get(sch) ?? "용어", kind: "concept" }
  return null
}

// 객체에서 한 걸음 이웃 전부 (관계 묶음 이름 붙여서). 펼칠 때 몇 개까지 그릴지는 화면이 정한다
export function neighbors(store: SparqlStore, cat: Catalog, id: string): Neighbor[] {
  const selfLabel = nodeOf(store, cat, id)?.clsLabel ?? ""
  const skip = SKIP_PROPS.map(iri).join(", ")
  const rows = q(
    store,
    `SELECT ?p ?dir ?y ?c ?sch ?l WHERE {
      { ${iri(id)} ?p ?y . BIND("out" AS ?dir) } UNION { ?y ?p ${iri(id)} . BIND("in" AS ?dir) }
      FILTER(isIRI(?y) && ?p NOT IN (${skip}))
      OPTIONAL { ?y a ?c . ?c a owl:Class }
      OPTIONAL { ?y skos:inScheme ?sch }
      OPTIONAL { ?y rdfs:label|skos:prefLabel ?l }
    }`,
  )
  const byKey = new Map<string, Array<Record<string, string>>>()
  for (const r of rows) {
    const key = `${r.dir}|${r.p}|${r.y}`
    byKey.set(key, [...(byKey.get(key) ?? []), r])
  }
  const out: Neighbor[] = []
  const seen = new Set<string>()
  for (const [key, rs] of byKey) {
    const [dir, p, y] = key.split("|")
    if (y === id) continue
    const node = toNode(cat, y, rs)
    if (!node) continue
    const raw = cat.props.get(p) ?? local(p)
    const name = propName(raw)
    const link: GLink = dir === "out" ? { id: `${id}|${p}|${y}`, source: id, target: y, label: name } : { id: `${y}|${p}|${id}`, source: y, target: id, label: name }
    if (seen.has(link.id)) continue
    seen.add(link.id)
    // 묶음 이름: 나가는 관계는 관계 이름, 들어오는 관계는 상대 종류 (+ 관계 이름이 이쪽 종류와 다르면 그 이름: '설계변경 · 검토 대상 호선')
    const col = raw.match(/\(([a-z_]+)\)$/)?.[1]
    const role = col ? ROLE_NAMES[col] : name !== selfLabel ? name : ""
    const group = dir === "out" ? name : role ? `${node.clsLabel} · ${role}` : node.clsLabel
    out.push({ node, link, group })
  }
  // 조직표(숨긴 표)는 직원 → 호선(없으면 시리즈) 관계 하나로
  for (const r of q(
    store,
    `SELECT ?e ?t ?role WHERE {
      ?a bo:ProjectAssignment.employee ?e ; bo:ProjectAssignment.series ?s ; bo:ProjectAssignment.assignmentRole/skos:prefLabel ?role .
      OPTIONAL { ?a bo:ProjectAssignment.hull ?h } BIND(COALESCE(?h, ?s) AS ?t)
      FILTER(?e = ${iri(id)} || ?t = ${iri(id)})
    }`,
  )) {
    const other = r.e === id ? r.t : r.e
    const node = nodeOf(store, cat, other)
    if (!node) continue
    const link: GLink = { id: `${r.e}|assignment|${r.t}|${r.role}`, source: r.e, target: r.t, label: `조직표 · ${r.role}` }
    if (seen.has(link.id)) continue
    seen.add(link.id)
    out.push({ node, link, group: r.e === id ? "프로젝트 조직표" : "프로젝트 조직표 · 직원" })
  }
  return out.sort((a, b) => a.group.localeCompare(b.group, "ko") || a.node.label.localeCompare(b.node.label, "ko", { numeric: true }))
}

// 값 속성의 이름표는 아직 DB 열 이름(planned_start …)이라, 화면에서는 낱말 사전으로 한글 이름을 붙인다
//   통째 이름 → 낱말별 → 못 옮기면 열 이름 그대로. 바뀌는 건 표시뿐 (온톨로지 파일은 그대로)
const COLUMN_WHOLE: Record<string, string> = {
  as_of: "기준 시각",
  name_ko: "이름",
  label_ko: "이름",
  note_ko: "메모",
  unit_price_krw: "단가 (원)",
  ld_per_day_krw: "일 지체상금 (원)",
  ld_cap_krw: "지체상금 한도 (원)",
  qty_per_hull: "호선당 수량",
  hours_per_unit: "단위당 시간",
  is_department_head: "부서장 여부",
  owner_share_pct: "선주 분담 (%)",
  progress_pct: "진척 (%)",
  float_days: "공정 여유 (일)",
  valid_from: "유효 시작",
  valid_to: "유효 종료",
  valid_until: "유효 기한",
  built_from: "생성 근거",
  original_text: "원문",
  spec_text: "사양",
  max_local_delay_days: "최대 지연 (일)",
  standard_lead_days: "표준 조달 기간 (일)",
  actual_duration_days: "실제 소요 (일)",
  delivery_delay_days: "인도 지연 (일)",
  post_delivery_allowed: "인도 후 개조 허용",
  ecr_code: "ECR 번호",
  uom: "단위",
  at: "시각",
  key: "키",
  lesson: "교훈",
  problem: "문제",
  notation: "코드",
}
const COLUMN_WORDS: Record<string, string> = {
  planned: "계획", actual: "실제", scheduled: "예정", confirmed: "확정", contract: "계약", delivery: "인도", date: "일자", start: "시작", finish: "종료",
  install: "설치", fabrication: "제작", component: "부품", qty: "수량", unit: "단위", price: "가격", cost: "비용", krw: "(원)", note: "메모", name: "이름",
  label: "이름", title: "제목", reason: "사유", text: "내용", spec: "사양", before: "변경 전", after: "변경 후", drawing: "도면", no: "번호", received: "접수",
  occurred: "발생", recorded: "기록", created: "생성", system: "시스템", sort: "정렬", order: "순서", source: "출처", hull: "호선", value: "값", num: "(숫자)",
  issued: "발행", state: "상태", status: "상태", line: "줄", series: "시리즈", event: "이벤트", code: "코드", kind: "종류", type: "종류", party: "관여자",
  zone: "구역", version: "버전", delta: "변화", open: "미결", usability: "사용 가능", rationale: "근거", location: "위치", area: "영역", metric: "지표",
  stock: "재고", days: "일수", day: "일", duration: "기간", part: "부품", evidence: "근거", predecessors: "선행 작업", old: "이전", new: "새", offered: "제시",
  material: "자재", requested: "요청", log: "기록", result: "결과", condition: "조건", conditions: "조건", employee: "직원", quote: "견적", term: "조건",
  standard: "표준", option: "대안", inspected: "검사", description: "설명", ordered: "발주", calendar: "달력", owner: "선주", available: "가용", hours: "시간",
  production: "생산", item: "품목", lead: "조달", allocation: "할당", expected: "예상", internal: "내부", proposed: "제안", solution: "설계안",
  inspection: "검사", required: "필요", block: "블록", last: "최근", checked: "확인", task: "할 일", department: "부서", mandatory: "필수", edited: "수정",
  released: "배포", approval: "결재", memo: "메모", dependency: "선후", revision: "개정", labor: "공수", applies: "적용", to: "대상", crew: "작업 인원",
  priority: "우선순위", rank: "순위", auto: "자동", done: "완료", ref: "근거", provider: "제공", decided: "결정", receipt: "입고", change: "변경",
  progress: "진척", schedule: "일정", acceptance: "인수", yard: "조선소", seq: "순번", action: "동작", specification: "사양", stage: "단계",
  explanation: "설명", case: "사례", work: "작업", meeting: "회의", active: "사용 중", comment: "의견", trigger: "발생 조건", confirmation: "확인",
  resource: "작업장", group: "", subject: "제목", detail: "상세", share: "분담", pct: "(%)", local: "국부", max: "최대", delay: "지연", per: "당",
  integration: "연동", float: "여유", snapshot: "당시 값", input: "입력", system_name: "시스템 이름", from: "시작",
}
// 화면에 보이지 않는 내부 열: 다른 객체를 가리키는 키(관계로 이미 그림) · 원시 JSON · 계산 지문
const HIDDEN_COLUMN = /(_id|_key|_table|_column|_json|_kind_ref)$|^(requested_by_kind|object_type|input_fingerprint|engine_version|id)$/
export function columnName(raw: string) {
  if (!/^[a-z_0-9]+$/.test(raw)) return raw
  if (COLUMN_WHOLE[raw]) return COLUMN_WHOLE[raw]
  const words = raw.split("_").map((w) => COLUMN_WORDS[w])
  if (words.some((w) => w === undefined)) return raw
  return words.filter(Boolean).join(" ").replace(/\s+\(/g, " (")
}

// 상세 패널의 속성: 값(리터럴)과 점으로 그리지 않는 코드값
export type Attr = { name: string; value: string; raw: boolean }
export function attributes(store: SparqlStore, cat: Catalog, id: string): Attr[] {
  const rows = q(
    store,
    `SELECT ?p ?o ?ol ?osch ?nodeLike WHERE {
      ${iri(id)} ?p ?o . FILTER(?p NOT IN (${iri(SKIP_PROPS[0])}, rdfs:label, skos:prefLabel, skos:inScheme, skos:broader))
      OPTIONAL { ?o skos:prefLabel ?ol . OPTIONAL { ?o skos:inScheme ?osch } }
      OPTIONAL { ?o a ?oc . ?oc a owl:Class . BIND(true AS ?nodeLike) }
    }`,
  )
  const out: Attr[] = []
  for (const r of rows) {
    if (r.nodeLike === "true") continue
    if (/^https?:/.test(r.o) && !r.ol) continue
    if (r.osch && NODE_SCHEMES.includes(r.osch)) continue // 점으로 그리는 용어는 '연결'에
    const label = cat.props.get(r.p) ?? local(r.p)
    if (HIDDEN_COLUMN.test(label)) continue
    const name = /^[a-z_0-9]+$/.test(label) ? columnName(label) : propName(label)
    out.push({ name, value: r.ol ?? r.o, raw: /^[a-z_0-9]+$/.test(name) })
  }
  // 한글 이름이 붙은 것부터, 열 이름 그대로인 것은 뒤로
  return out.sort((a, b) => Number(a.raw) - Number(b.raw))
}

// 개념(종류)별 개별 객체 목록 · 전체 검색용 이름표
export function instancesOf(store: SparqlStore, cat: Catalog, cls: string): GNode[] {
  const info = cat.classes.get(cls)
  return q(store, `SELECT ?x ?l WHERE { ?x a ${iri(cls)} . OPTIONAL { ?x rdfs:label ?l } }`)
    .map((r) => ({ id: r.x, label: r.l ?? local(r.x), cls, clsLabel: info?.label ?? "", kind: kindOf(info) }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko", { numeric: true }))
}

export function searchIndex(store: SparqlStore, cat: Catalog): GNode[] {
  const out: GNode[] = []
  for (const r of q(store, `SELECT ?x ?c ?l WHERE { ?x a ?c ; rdfs:label ?l . ?c a owl:Class }`)) {
    const info = cat.classes.get(r.c)
    if (!info || HIDDEN.includes(r.c)) continue
    out.push({ id: r.x, label: r.l, cls: r.c, clsLabel: info.label, kind: kindOf(info) })
  }
  return out
}

// 왼쪽 목록에 보일 개념: 숨긴 표 · 빈 표를 빼고 묶음별로
export function visibleClasses(cat: Catalog) {
  const groups = new Map<string, ClassInfo[]>()
  for (const c of cat.classes.values()) {
    if (!c.count || HIDDEN.includes(c.id)) continue
    const key = c.group || "기타"
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  return [...groups.entries()]
    .map(([group, list]) => ({ group, section: list[0].section, list: list.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.group.localeCompare(b.group, "ko"))
}
