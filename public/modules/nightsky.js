// nightsky.js — Shadertoy "별밤 + 달빛 볼류메트릭 구름" 셰이더를 three.js로 포팅.
// 원본 멀티패스(BufferA 뷰추적 / BufferB Perlin-Worley 아틀라스 / Image 레이마칭) →
//   · BufferA 폐기: 게임 카메라 실제 방향(ctx.camera world matrix)을 직접 rayDir로 사용.
//   · BufferB: WebGLRenderTarget(FloatType, 256²)에 첫 프레임 1회 굽기(아틀라스+구름맵+달텍스처). 재사용.
//   · Image: 풀스크린 quad(OrthographicCamera+PlaneGeometry)를 0.5× 저해상도 RT에 레이마칭 → 업스케일 배경 합성.
// 셰이더 로직(별·달·구름·HG산란·ACES)은 _skytest_clouds.html에서 변경 없이 이식.
// 게임 적용 차이: origin=카메라 위치, 구름층을 머리 위(높은 y)로 올려 배 위에서 올려다보게.
//
// 출력: ctx.nightsky = { mesh(배경 quad), bake1회, setNight(0~1), render(전 프레임 자동), dispose }
//   sky.js가 night factor로 opacity 크로스페이드.
import * as THREE from 'three';

// ── Shadertoy Common ──
const COMMON = `
#define PI 3.14159265359
#define TWO_PI 6.28318530718
float saturate(float x){ return clamp(x,0.0,1.0); }
vec3  saturate3(vec3 x){ return clamp(x,0.0,1.0); }
float remap(float v,float l0,float h0,float l1,float h1){ return l1+(v-l0)*(h1-l1)/(h0-l0); }
`;

// ── BufferB 본문(아틀라스 생성) — 1회 굽기. iChannel0(뷰 메타) 의존 제거: 항상 첫 프레임 분기. ──
const BAKE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
#define PERLIN_WORLEY 0
#define WORLEY 1
vec3 modulo(vec3 m, float n){ return mod(mod(m, n) + n, n); }
vec3 fade(vec3 t){ return (t * t * t) * (t * (t * 6.0 - 15.0) + 10.0); }
#define SIZE 8.0
vec3 hash(vec3 p3){
    p3 = modulo(p3, SIZE);
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return 2.0 * fract((p3.xxy + p3.yxx) * p3.zyx) - 1.0;
}
float gradientNoise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p); vec3 u = fade(f);
    return mix( mix( mix( dot( hash(i + vec3(0.0,0.0,0.0)), f - vec3(0.0,0.0,0.0)),
              dot( hash(i + vec3(1.0,0.0,0.0)), f - vec3(1.0,0.0,0.0)), u.x),
         mix( dot( hash(i + vec3(0.0,1.0,0.0)), f - vec3(0.0,1.0,0.0)),
              dot( hash(i + vec3(1.0,1.0,0.0)), f - vec3(1.0,1.0,0.0)), u.x), u.y),
    mix( mix( dot( hash(i + vec3(0.0,0.0,1.0)), f - vec3(0.0,0.0,1.0)),
              dot( hash(i + vec3(1.0,0.0,1.0)), f - vec3(1.0,0.0,1.0)), u.x),
         mix( dot( hash(i + vec3(0.0,1.0,1.0)), f - vec3(0.0,1.0,1.0)),
              dot( hash(i + vec3(1.0,1.0,1.0)), f - vec3(1.0,1.0,1.0)), u.x), u.y), u.z );
}
float getPerlinNoise(vec3 pos, float frequency){
    float sum = 0.0; float weightSum = 0.0; float weight = 1.0;
    for(int oct = 0; oct < 3; oct++){
        vec3 p = pos * frequency;
        float val = 0.5 + 0.5 * gradientNoise(p);
        sum += val * weight; weightSum += weight;
        weight *= 0.5; frequency *= 2.0;
    }
    return saturate(sum / weightSum);
}
float worley(vec3 pos, float numCells){
    vec3 p = pos * numCells; float d = 1.0e10;
    for (int x = -1; x <= 1; x++){ for (int y = -1; y <= 1; y++){ for (int z = -1; z <= 1; z++){
        vec3 tp = floor(p) + vec3(x, y, z);
        tp = p - tp - (0.5 + 0.5 * hash(mod(tp, numCells)));
        d = min(d, dot(tp, tp));
    }}}
    return 1.0 - saturate(d);
}
#define NUM_CELLS 2.0
vec3 get3Dfrom2D(vec2 uv, float tileRows){
    vec2 tile = floor(uv);
    float z = floor(tileRows * tile.y + tile.x);
    return vec3(fract(uv), z);
}
float getTextureForPoint(vec3 p, int type){
    float res;
    if(type == PERLIN_WORLEY){
        float perlinNoise = getPerlinNoise(p, SIZE); res = perlinNoise;
        float worley0 = worley(p, NUM_CELLS*2.0);
        float worley1 = worley(p, NUM_CELLS*8.0);
        float worley2 = worley(p, NUM_CELLS*14.0);
        float worleyFBM = worley0 * 0.625 + worley1 * 0.25 + worley2 * 0.125;
        res = remap(perlinNoise, 0.0, 1.0, worleyFBM, 1.0);
    }else{
        float worley0 = worley(p, NUM_CELLS);
        float worley1 = worley(p, NUM_CELLS*2.0);
        float worley2 = worley(p, NUM_CELLS*4.0);
        float worley3 = worley(p, NUM_CELLS*8.0);
        float FBM0 = worley0 * 0.625 + worley1 * 0.25 + worley2 * 0.125;
        float FBM1 = worley1 * 0.625 + worley2 * 0.25 + worley3 * 0.125;
        float FBM2 = worley2 * 0.75 + worley3 * 0.25;
        res = FBM0 * 0.625 + FBM1 * 0.25 + FBM2 * 0.125;
    }
    return res;
}
void setMoonTexture(vec2 fragCoord, inout vec4 col){
    vec2 uv_ = fragCoord/iResolution.xy; vec2 uv = uv_;
    vec3 p = vec3(uv, 0.0);
    float base = getPerlinNoise(p, 2.6);
    float worley_ = worley(p, 2.0);
    col.a = saturate(remap(base, 0.45*worley_, 1.0, 0.0, 1.0));
}
void setCloudMap(vec2 fragCoord, inout vec4 col){
    // ★구름 풍성화(천장 overcast는 금지). 별밤이 주인공이되 구름이 하늘 전체에 자연스레 떠있게.
    //   직전: smoothstep(0.52,0.78) → 상위 ≈40%만 덮어 구름이 거의 사라짐(밤버그4).
    //   이제: 2옥타브 퍼린 노이즈(대형 덩어리+중형 디테일)를 합쳐 임계를 낮춰(coverage↑)
    //   하늘 전반에 구름 덩어리를 더 많이 깔되, 임계 위쪽에 천장(1.0 포화)을 만들지 않아
    //   덩어리 사이로 별·달이 계속 보인다(빽빽 판자 아님).
    vec2 uv = fragCoord/iResolution.xy;
    // 대형 분포(2.0셀) + 중형 디테일(5.2셀) 합성 — 한쪽 몰림 없이 하늘 전체 자연 분포.
    float big   = getPerlinNoise(vec3(uv*2.0, 0.0), 4.0);
    float small = getPerlinNoise(vec3(uv*5.2, 11.0), 4.0);
    float n = big*0.66 + small*0.34;
    // 임계 0.40~0.66: 0.52→0.40으로 낮춰 덮는 면적을 크게 늘림(상위 ≈58%가 구름 후보).
    //   상한 0.66에서 완전 1.0 도달 → 두지만, 위 cloudHeight 수직 프로파일이 끝을 깎아
    //   실제 화면에선 빽빽 천장이 아니라 두툼한 자연 구름 덱이 됨.
    float clump = smoothstep(0.40, 0.66, n);
    // 가벼운 상한(0.92)으로 완전 불투명 천장 셀 방지 — 가장 두꺼운 곳도 살짝 별이 비침.
    col.b = clump * 0.92;
}
void main(){
    vec2 fragCoord = vUv * iResolution.xy;
    vec4 col = vec4(0);
    float tileSize = 34.0; float padWidth = 1.0;
    float coreSize = tileSize - 2.0 * padWidth;
    float tileRows = 6.0;
    vec2 tile = floor((fragCoord.xy - 0.5) / tileSize);
    bool padCell = false;
    if(mod(fragCoord.x, tileSize) == 0.5 || mod(fragCoord.x, tileSize) == tileSize - 0.5){ padCell = true; }
    if(mod(fragCoord.y, tileSize) == 0.5 || mod(fragCoord.y, tileSize) == tileSize - 0.5){ padCell = true; }
    bool startPadX=false,endPadX=false,startPadY=false,endPadY=false;
    if(fragCoord.x == tile.x * tileSize + 0.5){ startPadX = true; }
    if(fragCoord.y == tile.y * tileSize + 0.5){ startPadY = true; }
    if(fragCoord.x == (tile.x + 1.0) * tileSize - 0.5){ endPadX = true; }
    if(fragCoord.y == (tile.y + 1.0) * tileSize - 0.5){ endPadY = true; }
    vec2 padding = vec2(2.0 * padWidth) * tile;
    vec2 pixel; vec2 uv;
    if(!padCell){
        pixel = fragCoord.xy - padWidth - padding; uv = vec2(pixel.xy/coreSize);
    }else{
        pixel = fragCoord.xy - padWidth - padding;
        if(startPadX){ pixel.x += coreSize; } if(startPadY){ pixel.y += coreSize; }
        if(endPadX){ pixel.x -= coreSize; } if(endPadY){ pixel.y -= coreSize; }
        uv = vec2(pixel.xy/coreSize);
    }
    vec3 p_ = get3Dfrom2D(uv, tileRows); vec3 p = p_;
    p.z /= (tileRows*tileRows);
    float worleyPerlinNoise = getTextureForPoint(p, PERLIN_WORLEY);
    float worleyNoise = getTextureForPoint(p, WORLEY);
    col.r = saturate(remap(worleyPerlinNoise, worleyNoise, 1.0, 0.0, 1.0));
    p_ = mod(p_ + 1.0, tileRows * tileRows); p = p_;
    p.z /= (tileRows*tileRows);
    worleyPerlinNoise = getTextureForPoint(p, PERLIN_WORLEY);
    worleyNoise = getTextureForPoint(p, WORLEY);
    col.g = saturate(remap(worleyPerlinNoise, worleyNoise, 1.0, 0.0, 1.0));
    if(fragCoord.x > tileRows * tileSize || fragCoord.y > tileRows * tileSize){ col = vec4(0); }
    setCloudMap(fragCoord, col); setMoonTexture(fragCoord, col);
    gl_FragColor = col;
}
`;

// ── Image 본문(레이마칭) — 풀스크린. rayDir/cameraPos는 게임 카메라에서 uniform 주입. ──
function imageFrag(STEPS_PRIMARY, STEPS_LIGHT){ return `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform int   iFrame;
uniform sampler2D iChannel1;        // BufferB 아틀라스
uniform sampler2D iChannel2;        // 블루노이즈
uniform vec3 iChannelRes1;          // 아틀라스 해상도
uniform vec3 uCamPos;               // 게임 카메라 월드좌표
uniform mat3 uCamBasis;             // 카메라 방향 기저(right,up,-forward)
uniform float uFov;                 // 수직 fov(rad)
uniform float uMoonLoc;             // 달 방위(라디안) — sky.js moonDir와 정렬
uniform float uMoonHeight;          // 달 고도
uniform float uStorm;               // 0=맑음 1=폭풍. 밤+폭풍이면 구름 두꺼운 먹구름·달/별 흐려짐
// ★B-1 통합: 낮 하늘색 + 태양 — sky.js applyDayNight가 매 프레임 주입(단일 dayTime 곡선).
uniform float uDay;                 // 낮 정도 0~1
uniform float uNight;               // 밤 정도 0~1 (= 1-uDay, 별/구름 페이드 곡선)
uniform float uHorizon;             // 노을 정도 0~1 (일출·일몰 지평선 부근)
uniform vec3  uSunDir;              // 태양 월드 방향(정규화) — 낮 하늘 태양 디스크/글로우

const float goldenRatio = 1.61803398875;
// ★구름 원경화: 수평 범위를 크게 키워(1000→2800) 구름 덱이 먼 하늘까지 퍼지고,
//   구름층을 머리 위 높은 곳의 얇은 슬랩(900~1300)으로 올림. 카메라(아래)에서 충분히 멀어
//   머리를 덮치는 압박감 없이 원경 하늘에 떠있는 느낌. 수평선 구름도 멀어져 톱니 자연 감소.
#define CLOUD_EXTENT 2800.0
#define STEPS_PRIMARY ${STEPS_PRIMARY}
#define STEPS_LIGHT ${STEPS_LIGHT}
// ★달 원경·축소: 멀리(100→320)·작게(8→14, 각크기 atan(14/320)≈2.5° → 기존 4.6°의 약 절반).
//   멀고 작은 보름달. 글로우 반경도 이 각크기에 연동(아래 getGlow)되어 함께 작아짐.
float moonDistance = 320.0; float moonSize = 14.0;
const vec3 lightColour = vec3(0.65, 0.8, 1.0);
const vec3 skyColour = 0.1 * vec3(0.32, 0.65, 1.0);
const float starCount = 20000.0; const float flickerSpeed = 6.0;
const float shapeSpeed = -5.0; const float detailSpeed = -10.0;
const float power = 100.0; const float densityMultiplier = 0.075;
const float shapeSize = 0.05; const float detailSize = 0.3;
const float shapeStrength = 0.7; const float detailStrength = 0.2;
// ★두꺼운 덱(판자 방지): 시작 700, 끝 1500(두께 800). 밀도가 수직 중심 두껍고 위/아래로 페이드
//   → 밑면이 직선으로 딱 잘리지 않고 부드럽게 사라짐. 카메라는 이 아래(200)에서 올려다봄.
const float cloudStart = 700.0; const float cloudEnd = 1500.0;
const vec3 minCorner = vec3(-CLOUD_EXTENT, cloudStart, -CLOUD_EXTENT);
const vec3 maxCorner = vec3(CLOUD_EXTENT, cloudEnd, CLOUD_EXTENT);

float getGlow(float dist, float radius, float intensity){
    dist = max(dist, 5e-7); return pow(radius/dist, intensity);
}
vec3 getStarPosition(float theta, float phi){
    return normalize(vec3( sin(theta)*cos(phi), sin(theta)*sin(phi), cos(theta)));
}
float rand(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rand(vec2 co){ return fract(sin(dot(co.xy,vec2(12.9898,78.233))) * 43758.5453); }
bool isActiveElevation(float theta, float level){ return sin(theta) > rand(vec2(theta, level)); }
float getDistToStar(vec3 p, float theta, float phi){
    vec3 starPos = getStarPosition(theta, phi); return 0.5+0.5*dot(starPos, p);
}
float getStars(vec3 rayDir){
    float theta = acos(rayDir.z); float width = PI/starCount;
    float level = floor((theta/PI)*starCount);
    float theta_; float phi_; float stars = 0.0; float dist; float level_; float rnd;
    for(float l = -10.0; l <= 10.0; l++){
        level_ = min(starCount-1.0, max(0.0, level+l)); theta_ = (level_+0.5)*width;
        if(!isActiveElevation(theta_, 0.0)){ continue; }
        rnd = rand(PI+theta_); phi_ = TWO_PI*rand(level_);
        dist = getDistToStar(rayDir, theta_, phi_);
        stars += getGlow(1.0-dist, rnd*8e-7, 2.9 + (sin(rand(rnd)*flickerSpeed*iTime)));
    }
    return 0.05*stars;
}
// ★B-1: 낮 파랑 → 노을 주황 → 밤 남색 연속 그라디언트 + 태양 디스크/글로우 + 별(밤 페이드).
//   천정색↔수평선색을 rayDir.y로 돔 그라디언트. 각 색을 dayTime(uNight/uHorizon)으로 lerp.
//   별은 uNight 곡선으로 페이드(낮=0). 폭풍이면 별 추가 감쇠.
//   태양: dot(rayDir,uSunDir) 큰 곳에 디스크+글로우. 낮 흰빛 → 노을 주황.
vec3 getSkyColour(vec3 rayDir, float mu){
    // ─ 별(밤에만, 늦게 등장) ─
    // ★재작업3(사령관): 박명에 별이 풀강도로 보이던 문제 → uNight 늦은 곡선(0.45~0.95)으로.
    //   박명(uNight<0.45)엔 거의 0, 깊은밤(→1)에 서서히. Points·starbox와 동일 곡선 공유.
    float starVis = smoothstep(0.45, 0.95, uNight);
    float stars = 0.0;
    // ⚡낮 fps: 별 루프(21회 pow/sin)는 starVis>0(밤)일 때만 — 기존엔 낮에도 전 픽셀 실행 후 ×0으로 버림.
    //   uniform 기반 분기라 GPU 워프 전체가 일관 스킵(발산 없음). 결과값은 기존과 동일(낮=0).
    if(starVis > 0.001 && rayDir.y > 0.0){ vec3 dir = rayDir.xzy; stars = getStars(dir); }
    stars *= (1.0 - uStorm) * starVis * 0.7;   // 낮엔 0, 폭풍이면 가려짐, 깊은밤도 은은하게(0.7)

    // ─ 돔 그라디언트 배경 하늘색 ─
    // ★재작업1(G5-a): 낮 하늘 밝기·채도 상향 + 천정→수평선 대비 복원(baseline 동등 이상).
    //   ACES+gamma(아래 main) 압축을 보상해 linear값을 키움. 수평선이 천정보다 밝은 베이스라인 톤.
    vec3 zenithDay    = vec3(0.18, 0.44, 1.02);     // 낮 천정 파랑(밝기·채도↑ — baseline 상단 230대 매칭)
    vec3 horizonDay   = vec3(0.80, 0.96, 1.12);     // 낮 수평선(밝게 — 베이스라인 밝은 밴드)
    vec3 sunsetCol    = vec3(1.10, 0.42, 0.14);     // 노을 주황·붉음
    // ★재작업2(G2): 박명 톤 — 깊은 밤(zenithNight)으로 곧장 떨어지지 말고, 트와일라잇 청색을 거치게.
    vec3 zenithTwi    = vec3(0.06, 0.12, 0.28);     // 박명 천정(짙은 청, 검정 아님)
    vec3 horizonTwi   = vec3(0.20, 0.22, 0.34);     // 박명 수평선(보랏빛 청)
    // ★재작업4(사령관 밤중간 버그): 깊은밤 하늘이 밝은 코발트 → 짙은 남색(거의 navy)으로 대폭 어둡게.
    //   별 또렷한 어두운 배경. 박명(twilight)은 비퇴행(위 zenithTwi 그대로).
    // ★밤버그(사령관 밤밤.png): 깊은밤 하늘이 코발트로 떠서 '저녁 어스름'처럼 보임. ACES+gamma(0.4545)가
    //   navy linear값을 디스플레이서 들어올림(0.060^0.4545≈0.28). → 한밤중답게 더 가라앉힘(별 대비↑).
    //   직전 0.015/0.028/0.060 → 약 40%↓. 별·달은 또렷 유지(배경만 어둡게).
    // ★밤버그2(사령관 한 단계 더↓): 0.008/0.016/0.034도 아직 밝음 → 약 35%↓로 거의 검정 navy.
    //   별·달 대비 더 좋아짐. 사물 형체는 hemi/달빛 directional이 담당(여기 안 건드림).
    vec3 zenithNight  = vec3(0.005, 0.010, 0.022);  // 깊은밤 천정 — 거의 검정에 가까운 짙은 navy
    vec3 horizonNight = vec3(0.008, 0.014, 0.028);  // 밤 수평선 짙은청(수평선 띠 흔적만)

    // ★재작업2(G2-a 급락 제거): 하늘 어두워짐을 raw uNight가 아니라 박명 보존 곡선으로.
    //   해가 지평선 부근(uHorizon↑)인 동안엔 darkening을 강하게 억제 → 상단 하늘이 검정으로 급락 안 함.
    //   uHorizon이 사라진 뒤(태양 충분히 하강)에야 night가 지배해 천천히 깊은 밤으로.
    float skyDark = uNight * (1.0 - 0.92*uHorizon);     // 노을 동안 하늘 밝기 유지
    // 2단계 lerp: 낮 → (skyDark) → 박명 → (깊은밤 비중) → 밤. night 후반에만 깊은밤색.
    float deepN = smoothstep(0.55, 1.0, uNight);        // 깊은 밤(천정 남색)은 night 후반에만
    vec3 zTwiMix = mix(zenithTwi,  zenithNight,  deepN);
    vec3 hTwiMix = mix(horizonTwi, horizonNight, deepN);
    vec3 skyTop = mix(zenithDay,  zTwiMix, skyDark);
    vec3 skyBot = mix(horizonDay, hTwiMix, skyDark);
    skyBot = mix(skyBot, sunsetCol, uHorizon);                          // 노을: 수평선 주황
    // 수평선 주황을 천정 쪽으로도 일부 번지게(노을 하늘 화사). 천정까지 닿진 않게.
    skyTop = mix(skyTop, sunsetCol*0.5, uHorizon*0.45);
    float t = smoothstep(0.0, 0.62, rayDir.y);                          // 수평선→천정(밴드 약간 넓힘)
    vec3 bg = mix(skyBot, skyTop, t);

    // ─ 태양 글로우/디스크 ─ (Preetham hotspot 대체)
    float sd = max(0.0, dot(normalize(rayDir), uSunDir));
    vec3 sunCol = mix(vec3(1.0,0.98,0.92), sunsetCol, uHorizon);        // 낮 흰빛 → 노을 주황
    // 글로우: 태양 주변 넓게 번지는 빛. 낮에 강, 밤(uDay→0)엔 약.
    float glow = pow(sd, 80.0) * 0.55 + pow(sd, 8.0) * 0.10;
    // 디스크: 태양 원반(또렷). 지평선 아래(uSunDir.y<0)면 디스크 끔(태양 짐).
    float disk = smoothstep(0.99965, 0.99985, sd) * smoothstep(-0.05, 0.02, uSunDir.y);
    bg += (glow * uDay + disk) * sunCol * (1.0 - 0.85*uStorm);

    return stars + bg;
}
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
    vec3 tMin = (boxMin - rayOrigin) / rayDir; vec3 tMax = (boxMax - rayOrigin) / rayDir;
    vec3 t1 = min(tMin, tMax); vec3 t2 = max(tMin, tMax);
    float tNear = max(max(t1.x, t1.y), t1.z); float tFar = min(min(t2.x, t2.y), t2.z);
    return vec2(tNear, tFar);
}
bool insideAABB(vec3 p){
    float eps = 1e-4;
    return  (p.x > minCorner.x-eps) && (p.y > minCorner.y-eps) && (p.z > minCorner.z-eps) &&
            (p.x < maxCorner.x+eps) && (p.y < maxCorner.y+eps) && (p.z < maxCorner.z+eps);
}
bool getCloudIntersection(vec3 org, vec3 dir, out float distToStart, out float totalDistance){
    vec2 intersections = intersectAABB(org, dir, minCorner, maxCorner);
    if(insideAABB(org)){ intersections.x = 1e-4; }
    distToStart = intersections.x; totalDistance = intersections.y - intersections.x;
    return intersections.x > 0.0 && (intersections.x < intersections.y);
}
float getPerlinWorleyNoise(vec3 pos){
    const float dataWidth = 204.0; const float tileRows = 6.0;
    const vec3 atlasDimensions = vec3(32.0, 32.0, 36.0);
    vec3 p = pos.xzy;
    vec3 coord = vec3(mod(p, atlasDimensions));
    float f = fract(coord.z); float level = floor(coord.z);
    float tileY = floor(level/tileRows); float tileX = level - tileY * tileRows;
    vec2 offset = atlasDimensions.x * vec2(tileX, tileY) + 2.0 * vec2(tileX, tileY) + 1.0;
    vec2 pixel = coord.xy + offset;
    vec2 data = texture2D(iChannel1, mod(pixel, dataWidth)/iChannelRes1.xy).rg;
    return mix(data.x, data.y, f);
}
float getCloudMap(vec3 p){
    vec2 uv = 0.5+0.5*(p.xz/(2.0*CLOUD_EXTENT)); return texture2D(iChannel1, uv).b;
}
float clouds(vec3 p, out float cloudHeight, bool sampleDetail){
    if(!insideAABB(p)){ cloudHeight = 0.0; return 0.0; }
    cloudHeight = saturate((p.y - cloudStart)/(cloudEnd-cloudStart));
    float cloud = getCloudMap(p);
    // ★밤+폭풍 먹구름: storm일수록 구름맵을 overcast로 끌어올려(틈 메움) 별·달을 가린다.
    //   맑음(uStorm=0): 원래 듬성 클럼프 유지. 폭풍(1): 0.55 하한 + 전체 가산 → 하늘 꽉 찬 먹구름.
    cloud = mix(cloud, max(cloud, 0.55) + 0.30, uStorm);
    if(cloud <= 0.0){ return 0.0; }
    // ★수직 밀도 프로파일(판자 방지): 중심(0.5) 두껍고 위/아래 끝(0,1)에서 0으로 부드럽게 페이드.
    //   밑면이 직선 수평선처럼 딱 잘리지 않음. 위/아래 비대칭(아래쪽 더 부드럽게)으로 자연스러운 구름 배.
    //   폭풍이면 위쪽 페이드 상한을 올려(0.62→0.85) 덱을 더 두껍게(먹구름 부피감).
    float vBottom = smoothstep(0.0, 0.40, cloudHeight);   // 아래쪽: 0~0.40 구간 서서히 등장
    float vTopEdge = mix(0.62, 0.85, uStorm);
    float vTop    = 1.0 - smoothstep(vTopEdge, 1.0, cloudHeight); // 위쪽: 서서히 소멸(폭풍 시 더 위까지 두껍게)
    cloud *= vBottom * vTop;
    if(cloud <= 0.0){ return 0.0; }
    p += vec3(shapeSpeed * iTime);
    float shape = 1.0-getPerlinWorleyNoise(shapeSize * p); shape *= shapeStrength;
    cloud = saturate(remap(cloud, shape, 1.0, 0.0, 1.0));
    if(cloud <= 0.0){ return 0.0; }
    p += vec3(detailSpeed * iTime, 0.0, 0.5 * detailSpeed * iTime);
    float detail = getPerlinWorleyNoise(detailSize * p); detail *= detailStrength;
    cloud = saturate(remap(cloud, detail, 1.0, 0.0, 1.0));
    // 폭풍이면 밀도 ×1.0→×2.0 (불투명한 먹구름 — 빛 차폐 강함 → 달/별 가림).
    return densityMultiplier * cloud * mix(1.0, 2.0, uStorm);
}
float HenyeyGreenstein(float g, float costh){
    return (1.0/(4.0 * 3.1415))  * ((1.0 - g * g) / pow(1.0 + g*g - 2.0*g*costh, 1.5));
}
float multipleOctaves(float extinction, float mu, float stepL){
    float luminance = 0.0; const float octaves = 4.0;
    float a = 1.0; float b = 1.0; float c = 1.0; float phase;
    for(float i = 0.0; i < octaves; i++){
        phase = mix(HenyeyGreenstein(-0.1*c, mu), HenyeyGreenstein(0.3*c, mu), 0.7);
        luminance += b * phase * exp(-stepL * extinction * a);
        a *= 0.25; b *= 0.5; c *= 0.5;
    }
    return luminance;
}
float lightRay(vec3 org, vec3 p, float mu, vec3 lightDirection){
    float lightRayDistance = CLOUD_EXTENT*1.5; float distToStart = 0.0;
    getCloudIntersection(p, lightDirection, distToStart, lightRayDistance);
    float stepL = lightRayDistance/float(STEPS_LIGHT);
    float lightRayDensity = 0.0; float cloudHeight = 0.0;
    for(int j = 0; j < STEPS_LIGHT; j++){
        bool sampleDetail = true; if(lightRayDensity > 0.3){ sampleDetail = false; }
        lightRayDensity += mix(1.0, 0.75, mu) * clouds(p + lightDirection * float(j) * stepL, cloudHeight, sampleDetail);
    }
    float beersLaw = multipleOctaves(lightRayDensity, mu, stepL);
    return mix(beersLaw * 2.0 * (1.0-(exp(-stepL*lightRayDensity*2.0))), beersLaw, 0.5+0.5*mu);
}
vec3 mainRay(vec3 org, vec3 dir, vec3 lightDirection, out float totalTransmittance, float mu, vec3 lightColour_, float offset){
    totalTransmittance = 1.0; vec3 colour = vec3(0.0);
    float distToStart = 0.0; float totalDistance = 0.0;
    bool renderClouds = getCloudIntersection(org, dir, distToStart, totalDistance);
    if(!renderClouds){ return colour; }
    float stepS = totalDistance / float(STEPS_PRIMARY);
    distToStart += stepS * offset; float dist = distToStart;
    // 폭풍이면 구름이 받는 달빛을 줄여(power ×1→×0.45) 어둑한 먹구름. 색도 청회로 식힘.
    // ★재작업4(사령관 밤중간 버그): 맑은 밤 구름이 흰 뭉게구름처럼 너무 밝음 → 달빛 받는 albedo 대폭↓.
    //   밤 구름을 어두운 회청으로(power 100→effective ~38). 달빛 강한 가장자리만 약한 림.
    // ★밤버그2(프레임 권장): 어두워진 하늘 대비 구름이 떠 보이지 않게 0.30,0.36,0.46 → 0.22,0.26,0.34.
    //   구름 형체는 남되 은은히(달빛 강한 가장자리 림만).
    vec3 nightCloudCol = vec3(0.22, 0.26, 0.34);                 // 더 어두운 회청(하늘과 한 톤으로 가라앉음)
    vec3 stormLightCol = mix(nightCloudCol, vec3(0.42,0.48,0.58), uStorm);
    vec3 p = org + dist * dir; vec3 moonLight = stormLightCol * power * mix(0.38, 0.45, uStorm);
    float phaseFunction = mix(HenyeyGreenstein(-0.3, mu), HenyeyGreenstein(0.3, mu), 0.7);
    for(int i = 0; i < STEPS_PRIMARY; i++){
        float cloudHeight; float density = clouds(p, cloudHeight, true);
        float sigmaS = 1.0; float sigmaA = 0.0; float sigmaE = sigmaS + sigmaA;
        float sampleSigmaS = sigmaS * density; float sampleSigmaE = sigmaE * density;
        if(density > 0.0 ){
            // 폭풍이면 구름 자체에 약한 청회 앰비언트 바닥을 깔아(먹구름이 새카만 void가 아니라
            //   부피 있는 진회색 먹구름으로 읽히게). 맑음(uStorm=0)이면 0 → 기존 톤 유지.
            vec3 stormAmb = vec3(0.06,0.075,0.10) * uStorm;
            // ★재작업4: 밤 구름 앰비언트도 어둡게(흰 구름 방지) — lightColour_(밝은 청백) 대신 어두운 회청.
            vec3 ambient = vec3(0.18,0.22,0.30) * mix((0.0), (0.2), cloudHeight) + stormAmb;
            vec3 luminance = 0.2 * ambient + moonLight * phaseFunction * lightRay(org, p, mu, lightDirection);
            luminance *= sampleSigmaS;
            float transmittance = exp(-sampleSigmaE * stepS);
            colour += totalTransmittance * (luminance - luminance * transmittance) / sampleSigmaE;
            totalTransmittance *= transmittance;
            if(totalTransmittance <= 0.01){ totalTransmittance = 0.0; return colour; }
        }
        dist += stepS; p = org + dir * dist;
    }
    return colour;
}
bool getPlaneIntersection(vec3 org, vec3 ray, vec3 planePoint, vec3 normal, out float t){
    float denom = dot(normal, ray);
    if (denom > 1e-6) { vec3 p0l0 = planePoint - org; t = dot(p0l0, normal) / denom; return (t >= 0.0); }
    t = 0.0; return false;
}
vec3 getMoon(vec3 cameraPos, vec3 rayDir, vec3 moonDirection, out bool covered){
    vec2 uv = vec2(0); covered = false;
    vec3 p0 = cameraPos + moonDirection * moonDistance;
    vec3 offsetDir = normalize(vec3(cos(uMoonLoc), uMoonHeight+0.01, sin(uMoonLoc)));
    float t = 0.0;
    getPlaneIntersection(cameraPos, offsetDir, p0, moonDirection, t);
    vec3 p1 = cameraPos + offsetDir * t; vec3 v = normalize(p1-p0); vec3 u = normalize(cross(moonDirection, v));
    if(getPlaneIntersection(cameraPos, rayDir, p0, moonDirection, t)){
        vec3 p = cameraPos + rayDir * t;
        if(length(p - p0) > moonSize){ return vec3(0); }
        uv = vec2(dot(p, u), dot(p, v)); uv /= (2.0*moonSize);
        covered = true; return texture2D(iChannel1, uv+0.5).aaa;
    }
    return vec3(0);
}
vec3 ACESFilm(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

mat3 lookAtM(vec3 dir, vec3 up){ vec3 z=normalize(dir); vec3 x=normalize(cross(z,up)); vec3 y=cross(x,z); return mat3(x,y,-z); }
void main(){
    vec2 fragCoord = vUv * iResolution.xy;
    // 게임 카메라 기반 rayDir: NDC → 카메라 기저로 변환
    vec2 xy = fragCoord - iResolution.xy / 2.0;
    float z = (0.5 * iResolution.y) / tan(uFov / 2.0);
    vec3 rayCam = normalize(vec3(xy, -z));
    vec3 rayDir = normalize(uCamBasis * rayCam);

    // 구름 레이마칭 원점: 게임 카메라 실제 y는 배 위(낮음)지만, 볼류 하늘은 별도 스카이박스 월드.
    //   ★구름 원경화: 원점을 구름 덱(900~1300) 한참 아래(200)에 둬 위를 올려다보는 구도.
    //   덱이 머리 위 먼 고공에 떠있고, 수평선 쪽으로 멀어지며 옅어진다(근접 압박 0). 영화 톤 유지.
    vec3 cameraPos = vec3(0.0, 200.0, 0.0);

    #ifdef DEBUG_REF
    // 레퍼런스 카메라(_skytest와 동일): 셰이더 포팅 자체 검증용.
    cameraPos = vec3(-CLOUD_EXTENT*0.4, cloudEnd*0.7, CLOUD_EXTENT*0.4);
    vec3 tdir = vec3(0.0998, 0.07, -0.995);
    rayCam = normalize(vec3(xy, -(0.5*iResolution.y)/tan(radians(55.0)/2.0)));
    rayDir = normalize(lookAtM(tdir, vec3(0,1,0)) * rayCam);
    #endif

    vec3 lightDirection = normalize(vec3(cos(uMoonLoc), uMoonHeight, sin(uMoonLoc)));
    float mu = 0.5+0.5*dot(rayDir, lightDirection);

    // ★ 떨림 수정: 디더 temporal 항 제거(프레임 깜빡임 없음). 공간 디더만.
    //   ★세로 줄무늬 수정: fragCoord/1024(=256텍스처 4배 다운샘플 → 컬럼 줄무늬)를
    //   픽셀당 NearestFilter 샘플(fragCoord 그대로 mod 256)로 교체 → 컬럼 상관 제거.
    float offset = texture2D(iChannel2, fract(fragCoord / 256.0)).r;

    vec3 background = getSkyColour(rayDir, 0.05*offset+mu);
    // 달·달무리·볼류 구름은 밤에만(낮엔 uNight≈0 → 자연 소멸). 낮 fps 보존: 구름 레이마칭 스킵.
    if(uNight > 0.02){
        if(mu > 0.85){
            bool covered = false;
            vec3 moonColour = getMoon(vec3(0), rayDir, lightDirection, covered);
            // ★월출 occlusion(사령관): 달이 수평선 아래(uMoonHeight<0)면 디스크 페이드아웃 → 바다 너머서 투명하게 안 비침.
            //   수평선 막 넘을 때(−0.02~0.10) 부드럽게 등장(급조 X). 떠오른 뒤에만 또렷한 보름달.
            float moonRise = smoothstep(-0.02, 0.10, uMoonHeight);
            // 폭풍이면 달 원반을 어둑하게(먹구름 사이로 희미). 맑음이면 또렷한 보름달.
            if(covered){ background = mix(background, mix(moonColour, moonColour*0.25, uStorm), uNight*moonRise); }
        }
        // 달무리 글로우도 폭풍 시 약화(1-uStorm) — 달이 먹구름 뒤로. 밤 페이드.
        // ★재작업4: 달무리가 천정 하늘을 밝은 청으로 들뜨게 함 → 글로우 색 어둡게(0.6×)·강도↓로 깊은밤 navy 유지.
        // ★밤버그(사령관): 달무리 글로우가 좌상단(달 방향) 코발트 들뜸의 주 원인 → 강도 0.55→0.30↓.
        //   달 디스크 자체는 유지(아래 getMoon). 하늘 배경 산란만 죽임. + 달이 수평선 위(uMoonHeight↑)일 때만.
        float moonUpFade = smoothstep(-0.02, 0.10, uMoonHeight);   // 달이 수평선 아래면 달무리 0
        background += (lightColour*0.30) * saturate(getGlow(1.0-mu, 0.5*(1.0-cos(atan(moonSize/moonDistance))), 2.0)) * (1.0 - 0.8*uStorm) * uNight * moonUpFade;
    }
    float totalTransmittance = 1.0; float exposure = 0.5;
    // ★낮 fps: 볼류 구름 레이마칭은 밤(uNight>임계)에만. 낮엔 배경 그라디언트+태양만(저비용).
    // ★재작업3(사령관 구름버그): 박명(노을 밝을 때)에 밤 먹구름이 풀강도로 '짠' 나타나던 문제.
    //   night가 조금만 넘어도(uNight>0.02) 구름이 배경(핑크 노을)을 풀강도로 가렸음.
    //   → cloudVis = smoothstep(0.35,0.92,uNight) 늦은 곡선으로 구름 색·차폐 둘 다 비례.
    //   박명(uNight<0.35)엔 구름 거의 0, 깊은밤(→1)엔 풀. "세상이 어두워지면서 서서히 생김".
    vec3 cloudCol = vec3(0.0);
    if(uNight > 0.02){
        cloudCol = exposure * uNight * mainRay(cameraPos, rayDir, lightDirection, totalTransmittance, dot(rayDir, lightDirection), lightColour, offset);
    }
    // ★수평선 톱니 수정: 수평선 가까이(rayDir.y 작음) 광선은 구름 박스를 거의 수평으로 길게 통과해
    //   밀도가 폭증 → 톱니 spike 벽이 됨. 수평선 부근에서 구름 기여를 부드럽게 줄여(덱이 멀어지며 옅어짐)
    //   별·배경은 유지. 0.05~0.22rad 구간서 구름만 페이드.
    // 폭풍이면 구름이 매우 불투명해 수평선 부근에서 검은 칼날 경계가 됨 → graze 밴드를 넓혀
    //   (0.20→0.34) 수평선에서 구름이 더 길게 부드럽게 옅어지게(자연스러운 폭풍 운저).
    float cloudGraze = smoothstep(0.04, mix(0.20, 0.34, uStorm), rayDir.y);
    cloudCol *= cloudGraze;
    totalTransmittance = mix(1.0, totalTransmittance, cloudGraze);   // 구름 옅어진 만큼 배경 더 비침
    // ★구름 늦은 등장: 색·차폐(transmittance) 모두 cloudVis로 비례. 폭풍이면 즉시 풀(악천후는 곧장 먹구름).
    float cloudVis = max(smoothstep(0.35, 0.92, uNight), uStorm);
    cloudCol *= cloudVis;
    totalTransmittance = mix(1.0, totalTransmittance, cloudVis);     // 박명엔 차폐 0 → 노을 배경 그대로 비침
    vec3 colour = cloudCol + background * totalTransmittance;
    colour = ACESFilm(colour);
    colour = pow(colour, vec3(0.4545));

    // ★ 바다 덮음 방지: 수평선 아래로 향하는 광선은 알파 0(바다 영역 완전 투명).
    //   ★톱니 수정: 페이드 밴드를 넓혀(-0.02~0.14) 수평선 경계가 부드럽게 사라지게(저해상도 톱니 완화).
    float horizonAlpha = smoothstep(-0.02, 0.14, rayDir.y);
    gl_FragColor = vec4(colour, horizonAlpha);
}
`; }

export function initNightSky(ctx, { fast=true, resScale=0.8 }={}){   // ★0.67→0.8: 저해상도 업스케일 톱니/줄무늬 완화(성능 여유분 내)
  const { scene, camera, renderer } = ctx;

  const STEPS_PRIMARY = fast ? 32 : 64;
  const STEPS_LIGHT   = fast ? 8  : 10;

  // ── 디더 노이즈(iChannel2) — 절차적 256² ──
  // ★세로 줄무늬 수정: 기존은 스캔라인 순서 LCG(seed&0xff)로, LCG 저비트는 주기적이고
  //   같은 행 인접 픽셀이 상관 → 레이마칭 offset이 컬럼마다 코히어런트해 세로 줄/톱니가 생김.
  //   x,y 좌표를 각각 섞는 2D integer hash로 교체 → 양축 비상관(흰점/디더 줄무늬 제거).
  const N=256;
  const noiseData=new Uint8Array(N*N*4);
  const ihash=(x,y)=>{ let h=(x*374761393+y*668265263)>>>0; h=(h^(h>>>13))>>>0; h=(h*1274126177)>>>0; return (h^(h>>>16))&0xff; };
  for(let y=0;y<N;y++) for(let x=0;x<N;x++){ const i=(y*N+x);
    noiseData[i*4]=ihash(x,y); noiseData[i*4+1]=ihash(x+131,y+57); noiseData[i*4+2]=ihash(x+919,y+443); noiseData[i*4+3]=255; }
  const noiseTex=new THREE.DataTexture(noiseData,N,N,THREE.RGBAFormat);
  noiseTex.wrapS=noiseTex.wrapT=THREE.RepeatWrapping;
  noiseTex.minFilter=noiseTex.magFilter=THREE.NearestFilter;   // 디더는 점별 — 보간 줄무늬 방지
  noiseTex.needsUpdate=true;

  // ── BufferB 아틀라스 1회 굽기 → FloatType RT(256²) ──
  const ATLAS=256;
  const atlasRT=new THREE.WebGLRenderTarget(ATLAS,ATLAS,{
    minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter,
    type:THREE.FloatType, format:THREE.RGBAFormat, depthBuffer:false, stencilBuffer:false,
    wrapS:THREE.RepeatWrapping, wrapT:THREE.RepeatWrapping });

  const fsScene=new THREE.Scene();
  const fsCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const bakeMat=new THREE.ShaderMaterial({
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
    fragmentShader:COMMON+BAKE_FRAG,
    uniforms:{ iResolution:{value:new THREE.Vector3(ATLAS,ATLAS,1)} },
    depthTest:false, depthWrite:false });
  const fsQuad=new THREE.Mesh(new THREE.PlaneGeometry(2,2), bakeMat);
  fsScene.add(fsQuad);

  let baked=false;
  function bake(){
    if(baked) return;
    const prevRT=renderer.getRenderTarget();
    renderer.setRenderTarget(atlasRT);
    renderer.render(fsScene,fsCam);
    renderer.setRenderTarget(prevRT);
    baked=true;
  }

  // ── 메인 레이마칭: 0.5× 저해상도 RT ──
  let rtW=Math.max(2,Math.floor(innerWidth*resScale)), rtH=Math.max(2,Math.floor(innerHeight*resScale));
  const skyRT=new THREE.WebGLRenderTarget(rtW,rtH,{ minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, depthBuffer:false, stencilBuffer:false });

  const _dbgRef = (typeof location!=='undefined' && /[?&]refcam=1/.test(location.search)) ? '#define DEBUG_REF\n' : '';
  const imgMat=new THREE.ShaderMaterial({
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
    fragmentShader:COMMON+_dbgRef+imageFrag(STEPS_PRIMARY,STEPS_LIGHT),
    uniforms:{
      iResolution:{value:new THREE.Vector3(rtW,rtH,1)},
      iTime:{value:0}, iFrame:{value:0},
      iChannel1:{value:atlasRT.texture}, iChannel2:{value:noiseTex},
      iChannelRes1:{value:new THREE.Vector3(ATLAS,ATLAS,1)},
      uCamPos:{value:new THREE.Vector3()},
      uCamBasis:{value:new THREE.Matrix3()},
      uFov:{value:THREE.MathUtils.degToRad(camera.fov)},
      uMoonLoc:{value:4.5}, uMoonHeight:{value:0.55},   // ★0.25→0.55: 달 고도 상향(하늘 더 높이). sky.js setMoon이 매 프레임 갱신
      uStorm:{value:0.0},   // 밤+폭풍: 볼류 구름 먹구름화·달/별 가림. wind.js→sky.js가 매 프레임 주입
      // ★B-1 통합: 낮 하늘색+태양 — sky.js applyDayNight가 매 프레임 주입(단일 dayTime 곡선).
      uDay:{value:1.0}, uNight:{value:0.0}, uHorizon:{value:0.0},
      uSunDir:{value:new THREE.Vector3(0,1,0)},
    },
    depthTest:false, depthWrite:false });
  const imgQuad=new THREE.Mesh(new THREE.PlaneGeometry(2,2), imgMat);
  const imgScene=new THREE.Scene(); imgScene.add(imgQuad);

  // ── 배경 합성: 큰 하늘 돔(SphereGeometry, BackSide)에 skyRT를 화면좌표로 매핑 ──
  //   ★ 버그1 수정: 풀스크린 NDC quad(전 화면 덮음) → 하늘 돔으로 교체.
  //     돔은 depthTest ON. 바다·배·지형(불투명, 가까운 depth)이 자연히 앞에서 이기므로
  //     실제 빈 하늘(수평선 위·far) 픽셀에만 볼류 별밤+구름이 보인다. 바다는 절대 안 덮인다.
  //     반경 6500(fog far 4000 < 돔 < camera.far 8000) → 씬 안에 포함, 바다(반경3000)보다 큼.
  //   레이마칭은 여전히 0.5~0.67× skyRT에 1회 → 돔은 그 결과를 gl_FragCoord로 샘플(저해상도 유지).
  const SKY_R = 6500;
  const bgMat=new THREE.ShaderMaterial({
    uniforms:{ uTex:{value:skyRT.texture}, uOpacity:{value:0.0}, uRes:{value:new THREE.Vector2(innerWidth,innerHeight)} },
    vertexShader:`void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader:`uniform sampler2D uTex; uniform float uOpacity; uniform vec2 uRes;
      void main(){ vec2 uv = gl_FragCoord.xy / uRes; vec4 t = texture2D(uTex, uv);
        // 수평선 아래(t.a=0)는 완전 투명 → 바다 영역에 구름/하늘 안 그려짐. uOpacity=밤 크로스페이드.
        gl_FragColor = vec4(t.rgb, t.a * uOpacity); }`,
    side:THREE.BackSide, transparent:true, depthWrite:false, depthTest:true, fog:false });
  const bgMesh=new THREE.Mesh(new THREE.SphereGeometry(SKY_R,32,20), bgMat);
  bgMesh.frustumCulled=false; bgMesh.renderOrder=-100000; bgMesh.visible=false;   // 가장 먼저 그림(뒤배경)
  scene.add(bgMesh);

  // 카메라 기저 행렬 갱신(right,up,-forward) — world matrix에서 추출
  const _m=new THREE.Matrix4(), _b=new THREE.Matrix3();
  const _fwd=new THREE.Vector3(), _up=new THREE.Vector3(), _right=new THREE.Vector3();
  function updateCamBasis(){
    camera.updateMatrixWorld();
    _m.copy(camera.matrixWorld);
    // three 카메라: -Z=forward. rayCam의 z=-z 변환과 맞추기 위해 basis=(right,up,-forward) 형태로
    _right.setFromMatrixColumn(_m,0).normalize();
    _up.setFromMatrixColumn(_m,1).normalize();
    _fwd.setFromMatrixColumn(_m,2).normalize();   // 이건 +Z축(=뒤)
    // rayCam=(x,y,-z): basis * (x,y,-z) = x*right + y*up + (-z)*(+Zcol)
    // (+Zcol)=뒤이므로 -z*(뒤)=z*(앞). 부호 맞음.
    _b.set(
      _right.x,_up.x,_fwd.x,
      _right.y,_up.y,_fwd.y,
      _right.z,_up.z,_fwd.z
    );
    imgMat.uniforms.uCamBasis.value.copy(_b);
    imgMat.uniforms.uCamPos.value.copy(camera.position);
    imgMat.uniforms.uFov.value=THREE.MathUtils.degToRad(camera.fov);
  }

  const _dbSize=new THREE.Vector2();
  function resize(){
    renderer.getSize(_dbSize);                                   // CSS px
    const pr=renderer.getPixelRatio();
    rtW=Math.max(2,Math.floor(_dbSize.x*resScale)); rtH=Math.max(2,Math.floor(_dbSize.y*resScale));
    skyRT.setSize(rtW,rtH);
    imgMat.uniforms.iResolution.value.set(rtW,rtH,1);
    bgMat.uniforms.uRes.value.set(_dbSize.x*pr, _dbSize.y*pr);   // 돔 샘플은 물리픽셀(gl_FragCoord) 기준
  }
  addEventListener('resize',resize);
  resize();

  let _night=0, _time=0, _frame=0;
  // ★B-1: 돔이 유일한 하늘(낮 포함 항상 렌더). uOpacity는 항상 1.0(돔=배경). _night는 별/구름/달 페이드용.
  function setNight(n){ _night=THREE.MathUtils.clamp(n,0,1);
    imgMat.uniforms.uNight.value=_night; imgMat.uniforms.uDay.value=1.0-_night;
    bgMat.uniforms.uOpacity.value=1.0; bgMesh.visible=true; }
  // ★B-1: 단일 dayTime 곡선 주입 — sky.js applyDayNight가 매 프레임 호출. 낮하늘색·태양·노을 구동.
  function setDayNight(day, night, horizon, sunDir){
    _night=THREE.MathUtils.clamp(night,0,1);
    imgMat.uniforms.uDay.value=THREE.MathUtils.clamp(day,0,1);
    imgMat.uniforms.uNight.value=_night;
    imgMat.uniforms.uHorizon.value=THREE.MathUtils.clamp(horizon,0,1);
    if(sunDir) imgMat.uniforms.uSunDir.value.copy(sunDir).normalize();
    bgMat.uniforms.uOpacity.value=1.0; bgMesh.visible=true;
  }
  // 달: 방위는 게임 달(moonV)과 정렬하되, 고도는 영화 톤 위해 낮게(구름 덱 위) 고정. 천정으로 솟지 않게.
  function setMoon(loc,height){ imgMat.uniforms.uMoonLoc.value=loc; if(height!=null) imgMat.uniforms.uMoonHeight.value=height; }
  // 폭풍 강도 주입(0~1) — 밤+폭풍이면 볼류 구름이 두꺼운 먹구름이 되어 달/별을 가린다.
  function setStorm(k){ imgMat.uniforms.uStorm.value=THREE.MathUtils.clamp(k,0,1); }
  // ★ 볼류 달의 월드 방향(water·sprite 정렬용) — lightDirection=normalize(cos(loc),height,sin(loc))
  const _moonWorld=new THREE.Vector3();
  function moonDir(){ const l=imgMat.uniforms.uMoonLoc.value, h=imgMat.uniforms.uMoonHeight.value;
    return _moonWorld.set(Math.cos(l), h, Math.sin(l)).normalize(); }

  // ★B-1: 돔이 유일한 하늘 → 매 프레임 항상 레이마칭(낮 포함). 낮엔 셰이더 내부에서
  //   볼류 구름 레이마칭을 스킵(uNight>0.02만)하므로 낮 비용은 배경 그라디언트+태양만(저비용).
  ctx.onUpdate((dt)=>{
    _time+=dt; _frame++;
    if(!baked) bake();
    bgMesh.position.copy(camera.position);            // 하늘 돔 카메라 추종(항상 플레이어 감쌈)
    updateCamBasis();
    imgMat.uniforms.iTime.value=_time;
    imgMat.uniforms.iFrame.value=_frame;
    const prevRT=renderer.getRenderTarget();
    const prevAuto=renderer.autoClear;
    const _cc=renderer.getClearColor(new THREE.Color()); const _ca=renderer.getClearAlpha();
    renderer.setRenderTarget(skyRT);
    renderer.setClearColor(0x000000, 0.0);   // 투명 클리어 — 광선이 quad 전체를 덮으므로 실제론 셰이더 알파가 결정
    renderer.clear();
    renderer.render(imgScene,fsCam);
    renderer.setClearColor(_cc, _ca);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear=prevAuto;
  });

  // (배경 quad는 scene 안에서 renderOrder 최저로 자동 합성 — 별도 렌더 훅 불필요)
  function renderBackground(){ /* no-op: in-scene quad. game.html 하위호환용 빈 함수 */ }

  ctx.nightsky={ bake, setNight, setDayNight, setMoon, setStorm, moonDir, renderBackground, skyRT, atlasRT,
    get night(){ return _night; }, dispose(){ skyRT.dispose(); atlasRT.dispose(); noiseTex.dispose(); } };
  return ctx.nightsky;
}

export { initNightSky as initNightsky };   // sandbox ?sys=nightsky 자동로더 별칭(실모듈 그대로)
