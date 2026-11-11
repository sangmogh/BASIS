// 온톨로지 그래프 탐색 (객체 하나에서 이웃 펼치기)
//   왼쪽: 개념(종류) 목록 · 검색 = 개념 층(OWL)   가운데: 개별 객체 그래프 = 사실 층   오른쪽: 고른 객체의 속성 · 연결
//   점 더블클릭 또는 '연결 펼치기' → 한 걸음 이웃을 관계 묶음마다 최대 PER_GROUP개씩 그린다
import { useEffect, useMemo, useRef, useState } from "react"
import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type StylesheetJson } from "cytoscape"
import type { Store } from "oxigraph/web.js"
import { attributes, catalog, instancesOf, local, neighbors, nodeOf, searchIndex, visibleClasses, type Catalog, type GNode, type Kind, type Neighbor } from "./graph"
import { iconSvg, iconUri } from "./icons"

export const KIND_COLOR: Record<Kind, string> = {
  change: "#ef6461",
  common: "#4f8ff7",
  perHull: "#e9a23b",
  person: "#2fb38a",
  case: "#a083f5",
  concept: "#7d8ea6",
  other: "#6d8099",
}
const LEGEND: Array<[Kind, string]> = [
  ["change", "설계변경"],
  ["common", "시리즈 공통"],
  ["perHull", "호선마다 다름"],
  ["person", "사람 · 조직"],
  ["case", "과거 사례"],
  ["concept", "용어 (SKOS)"],
  ["other", "기타"],
]
// 한 번 펼칠 때 그리는 최대 개수: 관계 묶음마다 PER_GROUP개, 모두 MAX_EXPAND개 (나머지는 오른쪽 '연결' → '모두 표시')
const PER_GROUP = 6
const SEED_PER_GROUP = 10 // 처음 객체(설계변경)는 호선 10척이 다 보이게
const MAX_EXPAND = 36
const BG = "#ffffff" // 그래프 바탕 (흰색, 화면의 다른 카드와 같게)
const FONT = "Pretendard Variable, Pretendard, sans-serif" // cytoscape는 따옴표 붙은 글꼴 이름을 못 읽는다

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// 점 아래 이름: 과거 사례처럼 긴 이름은 ' — ' 앞까지
const nodeLabel = (n: GNode) => short(n.label.split(" — ")[0], n.kind === "change" ? 26 : 22)
const clsKey = (n: GNode) => (n.kind === "concept" ? "concept" : local(n.cls))

const STYLE: StylesheetJson = [
  {
    selector: "node",
    style: {
      width: "data(size)",
      height: "data(size)",
      "background-color": "data(color)",
      "background-image": "data(icon)",
      "background-width": "52%",
      "background-height": "52%",
      "border-width": 2,
      "border-color": BG,
      label: "data(label)",
      color: "#33445a",
      "font-size": 10.5,
      "font-family": FONT,
      "font-weight": 600,
      "text-valign": "bottom",
      "text-halign": "center",
      "text-margin-y": 6,
      "text-outline-color": BG,
      "text-outline-width": 3,
      "min-zoomed-font-size": 5,
      "transition-property": "opacity",
      "transition-duration": 150,
    },
  },
  { selector: "node[kind = 'change']", style: { "font-size": 12.5, "font-weight": 700, color: "#142235" } },
  { selector: "node[kind = 'concept']", style: { shape: "round-rectangle", "border-style": "dashed", "border-color": "#5f7189", "border-width": 1.5 } },
  { selector: "node[?expanded]", style: { "border-color": "#9aa8b9", "border-width": 2 } },
  {
    selector: "node:selected",
    style: { "border-color": "#142235", "border-width": 2.5, "underlay-color": "data(color)", "underlay-opacity": 0.22, "underlay-padding": 10, "underlay-shape": "ellipse" },
  },
  { selector: "node.faded", style: { opacity: 0.22 } },
  {
    selector: "edge",
    style: {
      width: 1.3,
      "line-color": "#c5cfda",
      "target-arrow-color": "#c5cfda",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.75,
      "curve-style": "bezier",
      "transition-property": "opacity",
      "transition-duration": 150,
    },
  },
  { selector: "edge.hl", style: { width: 1.6, "line-color": "#5b86c4", "target-arrow-color": "#5b86c4", "z-index": 9 } },
  {
    selector: "edge.lbl",
    style: {
      label: "data(label)",
      "font-size": 9.5,
      "font-family": FONT,
      "font-weight": 600,
      color: "#1f4f8f",
      "text-rotation": "autorotate",
      "text-background-color": BG,
      "text-background-opacity": 0.92,
      "text-background-padding": "2px",
      "text-background-shape": "roundrectangle",
      "z-index": 9,
    },
  },
  { selector: "edge.faded", style: { opacity: 0.25 } },
]

export default function GraphExplorer({ store, seed }: { store: Store; seed: string }) {
  const cat = useMemo(() => catalog(store), [store])
  const box = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const selectedRef = useRef("")
  const [selected, setSelected] = useState("")
  const [version, setVersion] = useState(0) // 그래프가 바뀔 때마다 (오른쪽 ✓ 표시 갱신)
  const bump = () => setVersion((v) => v + 1)
  const cy = () => cyRef.current!

  const toEl = (n: GNode): ElementDefinition => ({
    group: "nodes",
    data: { id: n.id, label: nodeLabel(n), kind: n.kind, color: KIND_COLOR[n.kind], icon: iconUri(clsKey(n), "#ffffff"), size: n.kind === "change" ? 52 : 36 },
  })

  // 새 점을 기준 점 둘레에 둥글게 펼친다 (기준 점에서 퍼져 나오는 애니메이션).
  //   그래프에 다른 점이 있으면: 기준 점을 그래프 바깥쪽으로 밀어 둘레가 비게 하고, 그래프 쪽(뒤쪽) 60°는 비워 둔다.
  //   점이 많으면 두 겹으로 엇갈려 놓아 이름이 겹치지 않게 한다 (이웃은 관계 묶음 순서라 같은 묶음이 모인다)
  const spread = (fresh: string[], around: string, animate = true) => {
    const g = cy()
    const pn = g.getElementById(around)
    const p0 = { ...pn.position() }
    const others = (g.nodes().toArray() as NodeSingular[]).filter((n) => n.id() !== around && !fresh.includes(n.id()))
    const k = fresh.length
    const twoRings = k > 14
    const r1 = Math.max(130, (k * (twoRings ? 46 : 70)) / (2 * Math.PI))
    const outer = twoRings ? r1 + 90 : r1
    let dir = { x: 0, y: -1 }
    let gap = 0
    if (others.length) {
      const cx = others.reduce((a, n) => a + n.position().x, 0) / others.length
      const cyy = others.reduce((a, n) => a + n.position().y, 0) / others.length
      const len = Math.hypot(p0.x - cx, p0.y - cyy)
      if (len > 1) dir = { x: (p0.x - cx) / len, y: (p0.y - cyy) / len }
      gap = Math.PI / 3
    }
    const clear = (x: number, y: number) => others.every((n) => Math.hypot(n.position().x - x, n.position().y - y) > outer + 50)
    let shift = 0
    while (others.length && shift < 4000 && !clear(p0.x + dir.x * shift, p0.y + dir.y * shift)) shift += 40
    const pc = { x: p0.x + dir.x * shift, y: p0.y + dir.y * shift }
    const start = Math.atan2(-dir.y, -dir.x) + gap / 2
    const span = Math.PI * 2 - gap
    const opts = { duration: 480, easing: "ease-out-cubic" as const }
    if (shift && animate) pn.animate({ position: pc }, opts)
    else if (shift) pn.position(pc)
    fresh.forEach((id, i) => {
      const a = gap ? start + (span * (i + 0.5)) / k : start + (span * i) / k
      const r = twoRings && i % 2 ? r1 + 90 : r1
      const to = { x: pc.x + r * Math.cos(a), y: pc.y + r * Math.sin(a) }
      const n = g.getElementById(id)
      if (animate) {
        n.position(p0)
        n.animate({ position: to }, opts)
      } else n.position(to)
    })
    return pc
  }

  // 이웃 고르기: 관계 묶음마다 perGroup개까지, 묶음을 돌아가며 total개까지 (이미 그래프에 있는 점은 개수에 안 셈)
  const pick = (list: Neighbor[], perGroup: number, total: number) => {
    const g = cy()
    const groups = new Map<string, Neighbor[]>()
    const keep: Neighbor[] = []
    for (const n of list) {
      if (g.getElementById(n.node.id).nonempty()) keep.push(n)
      else groups.set(n.group, [...(groups.get(n.group) ?? []), n])
    }
    const lists = [...groups.values()]
    const taken = new Set<string>()
    for (let round = 0; round < perGroup && taken.size < total; round++) {
      for (const l of lists) {
        const n = l[round]
        if (n && !taken.has(n.node.id) && taken.size < total) {
          taken.add(n.node.id)
          keep.push(...l.filter((x) => x.node.id === n.node.id))
        }
      }
    }
    return keep
  }

  // 이웃 목록을 그래프에 올린다. 새로 올린 점 id를 돌려준다
  const addNeighbors = (items: Neighbor[], around: string) => {
    const g = cy()
    const fresh: string[] = []
    const nodes: ElementDefinition[] = []
    for (const it of items) {
      if (g.getElementById(it.node.id).empty() && !fresh.includes(it.node.id)) {
        nodes.push(toEl(it.node))
        fresh.push(it.node.id)
      }
    }
    g.add(nodes)
    linkUp(fresh, items)
    return fresh
  }

  // 새 점과 이미 그래프에 있는 점 사이의 관계도 잇는다 (기준 점 말고도)
  const linkUp = (ids: string[], known: Neighbor[] = []) => {
    const g = cy()
    const edges = new Map<string, ElementDefinition>()
    const push = (nb: Neighbor) => {
      if (g.getElementById(nb.link.source).empty() || g.getElementById(nb.link.target).empty()) return
      if (g.getElementById(nb.link.id).nonempty() || edges.has(nb.link.id)) return
      edges.set(nb.link.id, { group: "edges", data: { id: nb.link.id, source: nb.link.source, target: nb.link.target, label: nb.link.label } })
    }
    known.forEach(push)
    for (const id of ids) neighbors(store, cat, id).forEach(push)
    g.add([...edges.values()])
  }

  const fitIfNeeded = (force = false) => {
    const g = cy()
    const ext = g.extent()
    const bb = g.elements().boundingBox()
    if (force || bb.x1 < ext.x1 || bb.x2 > ext.x2 || bb.y1 < ext.y1 || bb.y2 > ext.y2) g.animate({ fit: { eles: g.elements(), padding: 46 } }, { duration: 320 })
  }

  // '정렬': 시작 객체(없으면 고른 객체)를 가운데 두고 몇 걸음 떨어졌는지로 동심원 배치
  const relayout = () => {
    const g = cy()
    if (g.nodes().length < 2) return fitIfNeeded(true)
    const root = g.getElementById(seed).nonempty() ? seed : selectedRef.current
    g.layout({
      name: "breadthfirst",
      circle: true,
      roots: (root ? g.getElementById(root) : undefined) as unknown as string[], // 실행 시에는 점 묶음도 받는다 (id에 / · # 이 있어 선택자 문자열 대신)
      spacingFactor: 0.9,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      animate: true,
      animationDuration: 450,
      fit: true,
      padding: 40,
    }).run()
  }

  const highlight = (id: string) => {
    const g = cyRef.current
    if (!g) return
    g.batch(() => {
      g.elements().removeClass("faded hl lbl")
      const n = id ? g.getElementById(id) : null
      if (!n || n.empty()) return
      g.elements().difference(n.closedNeighborhood()).addClass("faded")
      const edges = n.connectedEdges().addClass("hl")
      if (edges.length <= 12) edges.addClass("lbl") // 선 이름은 몇 개일 때만 (많으면 겹쳐서 못 읽음)
    })
  }

  const select = (id: string) => {
    selectedRef.current = id
    setSelected(id)
    const g = cyRef.current
    if (!g) return
    g.$(":selected").unselect()
    if (id) g.getElementById(id).select()
    highlight(id)
  }

  const expand = (id: string, group?: string, limit = PER_GROUP) => {
    const g = cy()
    const all = neighbors(store, cat, id).filter((n) => !group || n.group === group)
    const fresh = addNeighbors(group ? pick(all, limit, limit) : pick(all, PER_GROUP, MAX_EXPAND), id)
    if (!group) g.getElementById(id).data("expanded", 1)
    if (fresh.length) {
      spread(fresh, id)
      // 펼친 점과 그 이웃이 보이게 (애니메이션이 끝난 뒤 위치로 맞춘다)
      setTimeout(() => {
        const nb = g.getElementById(id).closedNeighborhood()
        if (!cyRef.current) return
        g.animate({ fit: { eles: nb, padding: 50 } }, { duration: 320 })
      }, 520)
    }
    highlight(selectedRef.current)
    bump()
  }

  // 빈 그래프에서 객체 하나로 시작
  const restart = (id: string) => {
    const g = cy()
    const n = nodeOf(store, cat, id)
    if (!n) return
    g.elements().remove()
    g.add({ ...toEl(n), position: { x: 0, y: 0 } })
    const fresh = addNeighbors(pick(neighbors(store, cat, id), SEED_PER_GROUP, MAX_EXPAND), id)
    spread(fresh, id, false)
    g.getElementById(id).data("expanded", 1)
    g.fit(undefined, 40)
    select(id)
    bump()
  }

  // 왼쪽 목록 · 검색에서 고른 객체: 그래프에 있으면 그 점으로, 없으면 올리고 펼친다
  const open = (n: GNode) => {
    const g = cy()
    if (g.nodes().length === 0) return restart(n.id)
    if (g.getElementById(n.id).empty()) {
      const ext = g.extent()
      g.add({ ...toEl(n), position: { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 } })
      linkUp([n.id])
      expand(n.id)
    }
    select(n.id)
    focus(n.id)
  }

  // 오른쪽 '연결'에서 고른 이웃 하나: 없으면 올리고(선택은 그대로), 있으면 그 점으로
  const addOne = (nb: Neighbor) => {
    const g = cy()
    if (g.getElementById(nb.node.id).nonempty()) {
      select(nb.node.id)
      focus(nb.node.id)
      return
    }
    const around = selectedRef.current || nb.link.source
    const fresh = addNeighbors([nb], around)
    // 하나만 올릴 때는 기준 점 옆 빈자리에
    const p = g.getElementById(around).position()
    const n = g.getElementById(fresh[0])
    if (n.nonempty()) {
      const rest = (g.nodes().toArray() as NodeSingular[]).filter((o) => o.id() !== fresh[0])
      const taken = (x: number, y: number) => rest.some((o) => Math.hypot(o.position().x - x, o.position().y - y) < 70)
      let a = 0
      let r = 150
      while (taken(p.x + r * Math.cos(a), p.y + r * Math.sin(a)) && r < 1200) {
        a += 0.6
        if (a > Math.PI * 2) {
          a = 0
          r += 70
        }
      }
      n.position(p)
      n.animate({ position: { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) } }, { duration: 380, easing: "ease-out-cubic" })
    }
    highlight(selectedRef.current)
    bump()
  }

  const focus = (id: string) => {
    const g = cy()
    const n = g.getElementById(id)
    if (n.nonempty()) g.animate({ center: { eles: n }, zoom: Math.max(g.zoom(), 0.9) }, { duration: 300 })
  }

  const hide = (id: string) => {
    const g = cy()
    g.getElementById(id).remove()
    select("")
    bump()
  }

  // 그래프 만들기 (데이터셋 · 시작 객체가 바뀌면 다시)
  useEffect(() => {
    if (!box.current) return
    const g = cytoscape({ container: box.current, style: STYLE, minZoom: 0.15, maxZoom: 2.2, wheelSensitivity: 0.25, boxSelectionEnabled: false })
    cyRef.current = g
    g.on("tap", "node", (e) => select(e.target.id()))
    g.on("tap", (e) => e.target === g && select(""))
    g.on("dbltap", "node", (e) => expand(e.target.id()))
    g.on("mouseover", "node", (e) => highlight(e.target.id()))
    g.on("mouseout", "node", () => highlight(selectedRef.current))
    g.on("mouseover", "edge", (e) => e.target.addClass("hl lbl"))
    g.on("mouseout", "edge", () => highlight(selectedRef.current))
    if (seed) restart(seed)
    return () => {
      g.destroy()
      cyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, seed])

  const g = cyRef.current
  const count = g ? { nodes: g.nodes().length, edges: g.edges().length } : { nodes: 0, edges: 0 }

  return (
    <section className="card onto-explorer">
      <TypePanel store={store} cat={cat} open={open} selected={selected} />
      <div className="onto-canvas-wrap">
        <div ref={box} className="onto-canvas" />
        <div className="onto-toolbar">
          <button disabled={!selected} onClick={() => selected && expand(selected)} title="고른 객체의 연결 펼치기 (더블클릭)">
            연결 펼치기
          </button>
          <button disabled={!selected} onClick={() => selected && hide(selected)}>
            숨기기
          </button>
          <span />
          <button onClick={relayout}>정렬</button>
          <button onClick={() => fitIfNeeded(true)}>전체 보기</button>
          <button onClick={() => restart(seed)}>처음 상태</button>
        </div>
        <div className="onto-legend">
          {LEGEND.map(([k, label]) => (
            <span key={k}>
              <i className={k === "concept" ? "concept" : ""} style={{ background: KIND_COLOR[k] }} />
              {label}
            </span>
          ))}
        </div>
        <div className="onto-count numeric">
          객체 {count.nodes} · 관계 {count.edges}
        </div>
      </div>
      <DetailPanel key={selected} store={store} cat={cat} id={selected} version={version} isOn={(id) => !!g && g.getElementById(id).nonempty()} expand={expand} addOne={addOne} restart={restart} hide={hide} />
    </section>
  )
}

function Glyph({ cls, color }: { cls: string; color: string }) {
  return (
    <span className="onto-glyph" style={{ background: color }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: iconSvg(cls) }} />
    </span>
  )
}

// ───────── 왼쪽: 개념(종류) 목록 + 검색 ─────────

function TypePanel({ store, cat, open, selected }: { store: Store; cat: Catalog; open: (n: GNode) => void; selected: string }) {
  const groups = useMemo(() => visibleClasses(cat), [cat])
  const [term, setTerm] = useState("")
  const [openCls, setOpenCls] = useState(() => [...cat.classes.values()].find((c) => c.name === "DesignChange")?.id ?? "")
  const index = useMemo(() => (term ? searchIndex(store, cat) : []), [store, cat, term.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo(() => {
    const t = term.trim().toLowerCase()
    return t ? index.filter((n) => n.label.toLowerCase().includes(t)).slice(0, 40) : []
  }, [index, term])
  const items = useMemo(() => (openCls ? instancesOf(store, cat, openCls) : []), [store, cat, openCls])
  const total = groups.reduce((s, g) => s + g.list.length, 0)

  return (
    <aside className="onto-types">
      <input className="onto-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="객체 검색 (이름 · 번호)" />
      {term ? (
        <div className="onto-hits">
          <h3>검색 결과 {hits.length}</h3>
          {hits.map((n) => (
            <button key={n.id} className={n.id === selected ? "on" : ""} onClick={() => open(n)} title={n.label}>
              <i style={{ background: KIND_COLOR[n.kind] }} />
              <span>{n.label}</span>
              <small>{n.clsLabel}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="onto-tree">
          <h3>
            객체 종류 <small className="numeric">{total.toLocaleString("ko-KR")}</small>
          </h3>
          {groups.map((grp) => (
            <div key={grp.group} className="onto-tree-group">
              <h4>{grp.group}</h4>
              {grp.list.map((c) => {
                const kind: Kind = c.name === "DesignChange" ? "change" : c.group === "과거 사례" ? "case" : c.group === "사람 · 조직" || c.name === "Department" ? "person" : c.scope === "PerHull" ? "perHull" : c.scope === "SeriesCommon" ? "common" : "other"
                return (
                  <div key={c.id}>
                    <button className={`onto-type${openCls === c.id ? " open" : ""}`} onClick={() => setOpenCls(openCls === c.id ? "" : c.id)} title={c.systems ? `출처 ${c.systems}` : undefined}>
                      <Glyph cls={c.name} color={KIND_COLOR[kind]} />
                      <span className="onto-type-name">{c.label}</span>
                      <small className="numeric">{c.count.toLocaleString("ko-KR")}</small>
                    </button>
                    {openCls === c.id && (
                      <div className="onto-instances">
                        {items.slice(0, 200).map((n) => (
                          <button key={n.id} className={n.id === selected ? "on" : ""} onClick={() => open(n)} title={n.label}>
                            {n.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

// ───────── 오른쪽: 고른 객체의 속성 · 연결 ─────────

const fmtValue = (v: string) => {
  if (v === "true") return "예"
  if (v === "false") return "아니요"
  const dt = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?Z?$/)
  if (dt) return `${dt[1]} ${dt[2]}`
  if (/^-?\d{5,}(\.\d+)?$/.test(v)) return Number(v).toLocaleString("ko-KR")
  return v
}

function DetailPanel(props: {
  store: Store
  cat: Catalog
  id: string
  version: number
  isOn: (id: string) => boolean
  expand: (id: string, group?: string, limit?: number) => void
  addOne: (nb: Neighbor) => void
  restart: (id: string) => void
  hide: (id: string) => void
}) {
  const { store, cat, id, version, isOn } = props
  const node = useMemo(() => (id ? nodeOf(store, cat, id) : null), [store, cat, id])
  const nbs = useMemo(() => (id ? neighbors(store, cat, id) : []), [store, cat, id])
  const attrs = useMemo(() => (id ? attributes(store, cat, id) : []), [store, cat, id])
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [allAttrs, setAllAttrs] = useState(false)
  const groups = useMemo(() => {
    const m = new Map<string, Neighbor[]>()
    for (const n of nbs) m.set(n.group, [...(m.get(n.group) ?? []), n])
    return [...m.entries()]
  }, [nbs])
  void version // 그래프에 올라간 점(✓)이 바뀌면 다시 그린다

  if (!id || !node) {
    return (
      <aside className="onto-detail empty">
        <p>객체 미선택</p>
      </aside>
    )
  }
  const info = cat.classes.get(node.cls)
  const scope = info?.scope === "SeriesCommon" ? "시리즈 공통" : info?.scope === "PerHull" ? "호선마다 다름" : ""
  const shownAttrs = allAttrs ? attrs : attrs.slice(0, 10)
  return (
    <aside className="onto-detail">
      <div className="onto-detail-head">
        <Glyph cls={clsKey(node)} color={KIND_COLOR[node.kind]} />
        <div>
          <strong>{node.label}</strong>
          <div className="onto-chips">
            <span>{node.clsLabel}</span>
            {scope && <span className={info?.scope === "PerHull" ? "perHull" : "common"}>{scope}</span>}
            {info?.systems && <span className="sys">{info.systems}</span>}
          </div>
        </div>
      </div>
      <div className="onto-detail-actions">
        <button className="primary" onClick={() => props.expand(id)}>
          연결 펼치기
        </button>
        <button onClick={() => props.restart(id)}>이 객체부터</button>
        <button onClick={() => props.hide(id)}>숨기기</button>
      </div>

      <h3>
        연결 <small className="numeric">{nbs.length}</small>
      </h3>
      <div className="onto-links">
        {groups.map(([name, list]) => {
          const on = list.filter((n) => isOn(n.node.id)).length
          const opened = openGroups.has(name)
          return (
            <div key={name} className="onto-link-group">
              <div className="onto-link-head">
                <button
                  className="onto-link-name"
                  onClick={() => {
                    const next = new Set(openGroups)
                    if (opened) next.delete(name)
                    else next.add(name)
                    setOpenGroups(next)
                  }}
                >
                  <i style={{ background: KIND_COLOR[list[0].node.kind] }} />
                  {name}
                  <small className="numeric">
                    {on < list.length ? `${on}/${list.length}` : list.length}
                  </small>
                </button>
                {on < list.length && (
                  <button className="onto-link-add" onClick={() => props.expand(id, name, 60)}>
                    모두 표시
                  </button>
                )}
              </div>
              {(opened || list.length <= 3) && (
                <div className="onto-link-items">
                  {list.slice(0, 60).map((n) => (
                    <button key={n.link.id} className={isOn(n.node.id) ? "on" : ""} onClick={() => props.addOne(n)} title={n.node.label}>
                      <span>{n.node.label}</span>
                      {isOn(n.node.id) && <em title="그래프에 표시 중">✓</em>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <h3>
        속성 <small className="numeric">{attrs.length}</small>
      </h3>
      <dl className="onto-attrs">
        {shownAttrs.map((a, i) => (
          <div key={i}>
            <dt className={a.raw ? "raw" : ""}>{a.name}</dt>
            <dd title={a.value}>{fmtValue(a.value)}</dd>
          </div>
        ))}
      </dl>
      {attrs.length > 10 && (
        <button className="onto-more" onClick={() => setAllAttrs(!allAttrs)}>
          {allAttrs ? "접기" : `전체 ${attrs.length}개`}
        </button>
      )}
      <p className="onto-iri">{id.replace("https://basis.local/", "")}</p>
    </aside>
  )
}
