import { NextResponse } from 'next/server';
import { requestSchema, generateDemo, boardSchema } from '@/lib/storyboard';
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 150000) return NextResponse.json({error:'요청이 너무 큽니다. 원고 길이를 확인해 주세요.'},{status:413});
    const input = requestSchema.safeParse(JSON.parse(raw));
    if (!input.success) return NextResponse.json({error:'원고는 공백 제외 100자 이상, 전체 20,000자 이하로 입력하고 생성 조건을 확인해 주세요.'},{status:400});
    const {manuscript,settings,scene,direction} = input.data;
    await new Promise(resolve=>setTimeout(resolve,1200));
    const board = boardSchema.parse(generateDemo(manuscript,settings,scene,direction));
    return NextResponse.json(board, { headers: {'Cache-Control':'no-store'} });
  } catch { return NextResponse.json({error:'초안을 구성하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.'},{status:500}); }
}
