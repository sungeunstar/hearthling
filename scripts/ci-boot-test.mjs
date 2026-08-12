// CI 부팅 검사 — 서버를 실제로 띄워 정적 화면과 API가 응답하는지 본다.
// Claude Code 기록이 없는 러너에서도 서버는 떠야 하고(경고만 출력), 모든 OS에서 같은 스크립트를 쓴다.
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 4599;
const server = spawn(process.execPath, ['server/server.js', '--port', String(PORT), '--no-open'], {
  stdio: 'inherit'
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

const deadline = Date.now() + 30000;
let ok = false, lastErr = null;
while (Date.now() < deadline) {
  try {
    const idx = await get('/');
    const jobs = await get('/api/jobs');
    const usage = await get('/api/usage?days=1');
    if (idx.status === 200 && idx.body.includes('hearthling') &&
        jobs.status === 200 && JSON.parse(jobs.body).jobs !== undefined &&
        usage.status === 200 && JSON.parse(usage.body).format !== undefined) {
      ok = true;
      break;
    }
    lastErr = new Error(`unexpected: / ${idx.status}, /api/jobs ${jobs.status}, /api/usage ${usage.status}`);
  } catch (e) { lastErr = e; }
  await new Promise(r => setTimeout(r, 500));
}

server.kill();
if (!ok) {
  console.error('boot test failed:', lastErr && lastErr.message);
  process.exit(1);
}
console.log('boot test passed: /, /api/jobs, /api/usage all OK');
