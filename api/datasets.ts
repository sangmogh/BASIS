// Vercel 함수: GET /api/datasets → 데이터셋마다 정보 + 변경 목록(한 줄 요약 · 결정 기한 · 추천) + 아직 반영 안 한 새 소식
// 새 데이터셋은 db/datasets/<id>.db를 넣기만 하면 목록에 나온다
//   ?id=lng10 이면 그 데이터셋만 계산한다 (설계변경 목록 화면용, 전체보다 빠름)
//   summary: 첫 화면 프로젝트 줄(호선 범위 · 건조 단계 · 평균 진척 · 결정 대기 · 가장 가까운 기한) — server/schedule.ts
//   ?schedule=1 이면 schedule(일정 · 진척 화면: 호선별 단계 · 마일스톤 · 블록 · 설계변경 영향)도 같이 준다
//   (Vercel 무료 요금제는 함수가 12개까지라 일정 화면용 함수를 따로 만들지 않고 여기에 붙였다)
import { datasetIds, datasetInfo, listChanges, loadOntology, loadTables, storageOf } from "../server/engine/index.js"
import { loadDataset } from "../server/records.js"
import { datasetSummary, hullSchedule } from "../server/schedule.js"

export const maxDuration = 30

export async function GET(request?: Request): Promise<Response> {
  try {
    const params = request ? new URL(request.url).searchParams : null
    const only = params?.get("id") ?? null
    const withSchedule = params?.get("schedule") === "1"
    const ids = only ? datasetIds().filter((id) => id === only) : datasetIds()
    if (only && !ids.length) return Response.json({ error: `데이터셋 없음: ${only}` }, { status: 404 })
    const datasets = []
    for (const id of ids) {
      // 데이터셋 하나가 계약에 안 맞아도 나머지는 보여 준다
      try {
        // 저장된 기록(결정 · 갱신하기)까지 합친 상태
        const ds = await loadDataset(id)
        const w = ds.world()
        const onto = loadOntology(id)
        const tables = await loadTables(id)
        const changes = listChanges(w, onto) // 상세 화면과 같은 대응안 규칙(온톨로지)
        datasets.push({
          ...datasetInfo(w),
          storage: storageOf(id), // 읽은 DB 파일 (배포 환경 확인용)
          records: ds.records,
          changes,
          summary: datasetSummary(w, tables, changes),
          ...(withSchedule ? { schedule: hullSchedule(w, tables, onto) } : {}),
          news: w.pendingEvents.map((e) => ({ id: e.event_id, system: e.system_name, at: e.occurred_at, note: e.note_ko })),
          error: null,
        })
      } catch (error) {
        datasets.push({ id, error: error instanceof Error ? error.message : "데이터셋을 읽지 못했어요" })
      }
    }
    return Response.json({ runtime: { node: process.version }, datasets })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "데이터셋을 읽지 못했어요" }, { status: 500 })
  }
}
