import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo, defaults, sample, boardSchema, requestSchema, markdown } from './storyboard';

test('five manuscripts retain source evidence and exact target duration',()=>{
  const inputs=[sample,'정보 보안의 시작\n\n'+('업무 자료는 승인된 장소에 보관합니다. 비밀번호를 다른 사람과 공유하지 않습니다. 낯선 링크를 열기 전에 발신자를 확인합니다. ').repeat(5),'식물의 성장\n\n'+('식물은 빛과 물을 이용해 자랍니다. 관찰한 내용을 매일 기록합니다. 잎의 색과 크기를 비교합니다. ').repeat(5),'회의 준비\n\n'+('회의의 목적을 먼저 정합니다. 참여자에게 안건을 전달합니다. 회의가 끝나면 결정된 내용을 기록합니다. ').repeat(5),'읽기 습관\n\n'+('관심 있는 책을 고릅니다. 읽은 내용을 자기 말로 정리합니다. 이해하기 어려운 부분은 다시 읽습니다. ').repeat(5)];
  for(const manuscript of inputs){for(const count of [3,6,20] as const){const b=generateDemo(manuscript,{...defaults,count});assert.ok(boardSchema.safeParse(b).success);assert.equal(b.scenes.length,count);assert.equal(b.scenes.reduce((n,s)=>n+s.duration,0),180);for(const s of b.scenes){assert.ok(s.evidence.length>0);assert.ok(manuscript.replace(/\s/g,'').includes(s.evidence.replace(/\s/g,'')));assert.ok(s.review);}}}
});
test('request rejects short/long manuscripts and invalid settings',()=>{
  assert.equal(requestSchema.safeParse({manuscript:'짧은 원고',settings:defaults}).success,false);
  assert.equal(requestSchema.safeParse({manuscript:'가'.repeat(20001),settings:defaults}).success,false);
  assert.equal(requestSchema.safeParse({manuscript:sample,settings:{...defaults,count:2}}).success,false);
  assert.equal(requestSchema.safeParse({manuscript:sample,settings:{...defaults,keywords:Array(11).fill('키워드')}}).success,false);
  assert.ok(requestSchema.safeParse({manuscript:sample,settings:defaults}).success);
});
test('regeneration retains selected source and reflects instructions without changing input board',()=>{
  const b=generateDemo(sample,defaults);const snapshot=JSON.stringify(b);const original=b.scenes[2];const replacement=generateDemo(sample,defaults,original,'핵심어를 크게 표시').scenes[0];
  assert.equal(replacement.id,original.id);assert.equal(replacement.evidence,original.evidence);assert.equal(replacement.duration,original.duration);assert.ok(replacement.visual.includes('핵심어를 크게 표시'));assert.equal(JSON.stringify(b),snapshot);
});
test('Markdown export includes latest edits, scene order, settings and required fields',()=>{
  const b=generateDemo(sample,defaults);b.title='=HYPERLINK("test")';b.scenes.reverse();b.scenes[0].narration='편집한 "나레이션",\n두 번째 줄';b.scenes[0].edited=['narration'];
  const md=markdown(b);assert.ok(md.includes(b.scenes[0].narration));assert.ok(md.indexOf(b.scenes[0].title)<md.indexOf(b.scenes[1].title));assert.ok(md.includes('생성 조건'));assert.ok(md.includes('근거 위치'));assert.ok(md.includes('수정한 필드'));
});
