// 대시보드가 읽는 데이터. 팀원의 합성 데이터가 오면 이 폴더의 JSON만 바꾼다.
import aiCache from "./ai-cache.json" with { type: "json" }
import cases from "./cases.json" with { type: "json" }
import changes from "./changes.json" with { type: "json" }
import plmEvents from "./plm-events.json" with { type: "json" }
import portfolio from "./portfolio.json" with { type: "json" }
import project from "./project.json" with { type: "json" }
import series from "./series.json" with { type: "json" }
import syncEvents from "./sync-events.json" with { type: "json" }
import type { Analysis } from "../ai/analysis.js"
import { benchmarksOf } from "../engine/actuals.js"
import type { CaseRecord, Change, PortfolioRow, Project, Series, SyncEvent } from "./types.js"

export type * from "./types.js"

export const seriesData = series as Series
export const changeData = changes as Change[]
export const plmEventData = plmEvents as Change[]
export const syncEventData = syncEvents as SyncEvent[]
export const caseData = cases as CaseRecord[]
export const projectData = project as Project
export const portfolioData = portfolio as PortfolioRow[]
// 처리별 일수 · 승인 기간 등은 사례 실적의 중간값으로 계산한다 (진행 보드의 실제 일수는 store가 더한다)
export const benchmarkData = benchmarksOf(caseData)
// 미리 계산해 둔 AI 결과 (npm run ai:precompute 로 다시 만든다)
export const aiCacheData = aiCache as unknown as Record<string, Analysis>
