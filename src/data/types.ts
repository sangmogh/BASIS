// 합성 데이터의 형태. 팀원이 주는 JSON도 이 형태에 맞춘다(노션 "합성 데이터셋 재요청" 6장).
// 날짜는 모두 "YYYY-MM-DD" 문자열이다.

export type BlockCode = string

export type BlockSchedule = {
  start: string // 착수
  end: string // 제작 완료
  mount: string // 탑재
  partner?: string // 협력사 이름. 없으면 사내
}

export type Vessel = {
  id: string // H-101
  order: string // 1호선
  delivery: string // 지금 기준선 인도일
  previousDelivery?: string // 이전 기준선 인도일
  blocks: Record<BlockCode, BlockSchedule>
  status?: "in_service" // 이미 인도해 운항 중 (생산 일정 계산에서 뺌)
  contractDelivery?: string // 계약 납기. 인도일(계획)과의 차이가 여유. 없으면 인도일과 같다고 본다
  note?: string // 화면에 보일 한 줄 (예: 결함 보고 = 이번 설계변경의 출발점)
}

export type Series = {
  today: string // 시연 기준일
  baseline: string // 지금 기준선 버전 (v2)
  prepDays: number // 도면 배포 → 현장 반영 준비 기본 기간
  vessels: Vessel[]
}

// 처리별 일수 · 승인 기간 등. 사례 실적의 중간값
export type Benchmarks = {
  rework: number
  reworkErected: number
  hold: number
  approval: number
  procure: number
  owner: number
}

export type Metric = keyof Benchmarks

// 진행 보드에서 할 일을 완료하며 적은 실제 걸린 일수 (기능명세 2-2-i). 실적 기준값과 사례가 된다
export type Actual = {
  code: string // 설계변경
  taskId: string
  dept: string // 설계 · 구매 · 생산 · 선급 · 선주 · 계약·법무 · 품질
  task: string // 할 일 (호선 포함)
  metric?: Metric // 쌓이는 실적 기준값. 없으면 사례의 부서별 기록에만 남는다
  planned: number
  actual: number
  date: string
}

// 회의 전에 들어오는 ERP · MES 갱신 (기능명세 2-1-b). 자재 조달 기간이나 블록 일정이 바뀌면 결정 마감도 바뀐다
export type SyncEvent = {
  id: string
  source: "ERP" | "MES"
  title: string
  material?: { code: string; leadTime: number } // ERP 품목 코드의 새 조달 기간
  block?: { vessel: string; block: BlockCode } & Partial<BlockSchedule> // MES 블록 일정 변경
}

// 연동 수신함(/api/events)에 쌓인 이벤트: PLM 변경 요청 또는 ERP · MES 갱신
export type InboxEvent = { id: string; receivedAt: string } & ({ kind: "plm"; change: Change } | { kind: "sync"; event: SyncEvent })

export type Reason = "선주 요청" | "선급·규정" | "내부 오류" | "개선"

export type Material = {
  item: string
  code: string
  stock: number // 재고로 덮을 수 있는 척 수
  leadTime: number // 조달 기간(일) — A 일반 조달
  old?: { item: string; open: number } // 바뀌어 필요 없어진 기존 자재 · 미입고 척 수
  unitCost?: number // 척당 자재비 (만원, 합성)
}

// 대응안: A 일반 조달 / B 긴급 조달 / C 기존 부품 보강
export type Method = "A" | "B" | "C"
export type MethodInputs = {
  // B 긴급 조달: 조달 기간과 추가 비용(만원, 발주 한 번에 드는 긴급 비용)
  expedite?: { leadTime: number; premium: number }
  // C 기존 부품 보강: 이미 만들었거나 설치한 부품을 바꾸지 않고 보강. 승인(선주 · 선급)을 먼저 받아야 한다
  reinforce?: {
    days: number // 블록 단계 보강 일수
    daysErected: number // 탑재 뒤 선상 보강 일수
    cost: number // 척당 보강 자재 · 외주비 (만원)
    approvalDays: number // 보강안 승인에 걸리는 날
    approvals: string[] // 승인할 곳 (선주 · 선급)
    note: string
  }
}

// AI ① 변경 읽기 결과 (다섯 기준 중 넷. "언제"는 블록 일정에서 계산)
export type Features = {
  part: string
  trade: string
  types: string[]
  zone: string
}

// 과거 사례 1건 = 과거 설계변경 1건 (노션 "합성 데이터셋 재요청" 5-①)
export type CaseRecord = {
  code: string
  title: string
  member: string // 부재
  trade: string // 공종
  types: string[] // 변경 유형
  area: string // 구역
  reason: string
  timing: "생산 전" | "블록 제작 중" | "블록 완성" | "탑재 후"
  currentSeries: boolean
  vessel: string
  v1: string
  v2: string
  result: string
  maxDelay: number
  treatments: Array<{ vessel: string; handling: string; days: number; note: string }>
  execution: Array<{ dept: string; task: string; days: number }>
  participants?: Array<{ dept: string; reason: string }> // 관여한 부서 · 외부 담당과 이유
  problem: string
  lesson: string
}

export type ChangeStatus = "review" | "decided" | "notified" | "withdrawn"

export type Decision = {
  decidedOn: string
  target: string // 현장 반영 목표일
  prepDays: number
  baseline: string // 이 결정으로 만든 기준선 (v2, v3 ...)
  excluded: string[] // 회의에서 뺀 AI 제안(할 일 id)
  done: string[] // 완료한 할 일 id
  dueOverrides: Record<string, { start?: string; end: string }> // 담당자가 바꾼 예정일 (뒤 일정은 다시 계산하지 않음)
  overrides?: Record<string, number> // 회의에서 담당자가 고친 팀별 필요 기간
  summary?: string
  summarySource?: "claude" | "gemini" // AI ④가 쓴 요약 (없으면 정해진 문장 틀)
  deliveries?: Record<string, string> // 결정 직후 호선별 인도일 (결정 뒤 바뀐 날을 보여줄 때)
  benchmarks?: Benchmarks // 결정 당시 실적 기준값. 실제 일수가 쌓여도 정한 일정은 그대로 둔다
  method?: Method // 고른 대응안 (A 일반 조달 · B 긴급 조달 · C 기존 부품 보강)
  priority?: Criterion[] // 결정할 때의 선주 우선순위
}

export type Change = {
  code: string
  ecr?: string
  title: string
  reason: Reason
  requester: string
  receivedOn: string
  auto?: boolean // PLM 이벤트로 자동 등록
  isNew?: boolean
  status: ChangeStatus
  boundary: "design" | "production" // 설계 안에서 끝나는지
  block: BlockCode
  member?: string
  v1?: string
  v2?: string
  ecrText?: string // 변경 요청 원문 (AI ① 입력)
  drawing?: { no: string; from: string; to: string; note: string }
  bom?: Array<{ op: "+" | "-"; item: string; qty: string }>
  material?: Material
  options?: MethodInputs // 대응안별 입력 (없으면 A만)
  features?: Features
  readBy?: string[] // 설계 안에서 끝나는 변경의 열람 부서
  decision?: Decision
}

// 프로젝트 정보: 이름 · 블록 이름 · 호선별 진척처럼 화면이 쓰는 값. 데이터셋마다 이 파일만 바꾼다
export type Milestone = { name: string; plan: string; actual?: string }
export type VesselStatus = {
  progress: number // 종합 진척 %
  process: string // 지금 공정
  start: string // 착공
  launch: string // 진수 (계획)
  processes: number[] // Project.processes 순서의 공정별 진척 %
  blockCounts: number[] // Project.blockStates 순서의 블록 개수
  milestones: Milestone[] // 착공 · 탑재 시작 등 (진수 · 인도는 launch · delivery로 계산)
}
export type Project = {
  name: string
  type: string
  shipType: string
  phase: string
  previousSeries: string // 사례 화면의 "이전 시리즈" 설명
  blocks: Record<BlockCode, string> // 블록 코드 → 이름
  processes: string[]
  blockStates: string[]
  vessels: Record<string, VesselStatus>
  evidence: { handling: Record<string, string> } // 처리별 근거 사례 코드
  costs?: Costs // 비용 계산 단가 (합성)
  priority?: Criterion[] // 기본 선주 우선순위
  sampleRequest: Record<string, string> // 변경 등록 화면의 "PLM에서 불러오기" 예시
}
// 프로젝트 선택 화면의 다른 프로젝트 (열 수 없는 목록)
export type PortfolioRow = {
  name: string
  type: string
  shipType: string
  vessels: string
  phase: string
  progress: number
  reviews: number
  deadline?: string
}

// 비용 단가 (만원, 합성): 재작업 · 보강 하루 작업비(호선당), 인도 지연 하루 지체상금(호선당, 위험으로만 보여 줌)
export type Costs = { reworkPerDay: number; ldPerDay: number; recovery?: RecoveryMeasure[] }
// 납기 만회 수단 (합성): 호선 하나에 최대 며칠까지 줄일 수 있고, 하루에 얼마 드나 (예: 의장 잔업, 시운전 병행)
export type RecoveryMeasure = { name: string; days: number; costPerDay: number }
// 대응안을 고르는 기준: 일정(납기 초과 → 지연 합계) · 비용(직접 비용) · 생산 차질(손대는 척수 → 작업 일수)
export type Criterion = "schedule" | "cost" | "disruption"
