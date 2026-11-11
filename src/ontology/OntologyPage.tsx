// 온톨로지 화면: 데이터 계약에서 자동으로 만든 조선소 지식 그래프를 브라우저 안 그래프 DB(Oxigraph · WebAssembly)에 올려 탐색한다.
// 이 화면을 열 때만 불러온다 (App의 lazy). 지금 연 프로젝트(dataset)의 그래프만 올린다
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import init, { Store } from "oxigraph/web.js"
import wasmUrl from "oxigraph/web_bg.wasm?url"
import { CHANGES_QUERY, PREFIXES, select } from "./queries"
import "./ontology.css"

// 그래프 그리기(cytoscape)는 그래프 DB가 올라온 뒤에 받는다
const GraphExplorer = lazy(() => import("./GraphExplorer"))

type Index = {
  schema: { file: string; triples: number; hash: string }
  datasets: Array<{ id: string; name: string; asOf: string; file: string; triples: number }>
}

const BASE = `${import.meta.env.BASE_URL}ontology/`
let wasm: Promise<unknown> | null = null
const texts = new Map<string, Promise<string>>()
const fetchText = (file: string) => {
  let p = texts.get(file)
  if (!p) {
    p = fetch(`${BASE}${file}`).then((r) => {
      if (!r.ok) throw new Error(`${file} 불러오기 실패 (${r.status})`)
      return r.text()
    })
    texts.set(file, p)
  }
  return p
}

async function openStore(index: Index, file: string) {
  wasm ??= init({ module_or_path: wasmUrl })
  const [, schema, data] = await Promise.all([wasm, fetchText(index.schema.file), fetchText(file)])
  const store = new Store()
  store.load(schema, { format: "text/turtle" })
  store.load(data, { format: "text/turtle" })
  return store
}

const asOfText = (asOf: string) => asOf.replace("T", " ").replace(/:00Z$|Z$/, "")
const n = (v: string | number | undefined) => Number(v ?? 0).toLocaleString("ko-KR")

const COUNTS = `${PREFIXES}SELECT
  (COUNT(DISTINCT ?c) AS ?classes)
  (SUM(IF(BOUND(?x), 1, 0)) AS ?objects)
  WHERE { ?c a owl:Class . FILTER(isIRI(?c)) OPTIONAL { ?x a ?c } }`
const REL_TYPES = `${PREFIXES}SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a owl:ObjectProperty }`

export default function OntologyPage({ dataset: datasetId }: { dataset: string }) {
  const [index, setIndex] = useState<Index | null>(null)
  const [store, setStore] = useState<Store | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch(`${BASE}index.json`)
      .then((r) => r.json() as Promise<Index>)
      .then(setIndex)
      .catch((e) => setError(String(e)))
  }, [])

  const dataset = index?.datasets.find((d) => d.id === datasetId)
  useEffect(() => {
    if (!index) return
    if (!dataset) {
      setError(`온톨로지 파일 없음: ${datasetId}`)
      return
    }
    let alive = true
    setStore(null)
    openStore(index, dataset.file)
      .then((s) => alive && setStore(s))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [index, dataset, datasetId])

  const stats = useMemo(() => {
    if (!store) return null
    const c = select(store, COUNTS)[0] ?? {}
    return { triples: store.size, classes: c.classes, objects: c.objects, rels: select(store, REL_TYPES)[0]?.n }
  }, [store])
  // 처음 펼칠 객체: 부품이 가장 많이 걸린 설계변경
  const seed = useMemo(() => (store ? (select(store, CHANGES_QUERY)[0]?.c ?? "") : ""), [store])

  return (
    <div className="onto-page">
      <div className="page-title">
        <div>
          <h1>온톨로지</h1>
          <p>{dataset ? `${dataset.name.replace(/\s*\([^)]*\)\s*$/, "")} · 지식 그래프` : "지식 그래프"}</p>
        </div>
      </div>

      {stats && (
        <div className="onto-stats">
          <div>
            <strong className="numeric">{n(stats.objects)}</strong>
            <span>객체</span>
          </div>
          <div>
            <strong className="numeric">{n(stats.classes)}</strong>
            <span>개념 (OWL 클래스)</span>
          </div>
          <div>
            <strong className="numeric">{n(stats.rels)}</strong>
            <span>관계 종류</span>
          </div>
          <div>
            <strong className="numeric">{n(stats.triples)}</strong>
            <span>트리플</span>
          </div>
          {dataset && <span className="source" title="그래프: 데이터셋 원래 날짜 · 설계변경 · 일정 화면: 기준 시점을 오늘로 이동">데이터 스냅숏 {asOfText(dataset.asOf)} (다른 화면은 오늘 기준) · 브라우저 내 그래프 DB (Oxigraph)</span>}
        </div>
      )}

      {error && <div className="card onto-error">{error}</div>}
      {!store && !error && <div className="card onto-loading">그래프 DB 불러오는 중</div>}
      {store && (
        <Suspense fallback={<div className="card onto-loading">그래프 화면 불러오는 중</div>}>
          <GraphExplorer store={store} seed={seed} />
        </Suspense>
      )}
    </div>
  )
}
