import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Node.js 24 이상을 설치한 뒤 다시 실행해 주세요. https://nodejs.org/'); process.exit(1);
}
// Keep demo data in its own browser origin, separate from a developer's port 3000.
const port = 3210;
await new Promise((resolve, reject) => {
  const test = createServer(); test.once('error', () => reject(new Error('3210 포트를 사용 중입니다. 실행 중인 데모를 종료한 뒤 다시 실행해 주세요.')));
  test.listen(port, '127.0.0.1', () => test.close(resolve));
}).catch(error => { console.error(error.message); process.exit(1); });
function npm(args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  if (result.error || result.status !== 0) { console.error('설치/준비에 실패했습니다. 인터넷 연결과 Node.js 설치를 확인해 주세요.'); process.exit(1); }
}
if (!existsSync(join(root, '.demo-prepared')) || !existsSync(join(root, 'node_modules/next/dist/bin/next')) || !existsSync(join(root, '.next/BUILD_ID'))) {
  console.log('첫 실행 준비: 필요한 구성 요소를 설치하고 있습니다. 몇 분 정도 걸릴 수 있습니다.');
  npm(['ci']); npm(['run', 'build']);
  writeFileSync(join(root, '.demo-prepared'), new Date().toISOString());
}
console.log(`데모 주소: http://127.0.0.1:${port}/\n사용 중에는 이 창을 열어 두세요. 종료: Ctrl+C`);
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', String(port)], { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
for (let attempt = 0; attempt < 30; attempt++) {
  if (child.exitCode !== null) break;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (response.ok) {
      const url = `http://127.0.0.1:${port}/`;
      if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' });
      else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      break;
    }
  } catch { /* wait for startup */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
