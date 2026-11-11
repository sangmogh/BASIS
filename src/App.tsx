import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react"
// 예전 상세 화면 src/ChangeDetail.tsx 는 더 이상 쓰지 않는다 (회의 화면으로 바꿈, 11/5)
import { AuthProvider, useAuth } from "./auth/AuthProvider"
import LoginPage from "./auth/LoginPage"
// 설계변경 목록 · 회의 화면은 처음부터 같이 받는다 (따로 받으면 "조회 중" 화면이 잠깐 뜬다)
import ChangeForm from "./meeting/ChangeForm"
import ChangeList from "./meeting/ChangeList"
import MeetingView from "./meeting/MeetingView"
import { BrandMark, Wordmark } from "./brand"
import { CaseDetail, CasesPage } from "./Cases"
import CasesView from "./cases/CasesView" // 사례 메뉴: 자기 말로 묻는 사례 검색 (새 엔진 /api/cases)
import SeriesSchedule from "./schedule/SchedulePage" // 일정 · 진척: 새 엔진 데이터 (/api/datasets?schedule=1)
import { useDatasets, useOpenCount } from "./entry/useDatasets" // 첫 화면 · 사이드바 숫자: 새 엔진 데이터
import type { BlockSchedule, Change, Milestone, Reason } from "./data/types"
import { caseData, portfolioData, projectData, seriesData } from "./data"
import {
  addDays,
  daysBetween,
  dday as ddayText,
  delayLevel,
  formatShort,
  meetingDeadline,
  params,
  withMethod,
  plannedTasks,
  blockOutlook,
  stageOf,
  ROLES,
  TEAM_INFO,
  METHOD_LABEL,
  type SimOptions,
  scopeOf,
  simulate,
  type SimRow,
  taskStatus,
  timingDistribution,
} from "./engine"
import { DEMO_DAYS, StoreProvider, TODAY as CLOCK_TODAY, boardTasks, draftOptions, draftTarget, useStore } from "./store"
import { shiftDates } from "./data/clock"

type View = "entry" | "schedule" | "ship" | "changes" | "change-new" | "change-detail" | "cases" | "case-detail" | "ontology"

// 온톨로지 화면은 열 때만 불러온다 (그래프 DB WebAssembly가 커서 처음 화면 번들에 넣지 않음)
const OntologyPage = lazy(() => import("./ontology/OntologyPage"))
// 설계변경 (메뉴 2) = 새 엔진의 목록 → 회의 화면(회의 순서 7단계). 예전 상세 화면(ChangeDetail)은 쓰지 않는다
//   주소: ?view=meeting&change=DC-021[&step=1~7] 로 회의 화면을 바로 연다
const DATASET = "lng10"

type Ship = {
  id: string
  order: string
  progress: number
  process: string
  start: string
  launch: string
  delivery: string
  previous?: string
  processes: number[]
  inService?: boolean // 이미 인도해 운항 중 (설계변경의 출발점)
  contract?: string // 계약 납기 (인도일이 밀려도 이 날 안이면 '여유 안')
  note?: string
}

// 시연 시계의 오늘 (합성 데이터는 10/28 기준이라 그만큼 옮겨 쓴다)
const TODAY = new Date(`${CLOCK_TODAY}T00:00:00`)
// 호선 기본 정보: 일정 · 인도일은 series.json, 진척 · 공정 · 마일스톤은 project.json. 날짜는 시연 시계만큼 옮긴다
const project = projectData
const baseShips: Ship[] = shiftDates<Ship[]>(
  seriesData.vessels.map((v) => {
    const s = project.vessels[v.id]
    const starts = Object.values(v.blocks).map((b) => b.start).sort()
    return {
      id: v.id,
      order: v.order,
      progress: s?.progress ?? 0,
      process: s?.process ?? "-",
      start: s?.start ?? starts[0],
      launch: s?.launch ?? v.delivery,
      delivery: v.delivery,
      previous: v.previousDelivery,
      processes: s?.processes ?? [],
      inService: v.status === "in_service",
      contract: v.contractDelivery,
      note: v.note,
    }
  }),
  DEMO_DAYS,
)
// 호선별 블록 개수 · 마일스톤 (착공 · 탑재 시작 등. 진수 · 인도는 Ship 값으로 계산)
const detailData: Record<string, { blockCounts: number[]; milestones: Milestone[] }> = shiftDates(
  Object.fromEntries(seriesData.vessels.map((v) => [v.id, { blockCounts: project.vessels[v.id]?.blockCounts ?? [], milestones: project.vessels[v.id]?.milestones ?? [] }])),
  DEMO_DAYS,
)
// 헤더 · 프로젝트 목록의 호선 요약: "5척", "H-101~105"
const VESSEL_COUNT = `${seriesData.vessels.length}척`
const VESSEL_RANGE = (() => {
  const ids = seriesData.vessels.map((v) => v.id)
  const first = ids[0] ?? ""
  const last = ids[ids.length - 1] ?? ""
  const prefix = first.slice(0, first.length - 3)
  return ids.length > 1 ? (last.startsWith(prefix) ? `${first}~${last.slice(prefix.length)}` : `${first}~${last}`) : first
})()
// 시리즈 일정 표: 가장 이른 착공 달부터 가장 늦은 인도 달까지 (최소 18개월)
const RANGE_FIRST = (() => {
  const [y, m] = baseShips.map((ship) => ship.start).sort()[0].split("-").map(Number)
  return { year: y, month: m - 1 }
})()
const RANGE_MONTHS = (() => {
  const [y, m] = baseShips.map((ship) => ship.delivery).sort().reverse()[0].split("-").map(Number)
  return Math.max(18, (y - RANGE_FIRST.year) * 12 + (m - 1 - RANGE_FIRST.month) + 1)
})()
const RANGE_START = new Date(RANGE_FIRST.year, RANGE_FIRST.month, 1).getTime()
const RANGE_END = new Date(RANGE_FIRST.year, RANGE_FIRST.month + RANGE_MONTHS, 0).getTime()

function pos(date: string) {
  return (
    ((new Date(`${date}T00:00:00`).getTime() - RANGE_START) /
      (RANGE_END - RANGE_START)) *
    100
  )
}

// 기준 해 날짜는 11/7, 다른 해는 '27 1/5 (엔진 formatShort와 같은 규칙)
const displayDate = (date: string) => formatShort(date)

// 다음 마일스톤: 진수 전이면 진수, 진수 뒤면 인도, 인도했으면 운항 중
function nextMilestone(ship: Ship): { name: string; date: string; done: boolean } {
  if (ship.launch > CLOCK_TODAY) return { name: "진수", date: ship.launch, done: false }
  if (ship.delivery > CLOCK_TODAY) return { name: "인도", date: ship.delivery, done: false }
  return { name: "인도 완료 · 운항 중", date: ship.delivery, done: true }
}

function dday(date: string) {
  const days = Math.ceil(
    (new Date(`${date}T00:00:00`).getTime() - TODAY.getTime()) / 86400000,
  )
  return {
    text: days >= 0 ? `D-${days}` : `D+${Math.abs(days)}`,
    tone: days < 0 || days <= 2 ? "danger" : days <= 7 ? "warning" : "neutral",
  }
}

function Source({ children }: { children: React.ReactNode }) {
  return <span className="source">{children}</span>
}

function DateWithDday({ date, source }: { date: string; source?: string }) {
  const d = dday(date)
  return (
    <span className="date-with-dday">
      <span className="numeric">{displayDate(date)}</span>
      <span className={`dday ${d.tone}`}>{d.text}</span>
      {source && <Source>{source}</Source>}
    </span>
  )
}

const SYNC_LABEL = { off: "", connecting: "연결 중", live: "실시간 공유", local: "이 브라우저에만 저장" } as const

// 로그인한 사람 + 로그아웃 (탭마다 따로)
function UserChip() {
  const { user, logout } = useAuth()
  if (!user) return null
  return (
    <span className="user-chip">
      <strong>{user.name}</strong>
      {user.department} · {user.roleLabel}
      <button onClick={logout}>로그아웃</button>
    </span>
  )
}

function Header({ onLogo }: { onLogo: () => void }) {
  const { sync } = useStore()
  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={onLogo}
        aria-label="프로젝트 선택으로 이동"
      >
        <BrandMark />
        <Wordmark />
      </button>
      <button className="project-chip" onClick={onLogo}>
        <span className="project-dot" />
        프로젝트 {project.name} <span>·</span> {VESSEL_COUNT} <span>·</span> {VESSEL_RANGE}
      </button>
      {sync.room && (
        <span className={`sync-badge ${sync.status}`} title={sync.message ?? ""}>
          <i />
          공유 방 <b>{sync.room}</b> · {SYNC_LABEL[sync.status]}
          {sync.status === "live" && sync.savedAt && <span className="numeric"> · 저장 {new Date(sync.savedAt).toTimeString().slice(0, 8)}</span>}
          {sync.message && <small>{sync.message}</small>}
        </span>
      )}
      <UserChip />
    </header>
  )
}

function Sidebar({
  view,
  setView,
  meetingCount,
}: {
  view: View
  setView: (view: View) => void
  meetingCount: number
}) {
  return (
    <aside className="sidebar">
      <nav aria-label="주 메뉴">
        <button
          className={view === "schedule" || view === "ship" ? "active" : ""}
          onClick={() => setView("schedule")}
        >
          <span className="menu-no">1</span>
          <span>일정·진척</span>
        </button>
        <button
          className={
            view === "changes" ||
            view === "change-new" ||
            view === "change-detail"
              ? "active"
              : ""
          }
          onClick={() => setView("changes")}
        >
          <span className="menu-no">2</span>
          <span>설계변경</span>
          <span className="count-badge">{meetingCount}</span>
        </button>
        <button
          className={view === "cases" || view === "case-detail" ? "active" : ""}
          onClick={() => setView("cases")}
        >
          <span className="menu-no">3</span>
          <span>사례</span>
        </button>
        <button className={view === "ontology" ? "active" : ""} onClick={() => setView("ontology")}>
          <span className="menu-no">4</span>
          <span>온톨로지</span>
        </button>
      </nav>
    </aside>
  )
}

// 프로젝트 선택 목록: 맨 위는 지금 데이터셋(열 수 있음), 나머지는 portfolio.json (열 수 없는 목록)
type ProjectRow = { name: string; type: string; shipType: string; vessels: string; phase: string; progress: number; reviews: number; deadline: string; dday: string; open?: boolean; sortKey?: string }
const portfolioRows: ProjectRow[] = shiftDates(portfolioData, DEMO_DAYS).map((row) => ({
  ...row,
  deadline: row.deadline ? formatShort(row.deadline) : "",
  dday: row.deadline ? `D-${daysBetween(CLOCK_TODAY, row.deadline)}` : "",
}))

function Entry({ enter }: { enter: () => void }) {
  const [search, setSearch] = useState("")
  const [type, setType] = useState("")
  const [phase, setPhase] = useState("")
  // 프로젝트 목록 = 새 엔진의 데이터셋 (설계변경 목록 · 회의 화면 · 일정과 같은 값). 열 수 있는 건 지금 데이터셋(DATASET)
  const { rows: datasets, error: datasetsError } = useDatasets()
  const live: ProjectRow[] = (datasets ?? [])
    .map((d) => ({
      name: d.series || d.name,
      type: d.name.replace(/\s*\([^)]*\)\s*$/, ""), // 데이터셋 내부 메모(팀원 DB 기반 등)는 화면에 안 보임
      shipType: d.shipType,
      vessels: `${d.hulls}척 · ${d.summary.hullRange}`,
      phase: d.summary.stage,
      progress: d.summary.progress,
      reviews: d.summary.open,
      deadline: d.summary.nearestDeadline ? formatShort(d.summary.nearestDeadline.date) : "",
      dday: d.summary.nearestDeadline ? `D-${d.summary.nearestDeadline.dday}` : "",
      open: d.id === DATASET,
      sortKey: d.summary.nearestDeadline?.date ?? "9999",
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  const shipTypes = [...new Set(live.map((row) => row.shipType))]
  const phases = [...new Set(live.map((row) => row.phase))]
  const rows = live.filter(
    (project) =>
      (!search ||
        `${project.name} ${project.type} ${project.vessels}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!type || project.shipType === type) &&
      (!phase || project.phase === phase),
  )
  return (
    <div className="entry-page">
      <Header onLogo={() => {}} />
      <main className="entry-main">
        <div className="entry-heading">
          <h1>프로젝트 선택</h1>
          <p>시리즈별 설계변경 검토 · 건조 일정 현황</p>
        </div>
        <div className="project-summary-strip">
          <span>
            <small>진행 중 프로젝트</small>
            <strong className="numeric">{datasets ? live.length : "-"}</strong>
          </span>
          <span>
            <small>검토 중 설계변경</small>
            <strong className="numeric">{live.reduce((sum, p) => sum + p.reviews, 0)}건</strong>
          </span>
          <span>
            <small>7일 안에 결정 마감</small>
            <strong className="numeric danger-text">{live.filter((p) => p.dday && Number(p.dday.replace("D-", "")) <= 7).length}건</strong>
          </span>
        </div>
        <section className="project-list-card card">
          <div className="project-list-tools">
            <label className="project-search">
              <span />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="프로젝트, 선종, 호선 검색"
              />
            </label>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              aria-label="선종"
            >
              <option value="">선종: 전체</option>
              {shipTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select
              value={phase}
              onChange={(event) => setPhase(event.target.value)}
              aria-label="상태"
            >
              <option value="">상태: 전체</option>
              {phases.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <span className="project-list-count">
              <strong className="numeric">{rows.length}</strong>개 프로젝트
            </span>
            <span className="project-sort">결정 마감 가까운 순</span>
          </div>
          <div className="project-table-wrap">
            <table className="project-table">
              <colgroup>
                <col style={{ width: "26%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "8%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>프로젝트</th>
                  <th>호선</th>
                  <th>건조 단계</th>
                  <th>평균 진척</th>
                  <th>검토 중 설계변경</th>
                  <th>가장 가까운 결정 마감</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((project) => (
                  <tr
                    key={project.name}
                    className={project.open ? "project-row-open" : ""}
                    onClick={project.open ? enter : undefined}
                    onKeyDown={
                      project.open
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ")
                              enter()
                          }
                        : undefined
                    }
                    tabIndex={project.open ? 0 : undefined}
                    role={project.open ? "link" : undefined}
                  >
                    <td>
                      <span className="project-name-cell">
                        <i className="project-type-icon">
                          <span />
                        </i>
                        <span>
                          <strong>{project.name}</strong>
                          <small>{project.type}</small>
                        </span>
                      </span>
                    </td>
                    <td className="numeric">{project.vessels}</td>
                    <td>
                      <span
                        className={`phase-pill ${
                          project.phase === "건조 중"
                            ? "building"
                            : project.phase === "설계"
                              ? "designing"
                              : "warranty"
                        }`}
                      >
                        {project.phase}
                      </span>
                    </td>
                    <td>
                      <span className="project-progress">
                        <i>
                          <b style={{ width: `${project.progress}%` }} />
                        </i>
                        <strong className="numeric">{project.progress}%</strong>
                      </span>
                    </td>
                    <td>
                      {project.reviews ? (
                        <strong className="numeric review-count">
                          {project.reviews}건
                        </strong>
                      ) : (
                        <span className="no-value">-</span>
                      )}
                    </td>
                    <td>
                      {project.deadline ? (
                        <span className="project-deadline">
                          <strong className="numeric">
                            {project.deadline}
                          </strong>
                          <span
                            className={`dday ${
                              Number(project.dday.replace("D-", "")) <= 7 ? "warning" : "neutral"
                            }`}
                          >
                            {project.dday}
                          </span>
                        </span>
                      ) : (
                        <span className="no-value">-</span>
                      )}
                    </td>
                    <td className="open-cell">
                      {project.open && (
                        <span className="open-project">열기 →</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      {datasetsError ?? (datasets ? "조건에 맞는 프로젝트가 없어요." : "프로젝트를 불러오는 중이에요…")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  )
}

// 호선 인도일은 결정과 지연이 반영된 저장소 값을 쓰고, 진수일도 같은 만큼 민다
function useShips(): Ship[] {
  const { state } = useStore()
  return baseShips.map((ship) => {
    const vessel = state.series.vessels.find((v) => v.id === ship.id)
    if (!vessel) return ship
    const delta = daysBetween(ship.delivery, vessel.delivery)
    return { ...ship, delivery: vessel.delivery, launch: addDays(ship.launch, delta), previous: vessel.previousDelivery }
  })
}

// 시리즈 통합 일정: 호선마다 블록 제작·탑재(착공→진수)와 의장·시운전(진수→인도) 두 구간.
// 오늘선 왼쪽(지난 기간)은 진하게, 오른쪽(남은 기간)은 옅게.
// 설계변경 결정으로 인도일이 밀린 호선은 원래 인도일부터 새 인도일까지 빨간 빗금, 인도 마름모를 빨갛게 하고 옆에 "+n일"
const TODAY_ISO = CLOCK_TODAY

function Phase({ from, to, kind, label }: { from: string; to: string; kind: "build" | "trial"; label: string }) {
  const left = pos(from)
  const right = pos(to)
  const now = Math.min(Math.max(pos(TODAY_ISO), left), right)
  const done = right > left ? ((now - left) / (right - left)) * 100 : 0
  return (
    <div
      className={`phase ${kind} ${done > 35 ? "mostly-done" : ""}`}
      style={{ left: `${left}%`, width: `${right - left}%`, "--done": `${done}%` } as React.CSSProperties}
      title={`${label} ${displayDate(from)} ~ ${displayDate(to)}`}
    >
      <span>{label}</span>
    </div>
  )
}

function Gantt() {
  const ships = useShips()
  const months = Array.from({ length: RANGE_MONTHS }, (_, i) => {
    const d = new Date(RANGE_FIRST.year, RANGE_FIRST.month + i, 1)
    return {
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label:
        d.getMonth() === 0 || i === 0
          ? `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}`
          : `${String(d.getMonth() + 1).padStart(2, "0")}`,
    }
  })
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
            늦어진 기간
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
          <div className="months" style={{ gridTemplateColumns: `repeat(${RANGE_MONTHS}, 1fr)` }}>
            {months.map((m) => (
              <span key={m.key}>{m.label}</span>
            ))}
            <span className="today-flag" style={{ left: `${pos(TODAY_ISO)}%` }}>
              오늘 {displayDate(TODAY_ISO)}
            </span>
          </div>
          <div className="gantt-date-head">인도일</div>
          {ships.map((ship) => {
            const { delivery, launch, previous } = ship
            const delay = previous ? daysBetween(previous, delivery) : 0
            // 밀렸어도 계약 납기 안이면 '여유 안'(주황), 계약 납기를 넘으면 빨강
            const withinContract = delay > 0 && Boolean(ship.contract) && delivery <= ship.contract!
            return (
              <div className="gantt-row-wrap" key={ship.id}>
                <div className="gantt-label">
                  <strong>{ship.order}</strong>
                  <span>{ship.id}</span>
                </div>
                <div className="timeline" style={{ backgroundSize: `calc(100% / ${RANGE_MONTHS}) 100%` }}>
                  <div className="today-line" style={{ left: `${pos(TODAY_ISO)}%` }} />
                  <Phase from={ship.start} to={launch} kind="build" label="블록 제작·탑재" />
                  <Phase from={launch} to={delivery} kind="trial" label="의장·시운전" />
                  {delay > 0 && (
                    <div
                      className={`slip ${withinContract ? "within" : ""}`}
                      style={{ left: `${pos(previous!)}%`, width: `${pos(delivery) - pos(previous!)}%` }}
                      title={`설계변경 결정으로 인도 +${delay}일 (원래 ${displayDate(previous!)} → ${displayDate(delivery)})`}
                    />
                  )}
                  <i className="ms launch" style={{ left: `${pos(launch)}%` }} title={`진수 ${displayDate(launch)}`} />
                  <i
                    className={`ms delivery ${delay > 0 ? (withinContract ? "within" : "delayed") : ""}`}
                    style={{ left: `${pos(delivery)}%` }}
                    title={delay > 0 ? `인도 ${displayDate(delivery)} · 설계변경 결정으로 +${delay}일 (원래 ${displayDate(previous!)})` : `인도 ${displayDate(delivery)} (예정대로)`}
                  />
                  {delay > 0 && (
                    <span className={`slip-label ${withinContract ? "within" : ""}`} style={{ left: `${pos(delivery)}%` }}>
                      +{delay}일{withinContract ? " · 여유 안" : ""}
                    </span>
                  )}
                </div>
                <div className="gantt-delivery">
                  <span>
                    <strong className="numeric">{displayDate(delivery)}</strong>
                    {delay > 0 && <span className={withinContract ? "delay-within" : "delay"}>+{delay}일</span>}
                  </span>
                  {ship.inService ? <span className="status-pill warning">운항 중</span> : <Source>PLM</Source>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// 배 옆모습을 건조 진척만큼 왼쪽부터 칠한다 (HTML 프로토타입의 배 모양 진척). 모양은 프로젝트 선종(project.json shipType)에 따라
const HULL = <path d="M4 34 H196 L187 50 H22 Q9 49 4 34 Z" />
const BRIDGE = (
  <>
    <rect x="166" y="16" width="20" height="18" />
    <rect x="172" y="9" width="7" height="7" />
  </>
)
const SHIP_SHAPES = project.shipType.includes("LNG") ? (
  // LNG운반선: 둥근 화물 탱크 4개
  <>
    {HULL}
    <path d="M28 34 a14 12 0 0 1 28 0 Z" />
    <path d="M62 34 a14 12 0 0 1 28 0 Z" />
    <path d="M96 34 a14 12 0 0 1 28 0 Z" />
    <path d="M130 34 a14 12 0 0 1 28 0 Z" />
    {BRIDGE}
  </>
) : project.shipType.includes("컨테이너") ? (
  // 컨테이너선: 갑판 위 컨테이너 더미
  <>
    {HULL}
    <rect x="22" y="22" width="30" height="12" />
    <rect x="56" y="18" width="30" height="16" />
    <rect x="90" y="18" width="30" height="16" />
    <rect x="124" y="22" width="30" height="12" />
    {BRIDGE}
  </>
) : (
  // 탱커 · 기타: 평평한 갑판과 배관
  <>
    {HULL}
    <rect x="24" y="30" width="134" height="4" />
    <rect x="70" y="24" width="4" height="6" />
    <rect x="110" y="24" width="4" height="6" />
    {BRIDGE}
  </>
)

function ShipProgress({ progress }: { progress: number }) {
  const clip = useId()
  const width = Math.max(0, Math.min(100, progress)) * 2
  return (
    <svg className="ship-progress" viewBox="0 0 200 54" role="img" aria-label={`건조 진척 ${progress}%`}>
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width={width} height="54" />
        </clipPath>
      </defs>
      <g className="base">{SHIP_SHAPES}</g>
      <g className="fill" clipPath={`url(#${clip})`}>
        {SHIP_SHAPES}
      </g>
      <g className="line">{SHIP_SHAPES}</g>
    </svg>
  )
}

function ShipCards({ open }: { open: (id: string) => void }) {
  const ships = useShips()
  return (
    <section className="card ship-status-card">
      <div className="card-head">
        <div>
          <h2>호선별 상세 현황</h2>
        </div>
        <span className="updated">
          최근 갱신 <span className="numeric">{formatShort(CLOCK_TODAY)} 09:00</span>
        </span>
      </div>
      <div className="ship-grid">
        {ships.map((ship) => (
          <button
            className="ship-card"
            key={ship.id}
            onClick={() => open(ship.id)}
          >
            <span className="ship-card-title">
              <span>
                <small>{ship.order}</small>
                <strong>{ship.id}</strong>
              </span>
              <span className="arrow">→</span>
            </span>
            <span className="progress-copy">
              <b className="numeric">{ship.progress}%</b>
              <Source>MES</Source>
            </span>
            <ShipProgress progress={ship.progress} />
            <span className="ship-facts">
              <span>
                <small>지금 공정</small>
                <b>{ship.process}</b>
              </span>
              <span>
                <small>다음 마일스톤</small>
                <b>
                  {nextMilestone(ship).name} · {displayDate(nextMilestone(ship).date)}
                </b>
              </span>
              <span>
                <small>인도일</small>
                <b className="numeric">
                  {displayDate(ship.delivery)}{" "}
                  {ship.previous && (
                    <em className={ship.contract && ship.delivery <= ship.contract ? "within" : ""}>
                      +
                      {Math.round(
                        (new Date(ship.delivery).getTime() -
                          new Date(ship.previous).getTime()) /
                          86400000,
                      )}
                    </em>
                  )}
                </b>
              </span>
            </span>
            {ship.note && <span className="ship-note">{ship.note}</span>}
          </button>
        ))}
      </div>
    </section>
  )
}

function SchedulePage({ openShip }: { openShip: (id: string) => void }) {
  return (
    <>
      <div className="page-title">
        <div>
          <h1>시리즈 일정</h1>
          <p>시리즈 호선별 주요 일정 · 진척 현황</p>
        </div>
      </div>
      <Gantt />
      <ShipCards open={openShip} />
    </>
  )
}

function ShipTabs({
  selected,
  select,
}: {
  selected: string
  select: (id: string) => void
}) {
  const ships = useShips()
  return (
    <div className="ship-tabs" role="tablist">
      {ships.map((ship) => (
        <button
          role="tab"
          aria-selected={ship.id === selected}
          className={ship.id === selected ? "active" : ""}
          key={ship.id}
          onClick={() => select(ship.id)}
        >
          <span>{ship.order}</span>
          <strong>{ship.id}</strong>
        </button>
      ))}
    </div>
  )
}

function Summary({ ship }: { ship: Ship }) {
  const next = dday(ship.launch)
  return (
    <section className="summary-grid">
      <div className="summary-main card">
        <span className="summary-label">종합 진척</span>
        <div>
          <strong className="big-number numeric">
            {ship.progress}
            <small>%</small>
          </strong>
          <Source>MES</Source>
        </div>
        <span className="large-progress">
          <i style={{ width: `${ship.progress}%` }} />
        </span>
      </div>
      <div className="summary-item card">
        <span className="summary-label">지금 공정</span>
        <strong>{ship.process}</strong>
        <span className="subline">
          계획 대비 정상 <Source>MES</Source>
        </span>
      </div>
      <div className="summary-item card">
        <span className="summary-label">다음 마일스톤</span>
        <strong>{nextMilestone(ship).name}</strong>
        {nextMilestone(ship).done ? <span className="subline">{displayDate(ship.delivery)} 인도</span> : <DateWithDday date={nextMilestone(ship).date} source="PLM" />}
      </div>
      <div className="summary-item card">
        <span className="summary-label">인도 목표</span>
        <strong className="numeric">{displayDate(ship.delivery)}</strong>
        <span className={ship.previous ? "subline danger-text" : "subline"}>
          {ship.previous
            ? `이전 기준선보다 ${Math.round((new Date(ship.delivery).getTime() - new Date(ship.previous).getTime()) / 86400000)}일 늦어요`
            : `${next.text} · 계획대로`}{" "}
          <Source>PLM</Source>
        </span>
      </div>
    </section>
  )
}

// 차이: 실적이 있으면 실적 - 계획, 없으면 계획대로
const gap = (plan: string, actual?: string) => {
  const d = actual ? daysBetween(plan, actual) : 0
  return d > 0 ? `+${d}일` : d < 0 ? `${d}일` : "계획대로"
}

function Milestones({ ship }: { ship: Ship }) {
  const base = baseShips.find((s) => s.id === ship.id) ?? ship
  // 데이터의 마일스톤(착공 · 탑재 시작 등) 뒤에 진수 · 인도를 붙인다. 인도는 결정으로 밀린 만큼 차이로 보여 준다
  const rows: Array<[string, string, string, string]> = [
    ...detailData[ship.id].milestones.map((m): [string, string, string, string] => [m.name, displayDate(m.plan), m.actual ? displayDate(m.actual) : "—", gap(m.plan, m.actual)]),
    ["진수", displayDate(base.launch), ship.launch < CLOCK_TODAY ? displayDate(ship.launch) : "—", gap(base.launch, ship.launch === base.launch ? undefined : ship.launch)],
    ["인도", displayDate(ship.previous ?? ship.delivery), ship.delivery < CLOCK_TODAY ? displayDate(ship.delivery) : "—", gap(ship.previous ?? ship.delivery, ship.previous ? ship.delivery : undefined)],
  ]
  return (
    <section className="card split-card">
      <div className="card-head">
        <div>
          <h2>주요 마일스톤</h2>
        </div>
        <Source>PLM</Source>
      </div>
      <table>
        <colgroup>
          <col style={{ width: "25%" }} />
          <col style={{ width: "25%" }} />
          <col style={{ width: "25%" }} />
          <col style={{ width: "25%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>마일스톤</th>
            <th>계획</th>
            <th>실적</th>
            <th>차이</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              <td>
                <strong>{row[0]}</strong>
              </td>
              <td className="numeric">{row[1]}</td>
              <td className="numeric">{row[2]}</td>
              <td>
                <span
                  className={`status-pill ${
                    row[3].startsWith("+") ? "danger" : "success"
                  }`}
                >
                  {row[3]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ProcessProgress({ ship }: { ship: Ship }) {
  const names = project.processes
  return (
    <section className="card split-card">
      <div className="card-head">
        <div>
          <h2>공정별 진척</h2>
        </div>
        <Source>MES</Source>
      </div>
      <div className="process-list">
        {names.map((name, i) => (
          <div className="process-row" key={name}>
            <span>{name}</span>
            <div className="process-bar">
              <i style={{ width: `${ship.processes[i]}%` }} />
            </div>
            <strong className="numeric">{ship.processes[i]}%</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

const BLOCK_NAMES = project.blocks
const BLOCK_CODES = Object.keys(project.blocks)

// 이 호선에 걸린 설계변경: 검토 중이면 지금 고른 목표일로, 결정했으면 결정 당시 계산으로 이 호선 결과를 본다
type ShipChange = {
  change: Change
  decided: boolean
  target: string
  row: SimRow
  deadline?: string
  lead: number
  opts?: SimOptions // 검토 중이면 화면이 쓰는 조건 (고른 안 · 선주 우선순위)
}

function useShipChanges(shipId: string): ShipChange[] {
  const { state, ctx } = useStore()
  return state.changes.flatMap((change): ShipChange[] => {
    if (change.status === "decided" && change.decision) {
      const row = plannedTasks(ctx, change, change.decision).sim.rows.find((r) => r.vessel.id === shipId)
      const lead = params(ctx, change, { overrides: change.decision.overrides, method: change.decision.method }).values.purchase
      return row ? [{ change, decided: true, target: change.decision.target, row, lead }] : []
    }
    if (change.status !== "review" || change.boundary !== "production") return []
    const draft = state.drafts[change.code]
    const opts = withMethod(ctx, change, draftOptions(draft))
    const target = draftTarget(ctx, change, draft)
    const row = simulate(ctx, change, target, opts).rows.find((r) => r.vessel.id === shipId)
    const lead = params(ctx, change, opts).values.purchase
    return row ? [{ change, decided: false, target, row, deadline: meetingDeadline(ctx, change, opts).date, lead, opts }] : []
  })
}

// 블록 하나의 결론: 검토 중인 변경은 "다음 문턱 전에 반영하면 / 넘기면 / 늦어도 언제 결정", 결정된 변경은 이 호선 처리
function BlockConclusion({ item, shipId, open }: { item: ShipChange; shipId: string; open: (code: string) => void }) {
  const { ctx } = useStore()
  const { change, decided, target, row } = item
  const method = item.opts?.method ?? change.decision?.method
  const head = (
    <span>
      <b>{change.code}</b>
      {decided ? <span className="status-pill primary">결정됨</span> : <span className="status-pill warning">검토 중</span>}
      {method && <span className="method-mini">{method} {METHOD_LABEL[method]}</span>}
    </span>
  )
  if (decided)
    return (
      <button className="ship-change" onClick={() => open(change.code)}>
        {head}
        <small>
          {change.title} · {displayDate(target)} 반영 · 이 호선 <em className={row.delay ? "bad" : "ok"}>{row.handling}{row.delay ? ` +${row.delay}일` : ""}</em>
        </small>
      </button>
    )
  const o = blockOutlook(ctx, change, shipId, item.opts)
  if (!o) return null
  const days = (r: SimRow) => (r.delay ? `${r.handling} ${r.delay}일` : r.handling)
  return (
    <button className="ship-change block-conclusion" onClick={() => open(change.code)}>
      {head}
      {o.next ? (
        <>
          <strong className="conclusion-line">
            {o.next.threshold.event} {displayDate(o.next.threshold.date)} 전에 반영하면 <em className={o.next.keep.delay ? "bad" : "ok"}>{days(o.next.keep)}</em>
            {o.next.after.delay > o.next.keep.delay && (
              <>
                , 넘기면 <em className="bad">{days(o.next.after)}</em> (+{o.next.after.delay - o.next.keep.delay}일)
              </>
            )}
          </strong>
          <small className="numeric">
            늦어도 {displayDate(o.next.decideBy)} <span className={`dday ${dday(o.next.decideBy).tone}`}>{dday(o.next.decideBy).text}</span> 결정 ·{" "}
            {o.next.teams} 일을 시작해야 하는 날
          </small>
        </>
      ) : (
        <strong className="conclusion-line">
          이미 {o.stage}라 <em className={o.final?.delay ? "bad" : "ok"}>{o.final ? days(o.final) : "-"}</em>
          {o.final?.delay ? "은 피할 수 없어요" : "로 반영돼요"}
        </strong>
      )}
      {o.missed.length > 0 && (
        <small>{o.missed.map((m) => `${m.event} ${displayDate(m.date)}`).join(" · ")} 전 반영은 팀이 맞출 수 없어요</small>
      )}
    </button>
  )
}

const STAGE_NEXT: Record<string, (b: BlockSchedule) => [string, string] | null> = {
  "착수 전": (b) => ["착수", b.start],
  "제작 중": (b) => ["제작 완료", b.end],
  "제작 완료 · 탑재 대기": (b) => ["탑재", b.mount],
  "탑재 완료": () => null,
}

function BlockStatus({ ship, openChange }: { ship: Ship; openChange: (code: string) => void }) {
  const { ctx } = useStore()
  const detail = detailData[ship.id]
  const colors = ["mounted", "ready", "working", "waiting"]
  const labels = project.blockStates
  const total = detail.blockCounts.reduce((a, b) => a + b, 0)
  const vessel = ctx.series.vessels.find((v) => v.id === ship.id)
  const changes = useShipChanges(ship.id)
  const blocks = vessel ? Object.entries(vessel.blocks).sort((a, b) => a[1].start.localeCompare(b[1].start)) : []
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>블록 현황</h2>
        </div>
        <span className="total">
          전체 <strong className="numeric">{total}</strong>개{" "}
          <Source>MES</Source>
        </span>
      </div>
      <div className="block-summary">
        <div className="stacked-bar">
          {detail.blockCounts.map((count, i) => (
            <i
              key={labels[i]}
              className={colors[i]}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ))}
        </div>
        <div className="block-legend">
          {labels.map((label, i) => (
            <span key={label}>
              <i className={colors[i]} />
              <span>{label}</span>
              <strong className="numeric">{detail.blockCounts[i]}</strong>
            </span>
          ))}
        </div>
      </div>
      <div className="subsection-head">
        <h3>설계변경이 걸린 블록</h3>
        <span>다음 문턱(착수 · 제작 완료 · 탑재) 전에 반영해야 손해가 안 커져요</span>
      </div>
      <table className="block-table">
        <colgroup>
          <col style={{ width: "12%" }} />
          <col style={{ width: "52%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>블록</th>
            <th>이 블록의 결론</th>
            <th>지금 단계</th>
            <th>만드는 곳</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map(([code, block]) => {
            const stage = stageOf(block, ctx.series.today)
            const next = STAGE_NEXT[stage](block)
            const list = changes.filter((c) => c.change.block === code)
            const maker = block.partner ?? "사내"
            return (
              <tr key={code}>
                <td>
                  <strong className="numeric">{code}</strong>
                  <span className="cell-sub">{BLOCK_NAMES[code] ?? ""}</span>
                </td>
                <td>
                  {list.length ? (
                    <div className="ship-change-list">
                      {list.map((item) => (
                        <BlockConclusion key={item.change.code} item={item} shipId={ship.id} open={openChange} />
                      ))}
                    </div>
                  ) : (
                    <span className="no-value">걸린 설계변경 없음</span>
                  )}
                </td>
                <td>
                  {stage}
                  {next && (
                    <span className="cell-sub numeric">
                      {next[0]} {displayDate(next[1])} <span className={`dday ${dday(next[1]).tone}`}>{dday(next[1]).text}</span>
                    </span>
                  )}
                </td>
                <td>
                  <span className={`maker ${maker === "사내" ? "inhouse" : "partner"}`}>{maker}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

// 설계변경으로 새로 필요한 자재: 이 호선에 언제 필요하고, 재고로 쓰는지 발주하는지, 제때 오는지
function Materials({ ship, openChange }: { ship: Ship; openChange: (code: string) => void }) {
  const { ctx } = useStore()
  const today = ctx.series.today
  const rows = useShipChanges(ship.id).filter((item) => item.change.material)
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>설계변경 자재</h2>
        </div>
        <Source>ERP</Source>
      </div>
      <table>
        <colgroup>
          <col style={{ width: "27%" }} />
          <col style={{ width: "15%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "16%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>자재</th>
            <th>걸린 변경</th>
            <th>이 호선에 필요한 날</th>
            <th>구하는 법</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map(({ change, decided, row, lead }) => {
              const material = change.material!
              const orderBy = addDays(row.need, -lead)
              const status =
                row.source === "stock"
                  ? { tone: "success", text: "재고 확보" }
                  : row.materialWait > 0
                    ? { tone: "danger", text: `${row.materialWait}일 늦게 와요` }
                    : decided && row.arrival && row.arrival <= today
                      ? { tone: "success", text: "입고 완료" }
                      : { tone: "success", text: "제때 도착" }
              return (
                <tr key={change.code}>
                  <td>
                    <strong>{material.item}</strong>
                    <span className="cell-sub">
                      {material.code}
                      {material.old?.open ? ` · 기존 ${material.old.item} 발주 ${material.old.open}척분은 취소·전용 검토` : ""}
                    </span>
                  </td>
                  <td>
                    <button className="ship-change" onClick={() => openChange(change.code)}>
                      <span>
                        <b>{change.code}</b>
                      </span>
                      <small>
                        {change.block} · {decided ? "결정됨" : "검토 중"}
                      </small>
                    </button>
                  </td>
                  <td>
                    {row.need < today ? <span className="numeric">{displayDate(row.need)}</span> : <DateWithDday date={row.need} />}
                  </td>
                  <td>
                    {row.source === "stock" ? (
                      "재고에서 씀"
                    ) : (
                      <>
                        발주 · 조달 {lead}일{row.arrival ? ` → ${displayDate(row.arrival)} 도착` : ""}
                        {!decided && <span className="cell-sub numeric">제때 받으려면 {displayDate(orderBy)}까지 발주</span>}
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${status.tone}`}>{status.text}</span>
                  </td>
                </tr>
              )
            })
          ) : (
            <tr>
              <td colSpan={5} className="empty-cell">
                이 호선에 설계변경으로 새로 필요한 자재가 없어요.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}

function ShipDetail({
  selected,
  setSelected,
  openChange,
  back,
}: {
  selected: string
  setSelected: (id: string) => void
  openChange: (code: string) => void
  back: () => void
}) {
  const ships = useShips()
  const ship = ships.find((s) => s.id === selected) ?? ships[0]
  return (
    <>
      <div className="page-title">
        <div>
          <button className="back-link" onClick={back}>
            ← 시리즈 일정
          </button>
          <h1>{ship.order} 상세 현황</h1>
          <p>공정 · 블록 · 자재 일정 현황</p>
        </div>
      </div>
      <ShipTabs selected={selected} select={setSelected} />
      <Summary ship={ship} />
      <div className="two-column">
        <Milestones ship={ship} />
        <ProcessProgress ship={ship} />
      </div>
      <BlockStatus ship={ship} openChange={openChange} />
      <Materials ship={ship} openChange={openChange} />
    </>
  )
}

function ScopePill({ children }: { children: string }) {
  const className = children.includes("생산")
    ? "production"
    : children.includes("규정")
      ? "external"
      : children.includes("계약")
        ? "contract"
        : "design"
  return <span className={`scope-pill ${className}`}>{children}</span>
}

function ResultBand({ level = 0 }: { level?: number }) {
  return (
    <span className="result-band" aria-label={`지연 결과 ${level + 1}단계`}>
      {[0, 1, 2, 3].map((item) => (
        <i key={item} className={item <= level ? `level-${level}` : ""} />
      ))}
    </span>
  )
}

function ChangeFilters({
  search,
  setSearch,
  scope,
  setScope,
  block,
  setBlock,
  urgent,
  setUrgent,
  count,
  total,
  reset,
}: {
  search: string
  setSearch: (value: string) => void
  scope: string
  setScope: (value: string) => void
  block: string
  setBlock: (value: string) => void
  urgent: boolean
  setUrgent: (value: boolean) => void
  count: number
  total: number
  reset: () => void
}) {
  return (
    <div className="filter-bar">
      <label className="search-field">
        <span aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="변경 코드·제목 검색"
          aria-label="설계변경 검색"
        />
      </label>
      <select
        value={scope}
        onChange={(event) => setScope(event.target.value)}
        aria-label="영향 범위"
      >
        <option value="">영향 범위 전체</option>
        <option value="생산·구매까지">생산·구매까지</option>
        <option value="규정(선급)까지">규정(선급)까지</option>
        <option value="계약(선주)까지">계약(선주)까지</option>
        <option value="설계 안에서 끝남">설계 안에서 끝남</option>
      </select>
      <select
        value={block}
        onChange={(event) => setBlock(event.target.value)}
        aria-label="블록"
      >
        <option value="">블록 전체</option>
        {BLOCK_CODES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={urgent}
          onChange={(event) => setUrgent(event.target.checked)}
        />
        <span className="toggle" />
        <span>7일 안에 마감</span>
      </label>
      <span className="filter-count">
        <strong className="numeric">{count}</strong> / 전체{" "}
        <span className="numeric">{total}</span>건
      </span>
      <button className="ghost-button" onClick={reset}>
        초기화
      </button>
    </div>
  )
}

// 목록의 한 줄: 결정 마감 · 시점 · 결과는 모두 엔진이 계산한다
function useChangeRow(change: Change) {
  const { ctx, state } = useStore()
  if (change.boundary === "design") return { scope: scopeOf(change), timing: "형상·자재 영향 없음", deadline: null }
  const d = meetingDeadline(ctx, change, draftOptions(state.drafts[change.code]))
  return { scope: scopeOf(change), timing: timingDistribution(ctx, change), deadline: d }
}

function readNotice(change: Change) {
  const read = change.readBy ?? []
  const missing = ["설계", "구매", "생산"].filter((dept) => !read.includes(dept))
  return `열람: ${read.join(" · ") || "-"}${missing.length ? ` (${missing.join(" · ")} 미열람)` : ""}`
}

function BeforeDecisionRow({ item, open }: { item: Change; open: (code: string) => void }) {
  const row = useChangeRow(item)
  return (
    <tr onClick={() => open(item.code)}>
      <td>
        <span className="change-code-wrap">
          {item.isNew && <i className="new-dot" />}
          <strong className="numeric">{item.code}</strong>
        </span>
        {item.ecr && <small className="numeric">{item.ecr}</small>}
      </td>
      <td>
        <strong className="row-title">{item.title}</strong>
        <span className="row-meta">
          {item.auto ? "PLM 자동 등록" : `${item.reason} · ${item.block}`} {item.auto && <Source>PLM</Source>}
        </span>
      </td>
      <td>
        <span className="scope-list">
          {row.scope.map((value) => (
            <ScopePill key={value}>{value}</ScopePill>
          ))}
        </span>
      </td>
      <td>
        <span className="cell-main">{row.timing}</span>
        <span className="row-meta">
          {item.block} <Source>MES</Source>
        </span>
      </td>
      <td>
        {row.deadline ? (
          <>
            <DateWithDday date={row.deadline.date} />
            <span className="row-meta">
              기준: {row.deadline.teams} <Source>PLM</Source>
            </span>
          </>
        ) : (
          <>
            <span className="status-pill neutral">알림만</span>
            <span className="row-meta">{readNotice(item)}</span>
          </>
        )}
      </td>
      <td>
        <span className="cell-main">
          {row.deadline ? `${row.deadline.result.label} · 최대 지연 ${row.deadline.result.maxDelay}일` : "일정 영향 없음"}
        </span>
        <ResultBand level={row.deadline ? delayLevel(row.deadline.result.totalDelay) : 0} />
      </td>
    </tr>
  )
}

function BeforeDecisionTable({
  rows,
  withdrawn,
  open,
}: {
  rows: Change[]
  withdrawn: Change[]
  open: (code: string) => void
}) {
  return (
    <div className="change-table-wrap">
      <table className="change-table before-table">
        <colgroup>
          <col style={{ width: "10%" }} />
          <col style={{ width: "23%" }} />
          <col style={{ width: "18%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "17%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>변경</th>
            <th>제목</th>
            <th>영향 범위</th>
            <th>시점</th>
            <th>결정 마감</th>
            <th>오늘 정하면</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <BeforeDecisionRow key={item.code} item={item} open={open} />
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={6} className="empty-cell">
                조건에 맞는 설계변경이 없어요.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {withdrawn.map((item) => (
        <button className="withdrawn-row" key={item.code} onClick={() => open(item.code)}>
          <span>철회</span>
          <strong className="numeric">1건</strong>
          <span>
            {item.code} · {item.title}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
      ))}
    </div>
  )
}

function TeamProgress({ name, value, label }: { name: string; value: number; label: string }) {
  return (
    <span className="team-progress">
      <span>
        <b>{name}</b>
        <small className="numeric">{label}</small>
      </span>
      <i>
        <span style={{ width: `${value}%` }} />
      </i>
    </span>
  )
}

type StoreCtx = ReturnType<typeof useStore>["ctx"]

function overdueTasks(ctx: StoreCtx, change: Change) {
  const tasks = boardTasks(ctx, change)
  const done = new Set(change.decision?.done ?? [])
  return tasks.filter((t) => taskStatus(t, tasks, done, ctx.series.today) === "기한 넘김")
}


function AfterDecisionRow({ item, open }: { item: Change; open: (code: string) => void }) {
  const { state, ctx } = useStore()
  const tasks = boardTasks(ctx, item)
  const done = new Set(item.decision?.done ?? [])
  const teams = ROLES.map((team) => {
    const list = tasks.filter((t) => TEAM_INFO[t.team].role === team)
    return { team, total: list.length, complete: list.filter((t) => done.has(t.id)).length }
  }).filter((t) => t.total > 0)
  const overdue = overdueTasks(ctx, item)
  const d = item.decision!
  return (
    <tr onClick={() => open(item.code)}>
      <td>
        <strong className="row-title">
          <span className="numeric">{item.code}</span> · {item.title}
        </strong>
        <span className="row-meta numeric">
          {item.ecr} <Source>PLM</Source>
        </span>
      </td>
      <td>
        <strong className="numeric">{formatShort(d.decidedOn)}</strong>
        <span className="row-meta">결정 완료</span>
      </td>
      <td>
        <span className="baseline-badge">{d.baseline}</span>
        <span className="row-meta">{d.baseline === state.series.baseline ? "현재 기준" : "이전 기준"}</span>
      </td>
      <td>
        <span className="team-progress-grid">
          {teams.map((t) => (
            <TeamProgress
              key={t.team}
              name={t.team}
              value={t.total ? Math.round((t.complete / t.total) * 100) : 0}
              label={`${t.complete}/${t.total}`}
            />
          ))}
        </span>
      </td>
      <td>
        {overdue.length ? (
          <>
            <span className="overdue-count numeric">{overdue.length}건</span>
            <span className="row-meta">{formatShort(overdue[0].end)} 기한</span>
          </>
        ) : (
          <span className="status-pill neutral">0건</span>
        )}
      </td>
    </tr>
  )
}

function AfterDecisionTable({ rows, open }: { rows: Change[]; open: (code: string) => void }) {
  const { ctx } = useStore()
  const notes = rows.flatMap((change) => overdueTasks(ctx, change).map((task) => ({ change, task })))
  return (
    <div className="change-table-wrap">
      <table className="change-table after-table">
        <colgroup>
          <col style={{ width: "25%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "43%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>변경</th>
            <th>결정일</th>
            <th>기준선</th>
            <th>부서별 진행</th>
            <th>기한 넘김</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <AfterDecisionRow key={item.code} item={item} open={open} />
          ))}
        </tbody>
      </table>
      {notes.map(({ change, task }) => (
        <div className="overdue-note" key={`${change.code}-${task.id}`}>
          <span className={`dept-pill ${task.team}`}>{TEAM_INFO[task.team].label}</span>
          <span>
            {change.code} · {task.vessel ? `${task.vessel} ` : ""}
            {task.name}
          </span>
          <DateWithDday date={task.end} />
          <Source>PLM</Source>
        </div>
      ))}
    </div>
  )
}

function ChangesPage({ openNew, openDetail }: { openNew: () => void; openDetail: (code: string) => void }) {
  const { state, ctx, updates, applyUpdates, checkInbox, checkedAt, checking, dismissDeadlineAlerts } = useStore()
  const [toast, setToast] = useState<{ title: string; text: string } | null>(null)
  const [showUpdates, setShowUpdates] = useState(false)
  const [tab, setTab] = useState<"before" | "after">("before")
  const [search, setSearch] = useState("")
  const [scope, setScope] = useState("")
  const [block, setBlock] = useState("")
  const [urgent, setUrgent] = useState(false)
  const changes = state.changes
  const beforeChanges = changes.filter((item) => item.status === "review" || item.status === "notified")
  const decided = changes
    .filter((item) => item.status === "decided")
    .sort(
      (a, b) =>
        overdueTasks(ctx, b).length - overdueTasks(ctx, a).length || b.decision!.decidedOn.localeCompare(a.decision!.decidedOn),
    )
  const withdrawn = changes.filter((item) => item.status === "withdrawn")
  const filtered = beforeChanges.filter((item) => {
    const matchesSearch = !search || `${item.code} ${item.title}`.toLowerCase().includes(search.toLowerCase())
    const matchesScope = !scope || scopeOf(item).includes(scope)
    const matchesBlock = !block || item.block === block
    const deadline = item.boundary === "production" ? meetingDeadline(ctx, item, draftOptions(state.drafts[item.code])).date : null
    const matchesUrgent = !urgent || (deadline !== null && daysBetween(ctx.series.today, deadline) <= 7)
    return matchesSearch && matchesScope && matchesBlock && matchesUrgent
  })
  const meetingCount = beforeChanges.filter((item) => item.boundary === "production").length
  const overdueTotal = decided.reduce((sum, item) => sum + overdueTasks(ctx, item).length, 0)
  const reset = () => {
    setSearch("")
    setScope("")
    setBlock("")
    setUrgent(false)
  }
  // 새 소식 한 번에 반영 (새 변경 요청 등록 + ERP · MES 갱신 반영)
  const refresh = () => {
    const u = applyUpdates()
    setShowUpdates(false)
    setTab("before")
    if (!u) return
    const done = [u.plm.length ? `새 설계변경 ${u.plm.length}건 등록` : "", u.sync.length ? `ERP · MES 갱신 ${u.sync.length}건 반영` : ""].filter(Boolean)
    setToast({
      title: `갱신했어요 · ${done.join(", ")}`,
      text: [
        u.plm.length ? `${u.plm.map((x) => x.change.code).join(", ")}을(를) 목록에 올렸어요.` : "",
        u.sync.length ? (u.shifts.length ? `결정 마감이 바뀐 변경 ${u.shifts.length}건을 목록 위에 표시했어요.` : "결정 마감이 바뀐 변경은 없어요.") : "",
      ]
        .filter(Boolean)
        .join(" "),
    })
  }
  const kinds = [
    ["PLM", updates.plm.length],
    ["ERP", updates.sync.filter((x) => x.event.source === "ERP").length],
    ["MES", updates.sync.filter((x) => x.event.source === "MES").length],
  ]
    .filter(([, n]) => n)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ")
  return (
    <>
      <div className="page-title changes-title">
        <div>
          <h1>설계변경</h1>
          <p>결정 필요 변경 · 실행 현황</p>
        </div>
      </div>
      <div className="change-tabs-row">
        <div className="change-tabs" role="tablist">
          <button role="tab" className={tab === "before" ? "active" : ""} onClick={() => setTab("before")}>
            결정 전 · 시뮬레이션
            <span className="tab-count numeric">{meetingCount}</span>
          </button>
          <button role="tab" className={tab === "after" ? "active" : ""} onClick={() => setTab("after")}>
            결정 후 · 실행 점검
            <span className={`tab-count numeric ${overdueTotal ? "danger" : ""}`}>{overdueTotal}</span>
          </button>
        </div>
        <button className="secondary-button" onClick={openNew}>
          변경 등록
        </button>
      </div>
      <section className="card changes-card">
        <div className="changes-tools">
          {updates.count > 0 ? (
            <div className="updates-bar">
              <span className="update-dot" aria-hidden="true" />
              <strong>새 소식 {updates.count}건</strong>
              <span className="update-kinds">{kinds}</span>
              <button className="ghost-button" onClick={() => setShowUpdates(!showUpdates)}>
                {showUpdates ? "접기" : "자세히"}
              </button>
              <button className="update-apply" onClick={refresh}>
                갱신하기
              </button>
            </div>
          ) : (
            <div className="updates-bar quiet">
              <span className="update-ok" aria-hidden="true">
                ✓
              </span>
              최신 상태
              {checkedAt && <span className="numeric">· {new Date(checkedAt).toTimeString().slice(0, 5)} 확인</span>}
              <button className="ghost-button" onClick={checkInbox} disabled={checking}>
                {checking ? "확인 중…" : "다시 확인"}
              </button>
            </div>
          )}
          <span>PLM · ERP · MES 15초마다 자동 확인</span>
        </div>
        {showUpdates && updates.count > 0 && (
          <section className="updates-preview" aria-label="새 소식">
            {updates.plm.map(({ change, source }) => (
              <span key={change.code}>
                <i className="src-pill">PLM</i>
                <b className="numeric">{change.code}</b> {change.title} · {change.boundary === "design" ? "설계 안에서 끝남 (알림만)" : "회의 대상 (생산·구매까지)"}
                <small>{source === "inbox" ? "연동 수신함" : "시연 데이터"}</small>
              </span>
            ))}
            {updates.sync.map(({ event, source }) => (
              <span key={event.id}>
                <i className="src-pill">{event.source}</i>
                {event.title}
                <small>{source === "inbox" ? "연동 수신함" : "시연 데이터"}</small>
              </span>
            ))}
            {updates.sync.length > 0 && (
              <div className="preview-impact">
                <strong>갱신하면 바뀌는 결정 마감</strong>
                {updates.shifts.length ? (
                  updates.shifts.map((x) => (
                    <span key={x.code}>
                      <b className="numeric">{x.code}</b> {formatShort(x.from)} → {formatShort(x.to)} ({ddayText(ctx.series.today, x.to)}) · {x.toTeams} 기준
                      {x.toMethod && ` · 추천 ${x.fromMethod} → ${x.toMethod}`}
                    </span>
                  ))
                ) : (
                  <span>없음</span>
                )}
              </div>
            )}
          </section>
        )}
        {tab === "before" ? (
          <>
            {state.deadlineAlerts.length > 0 && (
              <section className="deadline-alert" role="alert">
                <div>
                  <strong>결정 마감일이 바뀌었어요</strong>
                  <button onClick={dismissDeadlineAlerts}>확인</button>
                </div>
                {state.deadlineAlerts.map((alert) => (
                  <button key={`${alert.code}-${alert.to}`} onClick={() => openDetail(alert.code)}>
                    <span>
                      <b className="numeric">{alert.code}</b> {alert.title} · 결정 마감 <s className="numeric">{formatShort(alert.from)}</s> →{" "}
                      <strong className="numeric">
                        {formatShort(alert.to)} ({ddayText(ctx.series.today, alert.to)})
                      </strong>{" "}
                      · {alert.toTeams} 기준{alert.toMethod && ` · 추천 ${alert.fromMethod} → ${alert.toMethod}`}
                    </span>
                    <small>{alert.reasons.join(" · ")}</small>
                  </button>
                ))}
              </section>
            )}
            <ChangeFilters
              search={search}
              setSearch={setSearch}
              scope={scope}
              setScope={setScope}
              block={block}
              setBlock={setBlock}
              urgent={urgent}
              setUrgent={setUrgent}
              count={filtered.length}
              total={beforeChanges.length}
              reset={reset}
            />
            <BeforeDecisionTable rows={filtered} withdrawn={withdrawn} open={openDetail} />
          </>
        ) : (
          <AfterDecisionTable rows={decided} open={openDetail} />
        )}
      </section>
      {toast && (
        <div className="toast" role="status">
          <span className="toast-mark">갱신</span>
          <span>
            <strong>{toast.title}</strong>
            <span>{toast.text}</span>
          </span>
          <button onClick={() => setToast(null)} aria-label="알림 닫기">
            ×
          </button>
        </div>
      )}
    </>
  )
}

type ChangeFormValues = {
  ecr: string
  title: string
  reason: string
  requester: string
  member: string
  block: string
  v1: string
  v2: string
  material: string
  leadTime: string
}

const emptyForm: ChangeFormValues = {
  ecr: "",
  title: "",
  reason: "선주 요청",
  requester: "",
  member: "",
  block: BLOCK_CODES[0] ?? "",
  v1: "",
  v2: "",
  material: "",
  leadTime: "",
}

function ChangeRegistration({
  cancel,
  register,
}: {
  cancel: () => void
  register: (values: ChangeFormValues) => void
}) {
  const [values, setValues] = useState(emptyForm)
  const update = (key: keyof ChangeFormValues, value: string) =>
    setValues((current) => ({ ...current, [key]: value }))
  const loadPlm = () => setValues({ ...emptyForm, ...project.sampleRequest })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    register(values)
  }
  return (
    <>
      <div className="page-title">
        <div>
          <button className="back-link" onClick={cancel}>
            ← 설계변경 목록
          </button>
          <h1>변경 등록</h1>
          <p>검토할 설계변경의 기준 정보를 입력해요.</p>
        </div>
      </div>
      <form className="change-form card" onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-head">
            <span className="form-step">01</span>
            <div>
              <h2>요청 정보</h2>
              <p>PLM 변경 번호를 불러오거나 직접 입력해요.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>변경 번호(ECR)</span>
              <span className="input-with-button">
                <input
                  required
                  value={values.ecr}
                  onChange={(event) => update("ecr", event.target.value)}
                  placeholder="ECR-2026-0000"
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadPlm}
                >
                  PLM에서 불러오기
                </button>
              </span>
            </label>
            <label className="field span-2">
              <span>제목</span>
              <input
                required
                value={values.title}
                onChange={(event) => update("title", event.target.value)}
                placeholder="변경 내용을 짧게 입력해 주세요"
              />
            </label>
            <label className="field">
              <span>사유</span>
              <select
                value={values.reason}
                onChange={(event) => update("reason", event.target.value)}
              >
                <option>선주 요청</option>
                <option>선급·규정</option>
                <option>내부 오류</option>
                <option>개선</option>
              </select>
            </label>
            <label className="field">
              <span>요청 부서</span>
              <input
                required
                value={values.requester}
                onChange={(event) => update("requester", event.target.value)}
                placeholder="예: 선체설계팀"
              />
            </label>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-head">
            <span className="form-step">02</span>
            <div>
              <h2>형상 변경</h2>
              <p>변경되는 블록과 부재를 지정해요.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>블록</span>
              <select
                value={values.block}
                onChange={(event) => update("block", event.target.value)}
              >
                {BLOCK_CODES.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>부재</span>
              <input
                required
                value={values.member}
                onChange={(event) => update("member", event.target.value)}
                placeholder="부재 코드와 이름"
              />
            </label>
            <label className="field">
              <span>v1</span>
              <textarea
                required
                value={values.v1}
                onChange={(event) => update("v1", event.target.value)}
                placeholder="변경 전 형상"
              />
            </label>
            <label className="field">
              <span>v2</span>
              <textarea
                required
                value={values.v2}
                onChange={(event) => update("v2", event.target.value)}
                placeholder="변경 후 형상"
              />
            </label>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-head">
            <span className="form-step">03</span>
            <div>
              <h2>자재·조달</h2>
              <p>바뀌는 자재와 확보 기간을 입력해요.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>바뀌는 자재</span>
              <input
                required
                value={values.material}
                onChange={(event) => update("material", event.target.value)}
                placeholder="품명 · 규격 · 재고"
              />
            </label>
            <label className="field">
              <span>조달 기간</span>
              <input
                required
                value={values.leadTime}
                onChange={(event) => update("leadTime", event.target.value)}
                placeholder="예: 6일"
              />
            </label>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={cancel}>
            취소
          </button>
          <button type="submit" className="primary-button">
            변경 등록
          </button>
        </div>
      </form>
    </>
  )
}

function EmptyPage({ type }: { type: "changes" | "cases" }) {
  const isChanges = type === "changes"
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{isChanges ? "설계변경" : "사례"}</h1>
        </div>
      </div>
      <section className="empty-page card">
        <div className="empty-mark">{isChanges ? "DC" : "CS"}</div>
        <strong>{isChanges ? "설계변경 검토 목록" : "설계변경 사례"}</strong>
      </section>
    </>
  )
}

// 등록 폼 값을 설계변경 데이터로 바꾼다. 자재 칸의 "재고 n척분"은 재고로 읽는다
function formToChange(values: ChangeFormValues, code: string, today: string): Change {
  const stock = Number(values.material.match(/재고\s*(\d+)\s*척분/)?.[1] ?? 0)
  const item = values.material.split("·")[0].trim()
  const leadTime = Number(values.leadTime.replace(/[^0-9]/g, "")) || 0
  return {
    code,
    ecr: values.ecr || undefined,
    title: values.title,
    reason: values.reason as Reason,
    requester: values.requester || "설계팀",
    receivedOn: today,
    auto: false,
    isNew: true,
    status: "review",
    boundary: "production",
    block: values.block,
    member: values.member || undefined,
    v1: values.v1 || undefined,
    v2: values.v2 || undefined,
    drawing: { no: `DWG-${values.block}-NEW`, from: "Rev.A", to: "Rev.B", note: "개정" },
    bom: item ? [{ op: "+", item, qty: "-" }] : [],
    material: item ? { item, code: "ERP-NEW", stock, leadTime } : undefined,
  }
}

// ── 화면 이동 = 브라우저 기록 (뒤로 · 앞으로 가기)
//   화면마다 주소: ?view=schedule · ship&ship= · changes · change-new · meeting&change=(&step=) · cases · case&case= · ontology, 프로젝트 선택은 view 없음
//   화면을 옮기면 pushState(이전 화면의 스크롤 위치는 그 기록에 저장), 뒤로 가기(popstate)면 주소대로 화면을 되돌리고 스크롤도 되돌린다
//   회의 단계(step) · 우선순위(priority)는 MeetingView가 같은 기록 안에서 replaceState로 고친다
const VIEW_PARAM: Record<View, string | null> = { entry: null, schedule: "schedule", ship: "ship", changes: "changes", "change-new": "change-new", "change-detail": "meeting", cases: "cases", "case-detail": "case", ontology: "ontology" }
const NAV_KEYS = ["view", "change", "ship", "case", "step", "priority"]
type Nav = { view: View; change: string | null; ship: string | null; caseCode: string | null }
function readNav(): Nav {
  const p = new URLSearchParams(window.location.search)
  const v = p.get("view")
  const view = (Object.keys(VIEW_PARAM) as View[]).find((k) => VIEW_PARAM[k] === v) ?? "entry"
  return { view, change: p.get("change"), ship: p.get("ship"), caseCode: p.get("case") }
}
function navUrl(view: View, change: string, ship: string, caseCode: string) {
  const p = new URLSearchParams(window.location.search)
  // 회의 화면에 머무르는 동안만 단계 · 우선순위를 남긴다 (MeetingView가 고친 값)
  const keepMeeting = view === "change-detail" && p.get("view") === "meeting" && p.get("change") === change
  for (const k of NAV_KEYS) if (!(keepMeeting && (k === "step" || k === "priority"))) p.delete(k)
  const v = VIEW_PARAM[view]
  if (v) p.set("view", v)
  if (view === "change-detail") p.set("change", change)
  if (view === "ship") p.set("ship", ship)
  if (view === "case-detail") p.set("case", caseCode)
  const q = p.toString()
  return `${window.location.pathname}${q ? `?${q}` : ""}`
}

function Shell() {
  const { state, ctx, register, nextCode } = useStore()
  const auth = useAuth()
  // 주소로 바로 열 수 있다 (?view=ontology 발표 · 확인용, ?view=meeting&change= 회의 화면 등)
  const [view, setView] = useState<View>(() => readNav().view)
  const [selectedShip, setSelectedShip] = useState(() => readNav().ship ?? seriesData.vessels[0]?.id ?? "")
  const [selectedChange, setSelectedChange] = useState(() => readNav().change ?? "DC-021")
  const [selectedCase, setSelectedCase] = useState(() => readNav().caseCode ?? caseData[0]?.code ?? "")
  const popped = useRef<{ y: number } | null>(null) // 뒤로 · 앞으로 가기로 바뀐 화면이면 되돌릴 스크롤 위치
  const replaceNext = useRef(false) // 다음 화면 이동은 기록을 쌓지 않고 바꾼다 (등록 화면 → 등록한 변경: 뒤로 가면 목록)
  const first = useRef(true)
  useEffect(() => {
    window.history.scrollRestoration = "manual" // 스크롤은 아래에서 직접 맞춘다
    const onPop = (e: PopStateEvent) => {
      const n = readNav()
      popped.current = { y: Number((e.state as { y?: number } | null)?.y) || 0 }
      setView(n.view)
      if (n.change) setSelectedChange(n.change)
      if (n.ship) setSelectedShip(n.ship)
      if (n.caseCode) setSelectedCase(n.caseCode)
      // 화면이 그대로면(같은 화면 기록) 아래 효과가 돌지 않으니 여기서 바로 맞춘다
      setTimeout(() => {
        if (popped.current) {
          window.scrollTo(0, popped.current.y)
          popped.current = null
        }
      }, 0)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  // 화면이 바뀌면: 사용자가 옮긴 것이면 기록을 하나 쌓고 맨 위로, 뒤로 가기면 저장된 위치로
  //   useLayoutEffect: 자식(MeetingView)의 단계 기록(useEffect)보다 먼저 새 기록을 만들어 둔다
  useLayoutEffect(() => {
    const url = navUrl(view, selectedChange, selectedShip, selectedCase)
    const here = `${window.location.pathname}${window.location.search}`
    if (first.current) {
      first.current = false
      if (url !== here) window.history.replaceState(window.history.state, "", url)
      return
    }
    if (popped.current) {
      if (url !== here) window.history.replaceState(window.history.state, "", url)
      const y = popped.current.y
      popped.current = null
      requestAnimationFrame(() => window.scrollTo(0, y))
      return
    }
    if (url !== here && replaceNext.current) window.history.replaceState({ y: 0 }, "", url)
    else if (url !== here) {
      window.history.replaceState({ ...(window.history.state ?? {}), y: window.scrollY }, "", here) // 떠나는 화면의 위치
      window.history.pushState({ y: 0 }, "", url)
    }
    replaceNext.current = false
    window.scrollTo(0, 0)
  }, [view, selectedShip, selectedChange, selectedCase])
  // 사이드바 '결정 대기' 숫자: 새 엔진 값 (화면을 옮길 때마다 다시 받아 회의에서 결정하면 줄어든다)
  const meetingCount = useOpenCount(DATASET, view) ?? 0
  // 지금 메뉴를 다시 눌러도 맨 위로
  const goMenu = (next: View) => {
    setView(next)
    window.scrollTo(0, 0)
  }
  const openChange = (code: string) => {
    setSelectedChange(code)
    setView("change-detail")
  }
  const openCase = (code: string) => {
    setSelectedCase(code)
    setView("case-detail")
  }
  const registerChange = (values: ChangeFormValues) => {
    const change = formToChange(values, nextCode(), ctx.series.today)
    register(change)
    openChange(change.code)
  }
  let content: React.ReactNode = null
  // 일정 · 진척: 새 엔진 데이터 (호선 상세는 같은 화면 안에서 펼친다)
  if (view === "schedule" || view === "ship") content = <SeriesSchedule dataset={DATASET} openChange={openChange} />
  else if (view === "changes")
    content = <ChangeList dataset={DATASET} open={openChange} create={() => setView("change-new")} />
  // 직접 입력 등록 (새 엔진 · 저장 기록). 등록하면 그 변경의 회의 화면(1단계)으로
  else if (view === "change-new")
    content = (
      <ChangeForm
        dataset={DATASET}
        cancel={() => setView("changes")}
        created={(code) => {
          replaceNext.current = true
          openChange(code)
        }}
      />
    )
  else if (view === "change-detail")
    content = <MeetingView key={selectedChange} dataset={DATASET} change={selectedChange} back={() => setView("changes")} />
  else if (view === "cases")
    content = <CasesView dataset={DATASET} />
  else if (view === "case-detail") content = <CaseDetail code={selectedCase} back={() => setView("cases")} openChange={openChange} />
  else if (view === "ontology")
    content = (
      <Suspense fallback={<div className="card onto-loading-fallback" />}>
        <OntologyPage dataset={DATASET} />
      </Suspense>
    )

  // 로그인 전에는 로그인 화면 (발표용 온톨로지 화면 ?view=ontology 는 읽기 전용이라 로그인 없이 연다)
  if (auth.loading) return null
  if (!auth.user && view !== "ontology") return <LoginPage />
  if (view === "entry") return <Entry enter={() => setView("changes")} />

  return (
    <div className="app-shell">
      <Header onLogo={() => setView("entry")} />
      <Sidebar view={view} setView={goMenu} meetingCount={meetingCount} />
      <main className="main-content">{content}</main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </AuthProvider>
  )
}
