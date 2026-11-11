// Vercel 함수: 로그인 (설명은 server/auth.ts)
//   GET    /api/auth           → { user (토큰이 있으면), accounts (시연 계정 목록), sso: false }
//   POST   /api/auth { loginId, password } → { token, user }   사번 + 비밀번호 로그인 (기본)
//   POST   /api/auth { employeeId }        → { token, user }   시연 계정 바로 들어가기
//          화면은 token을 sessionStorage에 두고 Authorization: Bearer로 보낸다
//   DELETE /api/auth           → 로그아웃 (토큰 지움)
import { accounts, AuthError, login, loginWithPassword, logout, sessionUser } from "../server/auth.js"

export const maxDuration = 15

const fail = (error: unknown) =>
  Response.json({ error: error instanceof Error ? error.message : "로그인하지 못했어요" }, { status: error instanceof AuthError ? error.status : error instanceof SyntaxError ? 400 : 500 })

export async function GET(request: Request): Promise<Response> {
  try {
    return Response.json({ user: await sessionUser(request), accounts: await accounts(), sso: false })
  } catch (error) {
    return fail(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { employeeId?: unknown; loginId?: unknown; password?: unknown }
    return Response.json(body?.loginId != null || body?.password != null ? await loginWithPassword(body.loginId, body.password) : await login(body?.employeeId))
  } catch (error) {
    return fail(error)
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    await logout(request)
    return Response.json({ ok: true })
  } catch (error) {
    return fail(error)
  }
}
