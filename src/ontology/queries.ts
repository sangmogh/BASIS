// 온톨로지 화면의 SPARQL 질문들. 화면(브라우저 Oxigraph)과 테스트(Node Oxigraph)가 같은 질문을 쓴다.
// 모든 질문은 고른 설계변경 하나를 받아서 돈다 (특정 변경 번호 · 호선 번호를 박지 않음)

export const PREFIXES = `PREFIX bo: <https://basis.local/onto#>
PREFIX bc: <https://basis.local/code#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
`

// 브라우저 · Node Oxigraph 공통으로 쓰는 만큼만
export type Term = { termType: string; value: string }
export type Binding = Map<string, Term>
export type SparqlStore = { query(q: string): unknown; size: number }

export function select(store: SparqlStore, sparql: string): Array<Record<string, string>> {
  const result = store.query(sparql)
  if (!Array.isArray(result)) return []
  return (result as Binding[]).map((b) => {
    const row: Record<string, string> = {}
    b.forEach((term, key) => (row[key] = term.value))
    return row
  })
}

export type Preset = {
  id: string
  step: string // 서비스 흐름의 몇 번째 단계인가
  title: string
  question: string
  columns: Array<[string, string]> // [변수, 한글 머리글]
  sparql: (change: string) => string
}

export const PRESETS: Preset[] = [
  {
    id: "split",
    step: "구조",
    title: "시리즈 공통 vs 호선마다 다름",
    question: "이 변경에 걸린 사실 중 한 번만 보면 되는 것과 호선마다 봐야 하는 것은?",
    columns: [
      ["scope", "구분"],
      ["concept", "개념"],
      ["n", "사실 수"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?scope ?concept (COUNT(DISTINCT ?x) AS ?n) WHERE {
  {
    ?x ?anyLink <${c}> .
  } UNION {
    <${c}> bo:affectsPart ?x .
  } UNION {
    <${c}> bo:changesMaterial ?x .
  } UNION {
    <${c}> bo:affectsPart ?part . ?x bo:PartRevision.part ?part .
  } UNION {
    <${c}> bo:affectsPart ?part . ?x bo:PartOccurrence.part ?part .
  } UNION {
    <${c}> bo:affectsPart ?part . ?occ bo:PartOccurrence.part ?part . ?x bo:ProductionItem.occurrence ?occ .
  } UNION {
    <${c}> bo:affectsPart ?part . ?occ bo:PartOccurrence.part ?part . ?item bo:ProductionItem.occurrence ?occ .
    ?x bo:ProductionEvent.productionItem ?item .
  } UNION {
    ?quote bo:SupplierQuote.change <${c}> . ?x bo:SupplierQuoteLine.quote ?quote .
  }
  ?x a ?cls .
  ?cls rdfs:subClassOf ?top ; rdfs:label ?concept .
  VALUES ?top { bo:SeriesCommon bo:PerHull }
  ?top rdfs:label ?scope .
}
GROUP BY ?scope ?concept
ORDER BY ?scope DESC(?n)`,
  },
  {
    id: "parts",
    step: "① 변경 → 부품",
    title: "이 변경이 건드리는 부품",
    question: "변경 요청 한 건이 어떤 부품 · 도면을 바꾸나? (시리즈 공통)",
    columns: [
      ["part", "부품"],
      ["kind", "부재 종류"],
      ["workType", "공종"],
      ["before", "바꾸기 전 개정"],
      ["after", "바꾼 뒤 개정"],
      ["qty", "호선당 수량 변화"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?part ?kind ?workType ?before ?after ?qty WHERE {
  ?link bo:ChangeAffectedPart.change <${c}> ;
        bo:ChangeAffectedPart.part ?p ;
        bo:ChangeAffectedPart.revisionBefore ?rb ;
        bo:ChangeAffectedPart.qtyChange ?qty .
  OPTIONAL { ?link bo:ChangeAffectedPart.revisionAfter/rdfs:label ?after }
  ?p rdfs:label ?part ;
     bo:Part.partKind/skos:prefLabel ?kind ;
     bo:Part.workType/skos:prefLabel ?workType .
  ?rb rdfs:label ?before .
}
ORDER BY ?part`,
  },
  {
    id: "hulls",
    step: "② 공통 부품 → 호선",
    title: "공통 부품이 호선마다 놓인 곳",
    question: "같은 부품이 각 호선의 어느 블록에 몇 개 있나?",
    columns: [
      ["hull", "호선"],
      ["blocks", "블록"],
      ["positions", "위치 수"],
      ["qty", "필요 수량"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?hull (GROUP_CONCAT(DISTINCT ?blockCode; separator=", ") AS ?blocks) (COUNT(DISTINCT ?occ) AS ?positions) (SUM(?q) AS ?qty) WHERE {
  <${c}> bo:affectsPart ?p .
  ?occ bo:PartOccurrence.part ?p ;
       bo:PartOccurrence.hull ?h ;
       bo:PartOccurrence.block/bo:Block.blockCode ?blockCode ;
       bo:PartOccurrence.requiredQty ?q .
  ?h rdfs:label ?hull ; bo:Hull.hullSeq ?seq .
}
GROUP BY ?hull ?seq
ORDER BY ?seq`,
  },
  {
    id: "status",
    step: "③ 호선마다 상태",
    title: "호선마다 실제 제작 · 설치 상태",
    question: "각 호선에서 그 부품을 벌써 만들었나, 설치했나? (MES 실적)",
    columns: [
      ["hull", "호선"],
      ["stage", "호선 단계"],
      ["scope", "적용 범위"],
      ["positions", "위치"],
      ["fabricated", "제작 완료"],
      ["installed", "설치 완료"],
      ["delivery", "인도 예정"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?hull ?stage ?scope ?delivery (COUNT(DISTINCT ?occ) AS ?positions) (COUNT(DISTINCT ?fab) AS ?fabricated) (COUNT(DISTINCT ?ins) AS ?installed) WHERE {
  <${c}> bo:affectsPart ?p .
  ?occ bo:PartOccurrence.part ?p ; bo:PartOccurrence.hull ?h .
  ?h rdfs:label ?hull ; bo:Hull.hullSeq ?seq ; bo:Hull.lifecycleStatus/skos:prefLabel ?stage .
  OPTIONAL { ?h bo:Hull.plannedDeliveryDate ?delivery }
  OPTIONAL { ?sc bo:ChangeHullScope.change <${c}> ; bo:ChangeHullScope.hull ?h ; bo:ChangeHullScope.scopeState/skos:prefLabel ?scope }
  OPTIONAL {
    ?item bo:ProductionItem.occurrence ?occ .
    OPTIONAL { ?fe bo:ProductionEvent.productionItem ?item ; bo:ProductionEvent.eventKind/skos:notation "fabricated" . BIND(?item AS ?fab) }
    OPTIONAL { ?ie bo:ProductionEvent.productionItem ?item ; bo:ProductionEvent.eventKind/skos:notation "installed" . BIND(?item AS ?ins) }
  }
}
GROUP BY ?hull ?seq ?stage ?scope ?delivery
ORDER BY ?seq`,
  },
  {
    id: "quotes",
    step: "④ A · B 재료",
    title: "조달 경로별 견적",
    question: "A 일반 조달 · B 긴급 조달 규칙이 읽는 견적 사실은? (계산 결과가 아니라 입력 사실)",
    columns: [
      ["channel", "조달 경로"],
      ["quote", "견적"],
      ["state", "견적 상태"],
      ["material", "자재"],
      ["unitPrice", "단가(원)"],
      ["delivery", "납기"],
      ["commitment", "확약"],
      ["certainty", "확실성"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?channel ?quote ?state ?material ?unitPrice ?delivery ?commitment ?certainty WHERE {
  ?q bo:SupplierQuote.change <${c}> ;
     rdfs:label ?quote ;
     bo:SupplierQuote.channel/skos:prefLabel ?channel ;
     bo:SupplierQuote.quoteState/skos:prefLabel ?state .
  ?line bo:SupplierQuoteLine.quote ?q ;
        bo:SupplierQuoteLine.material/rdfs:label ?material ;
        bo:SupplierQuoteLine.unitPriceKrw ?unitPrice ;
        bo:SupplierQuoteLine.deliveryDate ?delivery .
  OPTIONAL { ?line bo:SupplierQuoteLine.commitmentState/skos:prefLabel ?commitment }
  OPTIONAL { ?q bo:certainty/skos:prefLabel ?certainty }
}
ORDER BY ?channel ?quote`,
  },
  {
    id: "solutions",
    step: "④ C 재료",
    title: "설계안과 승인 상태",
    question: "C 기존 부품 보강이 가능한가? 보강안이 있고 기술 · 품질 · 선급 승인이 났나?",
    columns: [
      ["solution", "설계안"],
      ["kind", "종류"],
      ["technical", "기술"],
      ["quality", "품질"],
      ["classState", "선급"],
      ["positions", "적용 위치"],
      ["condition", "조건"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?solution ?kind ?technical ?quality ?classState (COUNT(DISTINCT ?occ) AS ?positions) (SAMPLE(?cond) AS ?condition) WHERE {
  ?s bo:EngineeringSolution.change <${c}> ;
     rdfs:label ?solution ;
     bo:EngineeringSolution.kind/skos:prefLabel ?kind ;
     bo:EngineeringSolution.technicalState/skos:prefLabel ?technical ;
     bo:EngineeringSolution.qualityState/skos:prefLabel ?quality ;
     bo:EngineeringSolution.classState/skos:prefLabel ?classState .
  OPTIONAL { ?s bo:targetsOccurrence ?occ }
  OPTIONAL { ?t bo:SolutionTarget.solution ?s ; bo:SolutionTarget.conditionNote ?cond }
}
GROUP BY ?solution ?kind ?technical ?quality ?classState
ORDER BY ?solution`,
  },
  {
    id: "cases",
    step: "근거",
    title: "그래프로 이어진 과거 사례",
    question: "같은 부재 종류, 또는 같은 계열(부재 계층 초안)의 과거 사례는? 구역까지 같으면 위로",
    columns: [
      ["case", "과거 사례"],
      ["match", "이어진 길"],
      ["zone", "구역"],
      ["lesson", "교훈"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?case ?match ?zone ?lesson WHERE {
  { SELECT DISTINCT ?k WHERE { <${c}> bo:affectsPart/bo:Part.partKind ?k } }
  {
    ?pc bo:PastCase.partKind ?k .
    BIND("같은 부재 종류" AS ?match) BIND(1 AS ?rank)
  } UNION {
    ?k skos:broader ?g . ?k2 skos:broader ?g . FILTER(?k2 != ?k)
    ?pc bo:PastCase.partKind ?k2 .
    ?g skos:prefLabel ?gl .
    BIND(CONCAT("같은 계열 · ", STR(?gl)) AS ?match) BIND(2 AS ?rank)
  }
  ?pc rdfs:label ?case .
  OPTIONAL { ?pc bo:PastCase.lesson ?lesson }
  OPTIONAL { <${c}> bo:DesignChange.zoneCode/bo:Zone.zoneKind ?zk . ?pc bo:PastCase.zoneKind ?zk . BIND("같은 구역" AS ?zone) }
}
ORDER BY ?rank DESC(BOUND(?zone)) ?case
LIMIT 20`,
  },
  {
    id: "people",
    step: "담당",
    title: "누가 맡나 (시스템 담당 관계)",
    question: "부품 · 도면은 설계자, 자재는 구매, 블록은 반장, 시리즈는 주관자 · PM. 지금 유효한 담당만",
    columns: [
      ["role", "역할"],
      ["employee", "직원"],
      ["what", "맡는 것"],
      ["objects", "대상 수"],
    ],
    sparql: (c) => `${PREFIXES}
SELECT ?role ?employee ?what ?objects WHERE {
  {
    SELECT ?role ?employee (GROUP_CONCAT(DISTINCT ?kind; separator=", ") AS ?what) (COUNT(DISTINCT ?o) AS ?objects) WHERE {
      {
        <${c}> bo:affectsPart ?o . BIND("부품 · 도면" AS ?kind)
      } UNION {
        <${c}> bo:changesMaterial ?o . BIND("자재" AS ?kind)
      } UNION {
        <${c}> bo:affectsPart ?p . ?occ bo:PartOccurrence.part ?p ; bo:PartOccurrence.block ?o . BIND("블록" AS ?kind)
      }
      ?r bo:responsibilityObject ?o ;
         bo:Responsibility.employee/rdfs:label ?employee ;
         bo:Responsibility.roleCode/skos:prefLabel ?role .
      FILTER NOT EXISTS { ?r bo:Responsibility.validTo ?until }
    }
    GROUP BY ?role ?employee
  } UNION {
    <${c}> bo:DesignChange.series ?s .
    ?a bo:ProjectAssignment.series ?s ;
       bo:ProjectAssignment.assignmentRole/skos:prefLabel ?role ;
       bo:ProjectAssignment.employee/rdfs:label ?employee .
    FILTER NOT EXISTS { ?a bo:ProjectAssignment.validTo ?until }
    FILTER NOT EXISTS { ?a bo:ProjectAssignment.hull ?anyHull }
    BIND("시리즈 전체" AS ?what) BIND(1 AS ?objects)
  }
}
ORDER BY ?role ?employee`,
  },
]

export const FREE_QUERY = `${PREFIXES}
# 자유 질의 예시: 데이터 계약의 개념(표)을 묶음별로
SELECT ?group ?concept ?table WHERE {
  ?cls a owl:Class ; rdfs:label ?concept ; bo:group ?group ; bo:table ?table .
}
ORDER BY ?group ?concept`

export const CHANGES_QUERY = `${PREFIXES}
SELECT ?c ?label (COUNT(DISTINCT ?p) AS ?parts) WHERE {
  ?c a bo:DesignChange ; rdfs:label ?label .
  OPTIONAL { ?c bo:affectsPart ?p }
}
GROUP BY ?c ?label
ORDER BY DESC(?parts) ?label`

export const STATS_QUERIES: Array<[string, string]> = [
  ["개념(클래스)", `${PREFIXES}SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a owl:Class . FILTER(isIRI(?c)) }`],
  ["관계(객체 속성)", `${PREFIXES}SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a owl:ObjectProperty }`],
  ["값 속성", `${PREFIXES}SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a owl:DatatypeProperty }`],
  ["용어(SKOS 개념)", `${PREFIXES}SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a skos:Concept }`],
  ["개별 사실", `${PREFIXES}SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { ?x a ?c . ?c a owl:Class . FILTER(isIRI(?c)) }`],
]
