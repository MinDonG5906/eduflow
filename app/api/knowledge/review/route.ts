export const runtime = "nodejs";
const removed = () => Response.json({ error: "검수 기능이 제거되었습니다." }, { status: 410 });
export const POST = removed;
export const GET = removed;
