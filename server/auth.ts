// 로그인 (기능명세 1장: 실제 운영은 사내 SSO, 시연에서는 직원을 골라서 들어간다)
//   계정 = 시연 시나리오(DC-021 · DC-019)에 나오는 직원 ID 목록. 이름 · 부서 · 직함은 DB의 employee 표에서 읽는다
//   (데이터셋 6개가 같은 조직이라 어느 데이터셋에서 읽어도 같다)
//   세션 = 탭마다 따로: 로그인하면 임의 토큰을 KV에 12시간 저장하고, 화면은 sessionStorage에 두고 Authorization: Bearer로 보낸다
//   → 한 브라우저에서 주관자 탭과 생산 반장 탭을 나란히 띄울 수 있다. 서명 비밀값(환경변수)이 필요 없다
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { loadTables } from "./engine/index.js"
import type { Row } from "./engine/basics.js"
import { kvDel, kvGet, kvSetEx, storageKind } from "./kv.js"

// 엔진으로 뽑은 DC-021 · DC-019 참여자 (주관자 · 모든 안의 할 일 담당 · 결재자) + 위임 장면용 박서준(E003). 11/5
export const DEMO_ACCOUNTS = ["E002", "E003", "E010", "E031", "E041", "E051", "E071", "E072", "E091", "E100", "E110", "E120", "E131"]
const ACCOUNT_DATASET = "lng10"
const SESSION_TTL = 12 * 60 * 60
const keyOf = (token: string) => `basis:session:${token}`

export type Account = { employeeId: string; name: string; department: string; title: string; role: string; roleLabel: string; isHead: boolean }

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// 배포된 사이트에서는 기록을 쓸 때 로그인이 필요하다 (로컬 · 테스트는 요청의 actor도 받는다)
export const sessionRequired = () => !!process.env.VERCEL || process.env.BASIS_REQUIRE_SESSION === "1"

export async function accounts(): Promise<Account[]> {
  const t = await loadTables(ACCOUNT_DATASET)
  const dept = new Map((t.department ?? []).map((d: Row) => [d.department_code, d]))
  const roleLabel = new Map((t.code ?? []).filter((c: Row) => c.code_type === "role").map((c: Row) => [c.code, c.label_ko]))
  const employees = new Map((t.employee ?? []).map((e: Row) => [e.employee_id, e]))
  return DEMO_ACCOUNTS.map((id) => employees.get(id))
    .filter((e): e is Row => !!e && !!e.active)
    .map((e) => ({
      employeeId: e.employee_id,
      name: e.name,
      department: dept.get(e.department_code)?.name_ko ?? e.department_code,
      title: e.title ?? "",
      role: e.role_code,
      roleLabel: roleLabel.get(e.role_code) ?? e.role_code,
      isHead: !!e.is_department_head,
    }))
}

const tokenOf = (request: Request) => {
  const h = request.headers.get("authorization") ?? ""
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h.trim())
  return m ? m[1] : null
}

// 시연 계정 비밀번호 (13명 공통). 원문은 저장소에 두지 않고 scrypt 해시만 둔다 (솔트:해시)
const DEMO_PASSWORD_HASH = "7cf56bf2a6ad5a764a655c3c51c4ea27:f376aa2b1d6d7b1203a8ce7476d3a290486fc85baf27cd677dd9e5f2753836ec"
// 테스트는 BASIS_DEMO_PASSWORD_HASH로 임시 비밀번호의 해시를 넣는다 (실제 비밀번호 원문을 저장소에 두지 않으려고)
function passwordOk(password: string) {
  const [salt, hash] = (process.env.BASIS_DEMO_PASSWORD_HASH ?? DEMO_PASSWORD_HASH).split(":")
  const got = scryptSync(password, salt, 32)
  return timingSafeEqual(got, Buffer.from(hash, "hex"))
}

async function startSession(user: Account) {
  if (storageKind() === "none") throw new AuthError("서버 저장소(KV)가 연결되지 않아 로그인할 수 없어요", 503)
  const token = randomBytes(24).toString("base64url")
  await kvSetEx(keyOf(token), JSON.stringify({ employeeId: user.employeeId, at: new Date().toISOString() }), SESSION_TTL)
  return { token, user }
}

// 사번 + 비밀번호 로그인 (로그인 화면의 기본 방법)
export async function loginWithPassword(loginId: unknown, password: unknown): Promise<{ token: string; user: Account }> {
  if (typeof loginId !== "string" || !loginId.trim() || typeof password !== "string" || !password) throw new AuthError("아이디 · 비밀번호 미입력", 400)
  const id = loginId.trim().toUpperCase()
  const user = /^[A-Z0-9_-]{1,40}$/.test(id) ? (await accounts()).find((a) => a.employeeId === id) : undefined
  // 사번이 없는지 비밀번호가 틀렸는지는 알려 주지 않는다
  if (!user || password.length > 200 || !passwordOk(password)) throw new AuthError("아이디 또는 비밀번호 불일치", 401)
  return startSession(user)
}

// 시연 계정 바로 들어가기 (로그인 화면의 접힌 목록 · ?as=사번)
export async function login(employeeId: unknown): Promise<{ token: string; user: Account }> {
  if (typeof employeeId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(employeeId)) throw new AuthError("employeeId(직원 ID)가 필요해요", 400)
  const user = (await accounts()).find((a) => a.employeeId === employeeId)
  if (!user) throw new AuthError(`시연 계정이 아니에요: ${employeeId}`, 404)
  return startSession(user)
}

// 요청의 토큰 → 로그인한 직원 (없거나 만료면 null)
export async function sessionUser(request: Request): Promise<Account | null> {
  const token = tokenOf(request)
  if (!token || storageKind() === "none") return null
  const raw = await kvGet(keyOf(token))
  if (!raw) return null
  const { employeeId } = JSON.parse(raw) as { employeeId: string }
  return (await accounts()).find((a) => a.employeeId === employeeId) ?? null
}

export async function logout(request: Request) {
  const token = tokenOf(request)
  if (token && storageKind() !== "none") await kvDel(keyOf(token))
}
