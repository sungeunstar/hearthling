#!/usr/bin/env node
// hearthling 브릿지 서버
// .claude/jobs/*/state.json 폴링 + 세션 트랜스크립트(jsonl) tail → 도구 호출 이벤트 추출 → HTTP로 노출
// 외부 의존성 없음(Node 내장 모듈만 사용)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Claude 홈: --claude-home 인자 → CLAUDE_CONFIG_DIR(Claude Code 공식 환경변수) → ~/.claude
const CLAUDE_HOME = argValue('--claude-home') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const JOBS_DIR = path.join(CLAUDE_HOME, 'jobs');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = parseInt(argValue('--port') || process.env.PORT || '4577', 10);

// ★사령관 지적(2026-08-10 "애니메이션 붙여보자")의 실제 원인: 워커가 전부 Idle이었던 건 애니메이션이
//   안 붙어서가 아니라 **일감이 없어서**였다. 이 서버는 `.claude/jobs`(백그라운드 job)만 봤는데 그 job들은
//   전부 종료 상태(failed/blocked/done)였고, 정작 사령관이 지금 대화 중인 **활성 세션은 job이 아니라서
//   목록에 아예 안 잡혔다**. 세션 트랜스크립트를 직접 라이브 워커로 잡아 실시간 도구 호출을 흘려보낸다.
const LIVE_WINDOW_MS = 20 * 60 * 1000; // 최근 20분 안에 갱신된 세션만 워커로 띄운다
const ACTIVE_MS = 25 * 1000;           // 25초 안에 갱신됐으면 '일하는 중'
const sessionMeta = new Map();         // sessionId -> { name, intent, tokens, lastTool }

// jobId -> { offset, path }  트랜스크립트 tail 커서 (서버 시작 시점부터 새 이벤트만)
const cursors = new Map();
// jobId -> 모델 ID(예: claude-opus-5[1m], gpt-5-codex). 워커 이름표에 쓴다.
const MODEL_BY_JOB = new Map();

// 트랜스크립트 꼬리에서 마지막으로 쓰인 모델을 찾는다 — 커서는 파일 끝부터 시작하므로
// 새 응답이 나오기 전까지는 모델을 모른다. 처음 볼 때 뒤 256KB만 훑어 채워둔다.
function tailModel(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 262144);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    let m = null, re = /"model":"([^"]+)"/g, hit;
    while ((hit = re.exec(text))) m = hit[1];
    return m;
  } catch (e) { return null; }
}

// 이벤트 링버퍼
const MAX_EVENTS = 1000;
let events = [];
let nextEventId = 1;

function pushEvent(ev) {
  ev.id = nextEventId++;
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
}

function readJobStates() {
  const out = [];
  let ids;
  try {
    ids = fs.readdirSync(JOBS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) {
    return out;
  }
  for (const id of ids) {
    const statePath = path.join(JOBS_DIR, id, 'state.json');
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const s = JSON.parse(raw);
      out.push({
        jobId: id,
        state: s.state || null,
        tempo: s.tempo || null,
        tokens: s.tokens || 0,
        detail: s.detail || null,
        intent: s.intent || null,
        name: s.name || null,
        updatedAt: s.updatedAt || null,
        createdAt: s.createdAt || null,
        cwd: s.cwd || null,
        sessionId: s.sessionId || null,
        fan: s.fan || [],
        linkScanPath: s.linkScanPath || null
      });
    } catch (e) {
      // state.json 없거나 파싱 실패한 job은 건너뜀
    }
  }
  return out;
}

// 트랜스크립트 맨 앞부분만 읽어 "이 세션이 무슨 일로 시작됐는지"(첫 사용자 요청)와
// 작업 폴더(cwd)를 뽑는다. 전체 파일은 수십 MB까지 커지므로 앞 64KB만 본다.
function headInfo(file) {
  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    raw = buf.slice(0, n).toString('utf8');
  } catch (e) { return { intent: null, cwd: null }; }
  let intent = null, cwd = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; } // 마지막 줄은 잘렸을 수 있다
    if (!cwd && d && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
    if (!intent) intent = userText(d);
    if (intent && cwd) break;
  }
  return { intent, cwd };
}

// 사용자 턴의 실제 발화만 뽑는다(도구 결과·시스템 리마인더 블록은 제외).
function userText(d) {
  if (!d || d.type !== 'user' || !d.message) return null;
  const c = d.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const it of c) {
      if (it && it.type === 'text' && it.text) { text = it.text; break; }
      if (it && it.type === 'tool_result') return null; // 도구 결과 턴은 발화가 아님
    }
  }
  if (!text) return null;
  text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('Caveat:')) return null;
  return text.length > 160 ? text.slice(0, 160) + '…' : text;
}

// 활성 세션(= 지금 사령관이 대화 중인 세션 포함)을 job과 같은 모양으로 반환한다.
function readLiveSessions(excludeSessionIds) {
  const out = [];
  let projDirs;
  try {
    projDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { return out; }
  const now = Date.now();
  for (const proj of projDirs) {
    const dir = path.join(PROJECTS_DIR, proj);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (e) { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      const age = now - st.mtimeMs;
      if (age > LIVE_WINDOW_MS) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      if (excludeSessionIds.has(sessionId)) continue; // 이미 job으로 잡힌 세션은 중복 표시 안 함
      let meta = sessionMeta.get(sessionId);
      if (!meta) {
        const head = headInfo(full);
        meta = { name: null, intent: head.intent, cwd: head.cwd, tokens: 0, lastTool: null };
        sessionMeta.set(sessionId, meta);
      }
      out.push({
        jobId: sessionId.slice(0, 8),
        state: age < ACTIVE_MS ? 'active' : 'idle',
        tempo: age < ACTIVE_MS ? 'working' : 'idle',
        tokens: Math.max(sessionTokens(sessionId, full), meta.tokens),
        lastTool: meta.lastTool || null, // 화면이 언어에 맞게 조립하도록 원자료도 준다
        detail: meta.lastTool ? ('마지막 도구: ' + meta.lastTool) : (age < ACTIVE_MS ? '작업 중' : '대기 중'),
        intent: meta.intent,
        name: meta.intent ? meta.intent.slice(0, 40) : (meta.cwd ? path.basename(meta.cwd) : proj),
        updatedAt: new Date(st.mtimeMs).toISOString(),
        createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
        cwd: proj,
        sessionId,
        fan: [],
        source: 'session',
        linkScanPath: full
      });
    }
  }
  return out;
}

function summarizeInput(name, input) {
  if (!input) return '';
  try {
    if (name === 'Bash') return input.command || '';
    if (name === 'Read' || name === 'Edit' || name === 'Write') return input.file_path || '';
    if (name === 'Grep' || name === 'Glob') return input.pattern || '';
    if (name === 'Agent') return input.description || '';
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch (e) {
    return '';
  }
}

// 각 job의 트랜스크립트에서 새로 추가된 tool_use 이벤트만 뽑아 이벤트 버퍼에 적재
function pollTranscripts(jobs) {
  for (const job of jobs) {
    if (!job.linkScanPath) continue;
    let cur = cursors.get(job.jobId);
    if (!cur) {
      // 처음 보는 job이면, 이미 쌓여있던 과거 기록은 건너뛰고 지금부터 새로 나는 것만 추적
      let startOffset = 0;
      try { startOffset = fs.statSync(job.linkScanPath).size; } catch (e) { startOffset = 0; }
      cur = { offset: startOffset, path: job.linkScanPath };
      cursors.set(job.jobId, cur);
      const m = tailModel(job.linkScanPath);
      if (m) MODEL_BY_JOB.set(job.jobId, m);
    }
    if (cur.path !== job.linkScanPath) {
      // 세션이 바뀐 경우(리줌 등) 커서 리셋
      cur.path = job.linkScanPath;
      cur.offset = 0;
    }
    let size;
    try { size = fs.statSync(cur.path).size; } catch (e) { continue; }
    if (size <= cur.offset) continue;

    const fd = fs.openSync(cur.path, 'r');
    const len = size - cur.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, cur.offset);
    fs.closeSync(fd);
    const chunk = buf.toString('utf8');

    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) continue; // 완전한 줄이 아직 없음 — 다음 폴링까지 대기
    const complete = chunk.slice(0, lastNl);
    cur.offset += Buffer.byteLength(complete, 'utf8') + 1; // +1 for the newline

    const lines = complete.split('\n').filter(Boolean);
    for (const line of lines) {
      let d;
      try { d = JSON.parse(line); } catch (e) { formatStats.parseFail++; continue; }
      const meta = job.sessionId ? sessionMeta.get(job.sessionId) : null;
      // 라이브 세션은 job과 달리 state.json이 없으므로, 토큰·최근 도구·최근 요청을 tail하며 직접 갱신한다.
      if (meta) {
        const ut = userText(d);
        if (ut) meta.intent = ut;
      }
      if (d.type === 'assistant' && d.message) {
        // ★사령관 지시(2026-08-11) "에이전트 이름은 각각의 모델명" — 워커 이름표에 쓸 모델을 여기서 잡는다.
        if (d.message.model) MODEL_BY_JOB.set(job.jobId, d.message.model);
        if (meta && d.message.usage) {
          const u = d.message.usage;
          meta.tokens += (u.output_tokens || 0) + (u.input_tokens || 0);
        }
        if (Array.isArray(d.message.content)) for (const item of d.message.content) {
          if (item && item.type === 'tool_use') {
            if (meta) meta.lastTool = item.name;
            pushEvent({
              jobId: job.jobId,
              ts: d.timestamp || null,
              kind: 'tool_use',
              tool: item.name,
              detail: summarizeInput(item.name, item.input)
            });
          }
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 토큰 사용량 인덱서 — ★사령관 지시(2026-08-11) "일별로 주별로 얼마나 에이전트 토큰을 썼는지 알 수 있으면 좋겠다"
// ══════════════════════════════════════════════════════════════════════════
// `~/.claude/projects/**/*.jsonl` 전체가 실측 1.8GB(363개)라 요청마다 훑을 수 없다.
// 파일별로 "어디까지 읽었는지(size)"와 "그 파일이 기여한 날짜별·모델별 합계"를 캐시해두고,
// 늘어난 꼬리만 이어서 읽는다. 캐시는 디스크에 저장해 서버를 껐다 켜도 다시 훑지 않는다.
// 첫 전체 스캔은 8MB씩 끊어 setImmediate로 넘기며 처리한다(대시보드 폴링이 멈추지 않게).
const USAGE_INDEX_PATH = path.join(__dirname, '.usage-index.json');
const USAGE_CHUNK = 8 * 1024 * 1024;
let usageIndex = { files: {} };          // path -> { size, days: { 'YYYY-MM-DD': { model: {in,out,cr,cw} } } }
let usageScan = { running: false, done: 0, total: 0, ready: false };

try {
  usageIndex = JSON.parse(fs.readFileSync(USAGE_INDEX_PATH, 'utf8'));
  if (!usageIndex.files) usageIndex = { files: {} };
  usageScan.ready = true;
} catch (e) { /* 첫 실행 — 캐시 없음 */ }

function saveUsageIndex() {
  try { fs.writeFileSync(USAGE_INDEX_PATH, JSON.stringify(usageIndex)); } catch (e) { /* 저장 실패는 무시(다음에 다시 만든다) */ }
}

// 한 줄에서 usage만 뽑는다. 수백만 줄을 전부 JSON.parse 하면 너무 느려서 `"usage"`가 든 줄만 통과시키고,
// 그 줄만 정확히 파싱한다.
// ★정규식으로만 훑었다가 **이중 계산** 버그가 났다(독립 집계와 대조해서 발견): `type:"user"` 줄의
//   `toolUseResult` 안에 하위 에이전트(Agent 툴) 실행 결과의 usage가 딸려 온다. 그 하위 에이전트는
//   `projects/<프로젝트>/<세션ID>/*.jsonl`로 **자기 기록을 따로 남기고 그것도 인덱싱**하므로, 여기서 또
//   세면 같은 토큰을 두 번 센다. 그래서 `type === 'assistant'`의 `message.usage`만 집계한다.
// 형식 건강 지표 — 트랜스크립트는 비공식 형식이라 Claude Code 업데이트로 바뀔 수 있다.
// 줄 수 대비 인식된 usage가 0이면 "형식이 바뀌었다"는 신호로 화면에 알린다(죽지 않고 알리는 것까지가 방어).
const formatStats = { lines: 0, parseFail: 0, usageHits: 0 };

function extractUsage(line) {
  formatStats.lines++;
  if (line.indexOf('"usage"') === -1) return null;
  let d;
  try { d = JSON.parse(line); } catch (e) { formatStats.parseFail++; return null; }
  if (!d || d.type !== 'assistant' || !d.message || !d.message.usage) return null;
  formatStats.usageHits++;
  const u = d.message.usage;
  return {
    ts: d.timestamp || null,
    model: d.message.model || 'unknown',
    out: u.output_tokens || 0, in: u.input_tokens || 0,
    cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0
  };
}

// 트랜스크립트 timestamp는 UTC다 — 사령관이 보는 "하루"는 로컬(KST) 기준이라 로컬 날짜로 변환한다.
function localDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function addUsage(entry, u) {
  const date = u.ts ? localDate(u.ts) : null;
  if (!date) return;
  const day = entry.days[date] || (entry.days[date] = {});
  const m = day[u.model] || (day[u.model] = { in: 0, out: 0, cr: 0, cw: 0 });
  m.in += u.in; m.out += u.out; m.cr += u.cr; m.cw += u.cw;
}

// 파일 하나를 8MB씩 끊어 읽으며 usage를 누적한다(이벤트 루프를 오래 붙잡지 않게 청크마다 양보).
function scanFile(file, entry, fromOffset, done) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { done(); return; }
  let offset = fromOffset;
  let carry = '';
  const buf = Buffer.alloc(USAGE_CHUNK);
  const step = () => {
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, USAGE_CHUNK, offset); } catch (e) { n = 0; }
    if (n <= 0) {
      try { fs.closeSync(fd); } catch (e) {}
      entry.size = offset;
      done();
      return;
    }
    offset += n;
    const chunk = carry + buf.slice(0, n).toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) { carry = chunk; setImmediate(step); return; }
    carry = chunk.slice(lastNl + 1);
    const lines = chunk.slice(0, lastNl).split('\n');
    for (const line of lines) {
      if (!line) continue;
      const u = extractUsage(line);
      if (u) addUsage(entry, u);
    }
    setImmediate(step);
  };
  step();
}

// 트랜스크립트는 `projects/<프로젝트>/<세션>.jsonl` 뿐 아니라 **`projects/<프로젝트>/<세션ID>/*.jsonl`**
// (하위 에이전트 기록)에도 있다 — 실측 130개 vs 재귀 363개. 하위 에이전트가 쓴 토큰도 내가 쓴 토큰이므로
// 재귀로 전부 훑는다(처음엔 depth 1만 봐서 233개를 통째로 빠뜨렸다).
function listTranscripts() {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(full, depth + 1); } // 실측: depth 4~5에도 18개가 더 있다
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(PROJECTS_DIR, 0);
  return out;
}

function scanUsage() {
  if (usageScan.running) return;
  // 최근에 만진 파일부터 훑는다 — 첫 전체 스캔에서도 오늘·이번 주 수치가 몇 초 안에 먼저 채워진다.
  const files = listTranscripts()
    .map(f => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .map(x => x.f);
  usageScan.running = true;
  usageScan.total = files.length;
  usageScan.done = 0;
  let i = 0;
  let sinceSave = 0;
  const next = () => {
    if (i >= files.length) {
      usageScan.running = false;
      usageScan.ready = true;
      sessionTokenCache.clear(); // 인덱스가 갱신됐으니 세션 누적치도 다시 계산되게 한다
      saveUsageIndex();
      return;
    }
    const file = files[i++];
    usageScan.done = i;
    let st;
    try { st = fs.statSync(file); } catch (e) { setImmediate(next); return; }
    let entry = usageIndex.files[file];
    if (!entry) entry = usageIndex.files[file] = { size: 0, days: {} };
    if (st.size === entry.size) { setImmediate(next); return; }       // 변화 없음
    if (st.size < entry.size) { entry.size = 0; entry.days = {}; }     // 파일이 줄었다 = 갈아엎고 다시
    scanFile(file, entry, entry.size, () => {
      // 중간 저장 — 첫 스캔 도중 서버가 꺼져도 여기까지는 다시 훑지 않는다
      if (++sinceSave >= 20) { sinceSave = 0; saveUsageIndex(); }
      setImmediate(next);
    });
  };
  next();
}

// 세션 하나가 지금까지 **생성한** 토큰 — 워커 이름표에 띄운다.
// `meta.tokens`는 **서버가 켜진 뒤 tail한 분량만** 세므로 방금 띄운 서버에선 0에 가깝다(사령관이 보기엔 무의미).
// 인덱스에는 그 세션의 전체 기록이 이미 들어 있으니 그걸 쓴다. 하위 에이전트(같은 이름의 하위 폴더) 것도 합산.
// ★출력 토큰만 센다(2026-08-11) — 캐시 재읽기까지 더하면 라벨이 억 단위로 부풀어 실제 작업량과 무관해진다.
const sessionTokenCache = new Map();
function sessionTokens(sessionId, mainFile) {
  if (sessionTokenCache.has(sessionId)) return sessionTokenCache.get(sessionId);
  let t = 0;
  const marker = path.sep + sessionId + path.sep;
  for (const f in usageIndex.files) {
    if (f !== mainFile && f.indexOf(marker) === -1) continue;
    const days = usageIndex.files[f].days;
    for (const d in days) for (const m in days[d]) t += (days[d][m].out || 0);
  }
  sessionTokenCache.set(sessionId, t);
  return t;
}

// 날짜별·주별 합계를 낸다. 주는 월요일 시작(ISO)으로 묶는다.
function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - dow);
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function usageSummary(days) {
  const byDate = {};
  for (const file in usageIndex.files) {
    const e = usageIndex.files[file];
    for (const date in e.days) {
      const dst = byDate[date] || (byDate[date] = {});
      for (const model in e.days[date]) {
        const s = e.days[date][model];
        const t = dst[model] || (dst[model] = { in: 0, out: 0, cr: 0, cw: 0 });
        t.in += s.in; t.out += s.out; t.cr += s.cr; t.cw += s.cw;
      }
    }
  }
  const dates = Object.keys(byDate).sort();
  const cut = dates.slice(-Math.max(1, days || 30));
  const dayRows = cut.map(date => ({ date, byModel: byDate[date] }));
  const weeks = {};
  for (const date of dates) {
    const wk = weekKey(date);
    const dst = weeks[wk] || (weeks[wk] = {});
    for (const model in byDate[date]) {
      const s = byDate[date][model];
      const t = dst[model] || (dst[model] = { in: 0, out: 0, cr: 0, cw: 0 });
      t.in += s.in; t.out += s.out; t.cr += s.cr; t.cw += s.cw;
    }
  }
  const weekRows = Object.keys(weeks).sort().slice(-10).map(week => ({ week, byModel: weeks[week] }));
  return { days: dayRows, weeks: weekRows };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// 요청 하나가 던진 예외로 서버 전체가 죽지 않게 한다 — 트랜스크립트 형식 변화·깨진 파일은
// 해당 응답만 500으로 끝내고 다음 폴링은 계속 돈다.
const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch (e) {
    try { sendJson(res, 500, { error: String((e && e.message) || e) }); } catch (e2) { /* 응답 이미 나감 */ }
  }
});

function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/jobs') {
    const jobs = readJobStates();
    // 백그라운드 job + 지금 살아있는 대화 세션을 함께 워커로 노출(같은 세션이 양쪽에 잡히면 job 쪽만 남긴다).
    const owned = new Set(jobs.map(j => j.sessionId).filter(Boolean));
    const live = readLiveSessions(owned);
    const all = jobs.concat(live);
    pollTranscripts(all);
    for (const j of all) j.model = MODEL_BY_JOB.get(j.jobId) || null;
    sendJson(res, 200, { jobs: all, now: new Date().toISOString() });
    return;
  }
  if (u.pathname === '/api/usage') {
    const days = parseInt(u.searchParams.get('days') || '30', 10);
    const sum = usageSummary(days);
    sendJson(res, 200, {
      ready: usageScan.ready,
      scanning: usageScan.running,
      progress: { done: usageScan.done, total: usageScan.total },
      // 충분히 훑었는데 usage를 하나도 못 알아봤다 = 트랜스크립트 형식이 바뀌었을 가능성
      format: {
        lines: formatStats.lines,
        parseFail: formatStats.parseFail,
        usageHits: formatStats.usageHits,
        warning: usageScan.ready && formatStats.lines > 5000 && formatStats.usageHits === 0
      },
      days: sum.days,
      weeks: sum.weeks
    });
    return;
  }
  if (u.pathname === '/api/events') {
    const after = parseInt(u.searchParams.get('after') || '0', 10);
    const slice = events.filter(e => e.id > after);
    sendJson(res, 200, { events: slice, latestId: nextEventId - 1 });
    return;
  }
  // 현재 장면 스크린샷 저장 — 화면이 canvas.toDataURL로 찍어 보내면 server/snapshots/에 PNG로 남긴다.
  if (u.pathname === '/api/snapshot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body);
        if (!m) { sendJson(res, 400, { error: 'data:image/png|jpeg;base64 형식이 아니다' }); return; }
        const dir = path.join(__dirname, 'snapshots');
        fs.mkdirSync(dir, { recursive: true });
        const ext = m[1] === 'jpeg' ? '.jpg' : '.png';
        const file = path.join(dir, 'snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + ext);
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        sendJson(res, 200, { saved: file });
      } catch (e) { sendJson(res, 500, { error: String((e && e.message) || e) }); }
    });
    return;
  }
  if (u.pathname === '/api/timeline') {
    const jobId = u.searchParams.get('jobId') || '';
    const safe = /^[a-zA-Z0-9_-]+$/.test(jobId) ? jobId : null;
    if (!safe) { sendJson(res, 400, { error: 'invalid jobId' }); return; }
    const tlPath = path.join(JOBS_DIR, safe, 'timeline.jsonl');
    let lines = [];
    try {
      const raw = fs.readFileSync(tlPath, 'utf8');
      lines = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { /* no timeline yet */ }
    sendJson(res, 200, { jobId: safe, timeline: lines.slice(-200) });
    return;
  }
  serveStatic(req, res, u.pathname);
}

// 브라우저 자동 열기 — --no-open 이면 열지 않는다.
function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  try { require('child_process').exec(cmd); } catch (e) { /* 못 열어도 서버는 계속 */ }
}

// 이미 떠 있는데 또 실행한 경우(더블클릭 두 번) — 새로 띄우는 대신 기존 화면만 연다.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log(`포트 ${PORT} 에서 이미 실행 중이다 — 기존 화면을 연다.`);
    openBrowser(`http://localhost:${PORT}`);
    return;
  }
  throw e;
});

// 세션 기록(작업 폴더명·프롬프트 첫 줄)이 흐르는 서버다 — 같은 네트워크의 다른 기기가 못 보게 localhost에만 연다.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`hearthling: http://localhost:${PORT}`);
  console.log(`Claude 홈: ${CLAUDE_HOME}`);
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log(`경고: ${PROJECTS_DIR} 가 없다 — Claude Code 세션 기록을 찾지 못했다.`);
    console.log(`      경로가 다르면 CLAUDE_CONFIG_DIR 환경변수 또는 --claude-home <경로> 로 지정한다.`);
  }
  // 토큰 사용량 인덱스 — 첫 실행은 전체 스캔(청크 단위, 최근 파일 우선), 이후엔 늘어난 꼬리만.
  scanUsage();
  setInterval(scanUsage, 60 * 1000);
  openBrowser(`http://localhost:${PORT}`);
});
