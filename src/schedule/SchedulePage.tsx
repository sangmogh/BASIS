// 일정 · 진척 (메뉴 1): 설계변경 · 회의 화면과 같은 새 엔진 데이터(/api/datasets?schedule=1 → server/schedule.ts)
//   - 시리즈 통합 일정: 착공(첫 블록 제작) → 진수: 블록 제작 · 탑재, 진수 → 인도: 의장 · 시운전. 결정한 설계변경이 인도를 미루면 늦어진 기간
//   - 호선 카드: 지금 단계 · 진척(일정 기준) · 다음 마일스톤 · 인도일, 누르면 마일스톤 · 블록 · 걸린 설계변경
//   날짜는 데이터셋 기준일 → 오늘로 옮겨 보인다 (설계변경 목록 · 회의 화면과 같은 시계: src/meeting/clock.ts)
import { useEffect, useId, useMemo, useState } from "react"
import { api } from "../auth/session"
import { offsetFrom, shiftView } from "../meeting/clock"
import "./schedule.css"

type MS = { label: string; planned: string | null; actual: string | null }
type Blocks = { total: number; notStarted: number; fabricating: number; fabricated: number; installing: number; installed: number }
type HullChange = { id: string; title: string; decided: boolean; option: string | null; deadline: string | null; treatment: string; units: { notStarted: number; fabricated: number; installed: number }; newDelivery: string | null; deliveryDelay: number; overrun: number }
type Hull = {
  id: string
  seq: number
  name: string
  lifecycle: { code: string; label: string }
  phase: { code: string; label: string }
  inProduction: boolean
  progress: number
  milestones: Record<"construction_start" | "block_erection_start" | "launch" | "delivery", MS>
  plannedDelivery: string
  actualDelivery: string | null
  delivery: string
  deliveryShift: number
  contractDelivery: string | null
  next: { key: string; label: string; date: string } | null
  blocks: Blocks
  changes: HullChange[]
}
type Data = { id: string; name: string; asOf: string; shipType: string; schedule: { today: string; hulls: Hull[]; inProduction: string[] } }

const md = (d?: string | null) => {
  if (!d) return "-"
  const [y, m, day] = d.slice(0, 10).split("-").map(Number)
  return `${y !== 2026 ? `'${String(y).slice(2)} ` : ""}${m}/${day}`
}
const at = (m: MS) => m.actual ?? m.planned
const time = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`)

const cache = new Map<string, Data>()

export default function SchedulePage({ dataset, openChange }: { dataset: string; openChange: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(() => cache.get(dataset) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    api(`/api/datasets?id=${dataset}&schedule=1`)
      .then((r) => r.json())
      .then((j: { datasets?: (Data & { error?: string | null })[]; error?: string }) => {
        const found = j.datasets?.find((x) => x.id === dataset)
        if (!found || found.error || !found.schedule) return setError(found?.error ?? j.error ?? `데이터셋 없음: ${dataset}`)
        const d = shiftView(found, offsetFrom(found.asOf)) // 날짜는 기준일 → 오늘로
        cache.set(dataset, d)
        setData(d)
      })
      .catch((e) => setError(String(e)))
  }, [dataset])

  if (error) return <div className="card sc-empty">{error}</div>
  if (!data)
    return (
      <>
        <Title />
        <div className="card sc-empty">일정을 불러오는 중이에요…</div>
      </>
    )
  const { hulls, today, inProduction } = data.schedule
  const hull = hulls.find((h) => h.id === selected) ?? null
  return (
    <>
      <Title sub={`${data.name.replace(/\s*\([^)]*\)\s*$/, "")} · 지금 생산 중 ${inProduction.length}척${inProduction.length ? ` (${inProduction.join(" · ")})` : ""}`} />
      <Gantt hulls={hulls} today={today} />
      <section className="card ship-status-card">
        <div className="card-head">
          <div>
            <h2>호선별 상세 현황</h2>
          </div>
          <span className="updated">
            기준 <span className="numeric">{md(today)}</span> · 진척은 착공 → 인도 일정 기준
          </span>
        </div>
        <div className="ship-grid">
          {hulls.map((h) => (
            <HullCard key={h.id} h={h} shipType={data.shipType} on={h.id === selected} open={() => setSelected(h.id === selected ? null : h.id)} />
          ))}
        </div>
      </section>
      {hull && <HullDetail h={hull} today={today} openChange={openChange} close={() => setSelected(null)} />}
    </>
  )
}

function Title({ sub }: { sub?: string }) {
  return (
    <div className="page-title">
      <div>
        <h1>시리즈 일정</h1>
        <p>{sub ?? "시리즈 호선의 주요 일정과 현재 진척을 확인해요."}</p>
      </div>
    </div>
  )
}

function Gantt({ hulls, today }: { hulls: Hull[]; today: string }) {
  // 보이는 범위: 첫 착공 달 ~ 마지막 인도 다음 달
  const starts = hulls.map((h) => at(h.milestones.construction_start)).filter((d): d is string => !!d)
  const first = [...starts, today].sort()[0]
  const last = hulls.map((h) => h.delivery).sort().at(-1) ?? today
  const firstMonth = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1))
  const lastMonth = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 1))
  const months: { key: string; label: string }[] = []
  for (let d = new Date(firstMonth); d <= lastMonth; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
    months.push({ key: d.toISOString().slice(0, 7), label: d.getUTCMonth() === 0 || !months.length ? `${String(d.getUTCFullYear()).slice(2)}.${String(d.getUTCMonth() + 1).padStart(2, "0")}` : String(d.getUTCMonth() + 1).padStart(2, "0") })
  const end = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1)).getTime()
  const pos = (d: string) => Math.max(0, Math.min(100, ((time(d) - firstMonth.getTime()) / (end - firstMonth.getTime())) * 100))
  return (
    <section className="card gantt-card">
      <div className="card-head">
        <div>
          <h2>시리즈 통합 일정</h2>
        </div>
        <div className="legend">
          <span>
            <i className="swatch build" />
            블록 제작·탑재
          </span>
          <span>
            <i className="swatch trial" />
            의장·시운전
          </span>
          <span>
            <i className="ms launch" />
            진수
          </span>
          <span>
            <i className="ms delivery" />
            인도 (예정대로)
          </span>
          <span>
            <i className="ms delivery within" />
            늦어졌지만 계약 납기 안
          </span>
          <span>
            <i className="ms delivery delayed" />
            계약 납기를 넘긴 인도
          </span>
          <span>
            <i className="swatch slip" />
            결정한 설계변경으로 늦어진 기간
          </span>
          <span>
            <i className="legend-line" />
            오늘
          </span>
        </div>
      </div>
      <div className="gantt-scroll">
        <div className="gantt">
          <div className="gantt-label gantt-corner">호선</div>
          <div className="months" style={{ gridTemplateColumns: `repeat(${months.length}, 1fr)` }}>
            {months.map((m) => (
              <span key={m.key}>{m.label}</span>
            ))}
            <span className="today-flag" style={{ left: `${pos(today)}%` }}>
              오늘 {md(today)}
            </span>
          </div>
          <div className="gantt-date-head">인도일</div>
          {hulls.map((h) => {
            const start = at(h.milestones.construction_start)
            const launch = at(h.milestones.launch)
            const delay = h.deliveryShift
            const within = delay > 0 && !!h.contractDelivery && h.delivery <= h.contractDelivery
            const late = !!h.contractDelivery && h.delivery > h.contractDelivery
            return (
              <div className="gantt-row-wrap" key={h.id}>
                <div className="gantt-label">
                  <strong>{h.name}</strong>
                  <span>{h.id}</span>
                </div>
                <div className="timeline" style={{ backgroundSize: `calc(100% / ${months.length}) 100%` }}>
                  <div className="today-line" style={{ left: `${pos(today)}%` }} />
                  {start && launch && <Phase from={start} to={launch} today={today} pos={pos} kind="build" label="블록 제작·탑재" />}
                  {launch && <Phase from={launch} to={h.plannedDelivery} today={today} pos={pos} kind="trial" label="의장·시운전" />}
                  {delay > 0 && <div className={`slip ${within ? "within" : ""}`} style={{ left: `${pos(h.plannedDelivery)}%`, width: `${pos(h.delivery) - pos(h.plannedDelivery)}%` }} title={`결정한 설계변경으로 인도 +${delay}일 (계획 ${md(h.plannedDelivery)} → ${md(h.delivery)})`} />}
                  {launch && <i className="ms launch" style={{ left: `${pos(launch)}%` }} title={`진수 ${md(launch)}`} />}
                  <i className={`ms delivery ${late ? "delayed" : within ? "within" : ""}`} style={{ left: `${pos(h.delivery)}%` }} title={`인도 ${md(h.delivery)}${h.contractDelivery ? ` · 계약 납기 ${md(h.contractDelivery)}` : ""}`} />
                  {delay > 0 && (
                    <span className={`slip-label ${within ? "within" : ""}`} style={{ left: `${pos(h.delivery)}%` }}>
                      +{delay}일{within ? " · 여유 안" : ""}
                    </span>
                  )}
                </div>
                <div className="gantt-delivery">
                  <span>
                    <strong className="numeric">{md(h.delivery)}</strong>
                    {delay > 0 && <span className={within ? "delay-within" : "delay"}>+{delay}일</span>}
                  </span>
                  {h.phase.code === "delivered" ? <span className="status-pill warning">운항 중</span> : h.inProduction ? <span className="status-pill primary sc-pill">{h.phase.label}</span> : <span className="sc-phase">{h.phase.label}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Phase({ from, to, today, pos, kind, label }: { from: string; to: string; today: string; pos: (d: string) => number; kind: "build" | "trial"; label: string }) {
  const left = pos(from)
  const right = pos(to)
  const now = Math.min(Math.max(pos(today), left), right)
  const done = right > left ? ((now - left) / (right - left)) * 100 : 0
  return (
    <div className={`phase ${kind} ${done > 35 ? "mostly-done" : ""}`} style={{ left: `${left}%`, width: `${right - left}%`, "--done": `${done}%` } as React.CSSProperties} title={`${label} ${md(from)} ~ ${md(to)}`}>
      <span>{label}</span>
    </div>
  )
}

function HullCard({ h, shipType, on, open }: { h: Hull; shipType: string; on: boolean; open: () => void }) {
  const open_ = h.changes.filter((c) => !c.decided).map((c) => c.id)
  return (
    <button className={`ship-card${on ? " sc-on" : ""}`} onClick={open} aria-expanded={on}>
      <span className="ship-card-title">
        <span>
          <small>{h.name}</small>
          <strong>{h.id}</strong>
        </span>
        <span className="arrow">{on ? "↑" : "→"}</span>
      </span>
      <span className="progress-copy">
        <b className="numeric">{h.progress}%</b>
        <span className="source">일정</span>
      </span>
      <ShipProgress progress={h.progress} shipType={shipType} />
      <span className="ship-facts">
        <span>
          <small>지금 단계</small>
          <b>{h.phase.label}</b>
        </span>
        <span>
          <small>다음 마일스톤</small>
          <b>{h.next ? `${h.next.label} · ${md(h.next.date)}` : "-"}</b>
        </span>
        <span>
          <small>인도일</small>
          <b className="numeric">
            {md(h.delivery)} {h.deliveryShift > 0 && <em className={h.contractDelivery && h.delivery <= h.contractDelivery ? "within" : ""}>+{h.deliveryShift}</em>}
          </b>
        </span>
      </span>
      {open_.length > 0 && <span className="ship-note">결정 대기 설계변경 {open_.join(" · ")}</span>}
    </button>
  )
}

function HullDetail({ h, today, openChange, close }: { h: Hull; today: string; openChange: (id: string) => void; close: () => void }) {
  const ms = ["construction_start", "block_erection_start", "launch", "delivery"] as const
  const b = h.blocks
  const shown = useMemo(() => h.changes.filter((c) => c.units.installed + c.units.fabricated + c.units.notStarted > 0 || c.treatment === "인도 후 개조"), [h])
  return (
    <section className="card sc-detail">
      <div className="card-head">
        <div>
          <h2>
            {h.name} <span className="numeric sc-id">{h.id}</span> · {h.phase.label}
          </h2>
        </div>
        <button className="ghost-button" onClick={close}>
          닫기
        </button>
      </div>
      <div className="sc-detail-body">
        <div>
          <h3>마일스톤</h3>
          <table className="sc-table">
            <thead>
              <tr>
                <th>마일스톤</th>
                <th>날짜</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {ms.map((k) => {
                const m = h.milestones[k]
                const d = k === "delivery" ? h.delivery : at(m)
                return (
                  <tr key={k}>
                    <td>{m.label}</td>
                    <td className="numeric">
                      {md(d)}
                      {k === "delivery" && h.deliveryShift > 0 && <small> (계획 {md(h.plannedDelivery)})</small>}
                    </td>
                    <td>{m.actual || (d && d <= today) ? "완료" : "예정"}</td>
                  </tr>
                )
              })}
              <tr>
                <td>계약 납기</td>
                <td className="numeric">{md(h.contractDelivery)}</td>
                <td>{h.contractDelivery ? (h.delivery <= h.contractDelivery ? `여유 ${daysBetween(h.delivery, h.contractDelivery)}일` : `${daysBetween(h.contractDelivery, h.delivery)}일 초과`) : "-"}</td>
              </tr>
            </tbody>
          </table>
          <h3>블록 {b.total}개</h3>
          <p className="sc-blocks">
            설치 완료 <b>{b.installed}</b> · 설치 중 <b>{b.installing}</b> · 제작 완료 <b>{b.fabricated}</b> · 제작 중 <b>{b.fabricating}</b> · 생산 전 <b>{b.notStarted}</b>
          </p>
        </div>
        <div>
          <h3>이 호선에 걸린 설계변경</h3>
          {shown.length ? (
            <table className="sc-table">
              <thead>
                <tr>
                  <th>변경</th>
                  <th>상태</th>
                  <th>이 호선 조치</th>
                  <th>인도 영향</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong className="numeric">{c.id}</strong>
                      <small>{c.title}</small>
                    </td>
                    <td>{c.decided ? `결정 · ${c.option ?? ""}` : `결정 대기 · 추천 ${c.option ?? "-"}${c.deadline ? ` · 기한 ${md(c.deadline)}` : ""}`}</td>
                    <td>{c.treatment}</td>
                    <td className="numeric">{c.deliveryDelay ? `+${c.deliveryDelay}일${c.overrun ? ` (계약 ${c.overrun}일 초과)` : ""}` : "없음"}</td>
                    <td>
                      <button className="sc-link" onClick={() => openChange(c.id)}>
                        회의 화면 →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sc-none">걸린 설계변경이 없어요.</p>
          )}
          <p className="sc-foot">결정 대기 변경은 추천안 기준, 결정한 변경은 결정한 안 기준이에요 (회의 화면과 같은 계산).</p>
        </div>
      </div>
    </section>
  )
}

const daysBetween = (a: string, b: string) => Math.round((time(b) - time(a)) / 86_400_000)

// 배 옆모습을 진척만큼 칠한다 (선종에 따라 모양)
function ShipProgress({ progress, shipType }: { progress: number; shipType: string }) {
  const clip = useId()
  const width = Math.max(0, Math.min(100, progress)) * 2
  const hull = <path d="M4 34 H196 L187 50 H22 Q9 49 4 34 Z" />
  const bridge = (
    <>
      <rect x="166" y="16" width="20" height="18" />
      <rect x="172" y="9" width="7" height="7" />
    </>
  )
  const shapes = shipType.includes("LNG") ? (
    <>
      {hull}
      <path d="M28 34 a14 12 0 0 1 28 0 Z" />
      <path d="M62 34 a14 12 0 0 1 28 0 Z" />
      <path d="M96 34 a14 12 0 0 1 28 0 Z" />
      <path d="M130 34 a14 12 0 0 1 28 0 Z" />
      {bridge}
    </>
  ) : shipType.includes("컨테이너") ? (
    <>
      {hull}
      <rect x="22" y="22" width="30" height="12" />
      <rect x="56" y="18" width="30" height="16" />
      <rect x="90" y="18" width="30" height="16" />
      <rect x="124" y="22" width="30" height="12" />
      {bridge}
    </>
  ) : (
    <>
      {hull}
      <rect x="24" y="30" width="134" height="4" />
      <rect x="70" y="24" width="4" height="6" />
      <rect x="110" y="24" width="4" height="6" />
      {bridge}
    </>
  )
  return (
    <svg className="ship-progress" viewBox="0 0 200 54" role="img" aria-label={`진척 ${progress}%`}>
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width={width} height="54" />
        </clipPath>
      </defs>
      <g className="base">{shapes}</g>
      <g className="fill" clipPath={`url(#${clip})`}>
        {shapes}
      </g>
      <g className="line">{shapes}</g>
    </svg>
  )
}
