// sky.js — three.js Sky(대기 산란) + day-night 사이클 + fbm 구름 돔 + 별/달/밤하늘 스카이박스. 날씨(폭풍) 연동.
// 낮: 파란 산란 하늘 + 또렷한 태양 + 듬성 구름. 노을: 동/서 지평선 붉게. 밤: 별·달·밤하늘.
// ★ day-night 로직은 mas src/main.js(검증본) 이식 — three.js Sky 위에 시간 시스템을 얹음.
//   dayTime 0~1: 0=일출(동) 0.25=정오 0.5=일몰(서) 0.75=자정.
//   폭풍(setStorm)·fbm 구름은 시간과 독립적으로 그대로 작동(밤+폭풍은 더 어둡게 자연 합성).
import * as THREE from 'three';
// ★B-1(통합 하늘): three.js Sky(Preetham 대기산란) 완전 제거. nightsky 볼류 돔 하나가 낮·노을·밤 전부 그린다.
//   sky.js는 태양 방향 계산(elev/azimuth→sunV)·조명·별3종·달·fog·exposure만 소유하고,
//   낮하늘색/태양 디스크는 nightsky.setDayNight(day,night,horizon,sunDir)로 위임한다.

export function initSky(ctx){
  const { scene, camera, renderer, sun, hemi, fill, amb } = ctx;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;

  // ── 🎛️ 톤매퍼 / 노출 라이브 훅 (2026-07-27 신설) ──
  //   ★왜 필요한가: 그레이딩(grade.js)으로 못 고치는 것이 있고, 그중 최대 레버가 **톤매퍼**다.
  //     ACESFilmic은 영화 산업 표준 톤매퍼이고 **설계 목적이 "색을 입히지 않는 것"**이다.
  //     게다가 하이라이트를 흰색으로 수렴시킨다 → 실측 high 채도 0.151(레퍼런스 0.394의 0.38배)이 정확히 그 증상이다.
  //     `_색감_레퍼런스.md` §3-②가 지목한 원인인데 그동안 손을 못 댔다(교체 도구가 없었다).
  //   Neutral(Khronos PBR Neutral)은 채도 보존이 목적이라 팰월드류 밝고 색 있는 룩에 가깝다.
  //   ⚠️어느 쪽이 나은지는 **사령관 실기 육안**으로만 정한다. 헤드리스 색 판정은 이 프로젝트에서 이미 여러 번 틀렸다.
  //   ⚠️버전 방어: AgX/Neutral은 three r16x부터다. THREE에 없으면 목록에서 자동 제외한다(구버전에서 undefined 대입 방지).
  const TONEMAPS = {};
  for (const [k, v] of [['none','NoToneMapping'], ['linear','LinearToneMapping'], ['reinhard','ReinhardToneMapping'],
                        ['cineon','CineonToneMapping'], ['aces','ACESFilmicToneMapping'],
                        ['agx','AgXToneMapping'], ['neutral','NeutralToneMapping']])
    if (THREE[v] !== undefined) TONEMAPS[k] = THREE[v];
  let _expMul = 1;                                   // 노출 배수 — applySky가 매 프레임 P.exposure를 덮어쓰므로 곱으로 건다
  try{
    window.__tonemap = v => {
      if (typeof v === 'string' && TONEMAPS[v] !== undefined) renderer.toneMapping = TONEMAPS[v];
      const cur = Object.keys(TONEMAPS).find(k => TONEMAPS[k] === renderer.toneMapping) || '?';
      return { now: cur, 사용가능: Object.keys(TONEMAPS) };
    };
    // __exposure(1.15) = 15% 밝게. 시간대 자동 노출(P.exposure)에 곱해지므로 노을·밤 곡선은 그대로 유지된다.
    window.__exposure = m => { if (m != null) _expMul = +m; return { mul: _expMul, now: +renderer.toneMappingExposure.toFixed(3) }; };
  }catch(_){}
  ctx.skyTone = { get expMul(){ return _expMul; }, set expMul(v){ _expMul = v; } };

  // P = 태양/노출 파라미터(Sky 제거 후 잔존). elevation/azimuth/exposure만 사용.
  //   turbidity/rayleigh/mie는 더 이상 하늘 렌더에 안 쓰이나, setStorm/applyDayNight 잔존 참조 안전을 위해 유지(무해).
  const P = { turbidity:6, rayleigh:2.6, mieCoefficient:0.003, mieDirectionalG:0.92, elevation:32, azimuth:135, exposure:0.62 };
  const sunV = new THREE.Vector3();           // 태양 방향(elevation/azimuth → 구면) — uSunDir·조명·water·nightsky 공급
  const moonV = new THREE.Vector3();           // 달 방향(태양 반대편) — ★moonDir로 노출(밤바다 달빛 반사용)
  // 수평선 톤 통일용 상수: Shadertoy skyColour=0.1*(0.32,0.65,1.0). 밤 수평선/안개를 이 짙은 청으로.
  const _DAY_FOG = new THREE.Color(0x8fc1e3);                  // core 초기 하늘색(낮 안개/배경)
  const _NIGHT_HORIZON = new THREE.Color(0.030, 0.060, 0.100); // 볼류 밤하늘 수평선 ≈ skyColour 계열(짙은 청)
  const _SUNSET_WARM = new THREE.Color(0xff7a3c);             // ★석양 안개 틴트(따뜻한 주황) — horizon 구간에 섞음
  const _fogTmp = new THREE.Color();                          // fog/background 계산용 임시색(GC 회피)
  const _SUN_GLOW_DAY = new THREE.Color(0xffffff);           // 정오 태양 글로우(흰)
  const _SUN_GLOW_SET = new THREE.Color(0xff5a1e);           // ★지는 해 글로우(짙은 주황·붉음)
  // ★Sky 제거: 태양 방향(sunV)·달 방향(moonV)·태양 조명 위치·water uSunDir만 갱신. 대기 산란 uniform 없음.
  function applySky(){
    const phi=THREE.MathUtils.degToRad(90-P.elevation), theta=THREE.MathUtils.degToRad(P.azimuth);
    sunV.setFromSphericalCoords(1,phi,theta);
    moonV.copy(sunV).multiplyScalar(-1);                                                   // 달 = 태양 정반대
    renderer.toneMappingExposure=P.exposure*_expMul;   // ★_expMul = __exposure() 라이브 배수(시간대 곡선은 보존)
    // ☀️ 태양 위치 — ★2026-07-24 그림자 추종: 원점 절대좌표(구버전)면 플레이어가 멀어질 때 그림자 프러스텀 밖으로 나감.
    //   플레이어 기준 오프셋으로 이동해 그림자 카메라(core.js SHADOW_R)가 항상 플레이어를 덮게 한다.
    //   조명 방향(sunV)은 동일 — hemi/water엔 무영향. 거리 D는 프러스텀 far(1000) 안.
    if(sun){
      const _p = (ctx.player && ctx.player.pos) ? ctx.player.pos : { x:0, y:0, z:0 };
      const _D = 500;
      sun.position.set(_p.x + sunV.x*_D, Math.max(160, sunV.y*_D), _p.z + sunV.z*_D);
      if(sun.target){ sun.target.position.set(_p.x, 0, _p.z); sun.target.updateMatrixWorld(); }
    }
    if(ctx.water&&ctx.water.mat.uniforms) ctx.water.mat.uniforms.uSunDir.value.copy(sunV).normalize();
  }

  // ☀️ 부드러운 태양 glow(radial gradient sprite)
  const sc=document.createElement('canvas'); sc.width=sc.height=128; const scx=sc.getContext('2d');
  const grd=scx.createRadialGradient(64,64,0,64,64,64);
  grd.addColorStop(0,'rgba(255,252,240,1)'); grd.addColorStop(0.16,'rgba(255,246,214,0.95)');
  grd.addColorStop(0.42,'rgba(255,231,176,0.4)'); grd.addColorStop(1,'rgba(255,223,150,0)');
  scx.fillStyle=grd; scx.fillRect(0,0,128,128);
  const sunSprite=new THREE.Sprite(new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(sc), transparent:true, depthWrite:false, depthTest:false, blending:THREE.AdditiveBlending, fog:false }));
  sunSprite.scale.set(260,260,1); sunSprite.renderOrder=2; scene.add(sunSprite);

  // 🌙 달 — 분화구 radial-gradient 스프라이트(태양 반대편, 밤에 보임). 모아나 느낌 위해 밝고 또렷한 보름달 + 따뜻한 백색.
  const mc=document.createElement('canvas'); mc.width=mc.height=128; const mcx=mc.getContext('2d');
  { const r=64, mg=mcx.createRadialGradient(r*0.82,r*0.82,r*0.1, r,r,r);
    mg.addColorStop(0.00,'rgba(255,255,252,1)'); mg.addColorStop(0.70,'rgba(238,243,251,1)');
    mg.addColorStop(0.94,'rgba(220,228,242,1)'); mg.addColorStop(0.99,'rgba(208,218,236,1)'); mg.addColorStop(1.00,'rgba(208,218,236,0)');
    mcx.fillStyle=mg; mcx.fillRect(0,0,128,128);
    const craters=[[0.40,0.36,0.13],[0.62,0.55,0.16],[0.50,0.67,0.09],[0.35,0.60,0.07],[0.67,0.37,0.08],[0.47,0.47,0.05],[0.58,0.30,0.04]];
    for(const [cx,cy,cr] of craters){ const x=cx*128,y=cy*128,rad=cr*128, cg=mcx.createRadialGradient(x,y,0,x,y,rad);
      cg.addColorStop(0,'rgba(176,186,206,0.4)'); cg.addColorStop(1,'rgba(176,186,206,0)'); mcx.fillStyle=cg; mcx.beginPath(); mcx.arc(x,y,rad,0,Math.PI*2); mcx.fill(); } }
  const moonSprite=new THREE.Sprite(new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(mc), transparent:true, depthWrite:false, depthTest:false, fog:false }));
  moonSprite.scale.set(150,150,1); moonSprite.renderOrder=2; moonSprite.visible=false; scene.add(moonSprite);   // 태양보다 살짝 작은 또렷한 보름달

  // 🌙 달무리(은은한 glow) — 보름달 둘레 청백 halo. 모아나 밤 분위기. 과하지 않게 additive.
  const hc=document.createElement('canvas'); hc.width=hc.height=128; const hcx=hc.getContext('2d');
  { const hg=hcx.createRadialGradient(64,64,0,64,64,64);
    hg.addColorStop(0.00,'rgba(220,235,255,0.55)'); hg.addColorStop(0.22,'rgba(190,215,250,0.30)');
    hg.addColorStop(0.55,'rgba(170,200,245,0.10)'); hg.addColorStop(1.00,'rgba(170,200,245,0)');
    hcx.fillStyle=hg; hcx.fillRect(0,0,128,128); }
  const moonHalo=new THREE.Sprite(new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(hc), transparent:true, depthWrite:false, depthTest:false, fog:false, blending:THREE.AdditiveBlending }));
  moonHalo.scale.set(390,390,1); moonHalo.renderOrder=1; moonHalo.visible=false; scene.add(moonHalo);

  // 🌙 달빛 directional — 밤에 바다·지형·배가 푸른 달빛을 받아 형체가 보이게. (낮엔 꺼짐)
  //   색 (0.6,0.8,1.0) 톤. 강도는 applyDayNight에서 night에 비례(낮처럼 밝지 않게 상한).
  const MOON_COL = new THREE.Color(0.6, 0.8, 1.0);
  const moonLight = new THREE.DirectionalLight(0x99c2ff, 0.0); moonLight.color.copy(MOON_COL);
  scene.add(moonLight);

  // ✨ 별 — 1500개 Points, 6색 팔레트, 밤에 페이드인, 카메라 추종(천정 극점 편중 피함)
  const dotC=document.createElement('canvas'); dotC.width=dotC.height=64; const dctx=dotC.getContext('2d');
  { const dg=dctx.createRadialGradient(32,32,0,32,32,32); dg.addColorStop(0,'rgba(255,255,255,1)'); dg.addColorStop(0.35,'rgba(255,255,255,0.7)'); dg.addColorStop(1,'rgba(255,255,255,0)'); dctx.fillStyle=dg; dctx.fillRect(0,0,64,64); }
  const starGeo=new THREE.BufferGeometry();
  const STAR_N=1500, _sp=new Float32Array(STAR_N*3), _scol=new Float32Array(STAR_N*3), STAR_R=4000;
  const STAR_HUES=[[1,1,1],[0.82,0.88,1.0],[0.72,0.80,1.0],[1.0,0.95,0.82],[1.0,0.86,0.66],[0.95,0.97,1.0]];
  for(let i=0;i<STAR_N;i++){
    const th=Math.random()*Math.PI*2, yy=Math.random()*0.94+0.03;          // y 0.03~0.97 → 천정 극점 수렴 회피
    const rxz=Math.sqrt(Math.max(0,1-yy*yy))*STAR_R;
    _sp[i*3]=Math.cos(th)*rxz; _sp[i*3+1]=yy*STAR_R; _sp[i*3+2]=Math.sin(th)*rxz;
    const hue=STAR_HUES[(Math.random()*STAR_HUES.length)|0], b=0.45+Math.random()*0.55;
    _scol[i*3]=hue[0]*b; _scol[i*3+1]=hue[1]*b; _scol[i*3+2]=hue[2]*b;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(_sp,3));
  starGeo.setAttribute('color',    new THREE.BufferAttribute(_scol,3));
  const starMat=new THREE.PointsMaterial({ map:new THREE.CanvasTexture(dotC), size:2.6, sizeAttenuation:false, vertexColors:true, transparent:true, opacity:0, depthWrite:false, fog:false, blending:THREE.AdditiveBlending });
  const stars=new THREE.Points(starGeo, starMat); stars.frustumCulled=false; scene.add(stars);

  // 🌌 밤하늘 스카이박스 — sky/StarSkybox041~046.png 6면, 밤에 페이드인, 카메라 추종
  const _tl=new THREE.TextureLoader();
  const _starboxMats=['StarSkybox041','StarSkybox042','StarSkybox043','StarSkybox044','StarSkybox045','StarSkybox046']
    .map(n=>{ const t=_tl.load('/sky/'+n+'.png'); t.colorSpace=THREE.SRGBColorSpace;
      // ★재작업2: AdditiveBlending — 별 스카이박스의 검은 배경이 하늘 돔을 occlude하지 않게(박명 상단 검정 급락 원인).
      //   color scalar(=_starFade)로 페이드. 검정 픽셀은 가산 0 → 하늘 그대로 비침. 별만 더해짐.
      return new THREE.MeshBasicMaterial({ map:t, side:THREE.BackSide, depthWrite:false, fog:false, color:0x000000, transparent:true, blending:THREE.AdditiveBlending }); });
  const starbox=new THREE.Mesh(new THREE.BoxGeometry(9000,9000,9000), _starboxMats);
  starbox.frustumCulled=false; starbox.renderOrder=-2; starbox.visible=false; scene.add(starbox);

  applySky();

  // ☁️ 하늘 돔 fbm 구름(반구 안쪽). tint/uniform로 폭풍 제어. (공중버그 수정본 — 평면 투영 좌표)
  const cloudMat = new THREE.ShaderMaterial({
    side:THREE.BackSide, transparent:true, depthWrite:false, fog:false,
    uniforms:{ time:{value:0}, coverage:{value:0.4}, density:{value:1.0}, opacity:{value:0.9}, storm:{value:0}, daylight:{value:1.0}, tint:{value:new THREE.Color(0xd0d4da)}, sunDir:{value:new THREE.Vector3(0,0.5,0.86)} },
    vertexShader:`varying vec3 vN;void main(){vN=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vN;uniform float time,coverage,density,opacity,storm,daylight;uniform vec3 tint;uniform vec3 sunDir;
      float random(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}
      float noise(vec2 st){vec2 i=floor(st),f=fract(st);float a=random(i),b=random(i+vec2(1.0,0.0)),c=random(i+vec2(0.0,1.0)),d=random(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;}
      float fbm(vec2 st){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise(st);st*=2.0;a*=0.5;}return v;}
      void main(){
        vec3 d=normalize(vN);
        vec2 cuv = d.xz / (abs(d.y) + 0.3);
        vec2 p = cuv*2.6; p.x += time*0.012;
        float n=fbm(p);
        float cloud=smoothstep(coverage,coverage+0.16,n)*density;
        float cov=mix(cloud, mix(cloud,1.0,storm), storm);
        float horizon=mix(smoothstep(0.02,0.20,d.y), smoothstep(-0.04,0.10,d.y), storm)*step(-0.02,d.y);
        // 밤엔 구름이 어둑하게 보이도록 daylight(0~1)로 tint 곱(폭풍은 별도 tint 유지). 밤+맑음 구름은 거의 안 보이게.
        vec3 col = tint * mix(0.18, 1.0, daylight);
        float a = cov*opacity*horizon * mix(mix(0.35,1.0,daylight), 1.0, storm);   // 밤+맑음 구름 옅게, 폭풍이면 항상 진하게
        gl_FragColor=vec4(col, a); }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5000,40,24), cloudMat);
  scene.add(dome);
  cloudMat.uniforms.sunDir.value.copy(sunV).normalize();

  // ───────── day-night 사이클 ─────────
  // mas src/main.js 검증 공식. dayTime으로 태양 동→서 궤도 + 조명/하늘/별/달 연동.
  const DAY_LENGTH = 1200;                  // 하루 길이(초) — 20분
  let dayTime = 0.10;                        // 0=일출(동) 0.25=정오 0.5=일몰(서) 0.75=자정. 아침에서 시작
  let timeScale = 1;                         // 디버그 배속(\키)
  // ★ 시간 트윈(N키 부드러운 낮↔밤 전환) — 즉시 점프(setTime) 대신 목표까지 dayTime을
  //   원형(짧은 호) 경로로 ease 보간. 전환 중 일출/일몰(horizon) 구간을 반드시 지나
  //   석양/여명이 화면에 보이게 한다. _tween.active일 때만 update에서 진행.
  const _tween = { active:false, from:0, to:0, dur:5.0, el:0 };
  // ★ 천체는 항상 시간 전진(해 지고→자정→동이 틈→정오)으로 보간 — 밤→낮 전환이 일출(여명)을 거친다.
  //   (최단 원형 거리로 하면 밤→낮이 일몰을 거꾸로 되감아 '동트는' 게 아니라 어색했음)
  function _fwdDelta(a,b){ return ((b-a)%1+1)%1; }   // a→b 전진(증가) 거리 0~1
  function tweenTime(target, seconds){
    target=((target%1)+1)%1;
    _tween.from=dayTime; _tween.to=target; _tween.dur=Math.max(0.5,seconds||5.0); _tween.el=0; _tween.active=true;
  }
  // 조명 기준색 (mas 공식)
  const SUN_COL_DAY = new THREE.Color(0xfff1d4), SUN_COL_SET = new THREE.Color(0xff6a26);
  // ★밤 천공색 보강: 0x223044(너무 어두움 → 바다·지형 깜깜)을 은은한 달빛 청회(0x4a5e7e)로.
  //   달빛 받은 밤 분위기 유지하되 형체가 보이는 밝기. (intensity는 _hemiBase가 별도로 조절)
  const HEMI_SKY_DAY = new THREE.Color(0xffffff), HEMI_SKY_NIGHT = new THREE.Color(0x4a5e7e);
  const _sunCol = new THREE.Color();
  // wind.js가 폭풍 시 sun/hemi.intensity를 직접 lerp로 덮어쓰므로, day-night은 "기준값"을 ctx에 저장.
  // wind.js 폭풍 복원 타겟(_sun0/_hemi0)은 init 시점(낮) 캡처라 시간과 어긋날 수 있으니, day-night이 매 프레임 기준을 다시 적용한다.

  function applyDayNight(){
    const phi = dayTime * Math.PI * 2;                 // 0=일출(동쪽 +X)
    // Sky elevation/azimuth로 환산: sunDir=(cos phi, sin phi, 0.22) → elevation=asin(y), azimuth=atan2(z,x)
    const sx=Math.cos(phi), sy=Math.sin(phi), sz=0.22;
    const len=Math.hypot(sx,sy,sz);
    const elev = sy/len;                                // -1..1 (지평선 위=양수)
    P.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(elev,-1,1)));
    P.azimuth   = THREE.MathUtils.radToDeg(Math.atan2(sz, sx));

    // ═══════ ★통합 천체 상태(단일 곡선) — 모든 시각 요소가 이 셋만 참조 ═══════
    //   elev = 태양 고도(-1~1). 물리 순서를 한 곳에서 정의해 하늘·조명·밤하늘·별·바다가 전부 동기:
    //     day(낮 정도) · horizon(노을 정도) · night(밤 정도). night는 밤하늘 crossfade(volN)와 '동일 값'.
    //   이렇게 단일화하면 "태양 빨간데 어두움(순서)" "밤하늘 짠하고(급발진)" "맞물림"이 구조적으로 사라진다.
    // ═══════ ★날씨/하루 시스템 — 단일 연속 곡선(처음부터 재설계, 하루가 끊김없이 이어짐) ═══════
    //   태양 고도(elev, -1~1) 하나에서 모든 상태를 '연속 함수'로 도출 — 임계·토글·급변 일절 없음.
    //   ★핵심(사령관): 해가 지평선을 넘어가도(elev<0) 박명이 한동안 밝게 유지되다 '천천히' 어두워진다.
    const _sm = (a,b,x)=>{ x=THREE.MathUtils.clamp((x-a)/(b-a),0,1); return x*x*x*(x*(x*6-15)+10); };  // smootherstep a→b
    // 낮 밝기: 해 지평선 위(+0.10)면 완전 낮 → 지평선 한참 아래(-0.25)까지 '박명'으로 서서히 어두워짐.
    //   해가 막 진 순간(elev≈0)에도 day≈0.8 → 천천히 0으로. 갑자기 어두워지지 않는다.
    const day     = _sm(-0.25, 0.10, elev);
    const night   = 1 - day;                       // 밤 = 낮의 정확한 반대(동일 곡선) → 완전 연속, 이음새 0
    // 노을: 해가 지평선 부근(±0.22)일 때 붉게(일출·일몰 모두). 부드러운 삼각 + smootherstep.
    const _hr     = THREE.MathUtils.clamp(1 - Math.abs(elev)/0.22, 0, 1);
    const horizon = _hr*_hr*(3.0-2.0*_hr);
    // ★ 노을 색 강도: horizon이 강할수록(지평선 가까울수록) 더 붉게. 태양이 정확히 지평선일 때 1.0.

    // exposure: 정오 밝게 → 밤 어둑. 폭풍은 setStorm이 별도로 더 깎음(둘 중 더 어두운 쪽).
    // ★밤 노출 하한 0.18→0.30: 0.18은 배·지형·바다를 톤매핑서 완전 검정으로 짓눌렀음.
    //   0.30이면 달빛 받은 형체가 보이되 여전히 밤(낮 0.62보다 충분히 어두움).
    //   ★노을 구간 살짝 밝게(+horizon*0.08): 석양 하늘이 충분히 화사하게 보이되 과노출 방지.
    // ★순서 수정: 태양이 아직 빨갛게(horizon↑) 남아있는데 하늘이 먼저 어두워지던 문제.
    //   노을 기여를 0.08→0.26으로 키워 '태양 빨간 동안은 하늘도 밝게' 유지 → 노을이 사라진 뒤에야 어두워진다.
    // ★아트통일: 낮 노출 0.72(전체 명도 통일). ★밤버그2(사령관 한 단계 더↓): 밤 하한 0.24→0.21로 낮춰
    //   원경 바다/수평선 navy가 ACES서 들뜨던 것 추가 억제(한밤중답게). 배 emissive·물 달빛윤슬·hemi로 형체 유지.
    //   ★낮 정점 0.72 절대 불변: day 기여 0.48→0.51로 보정(0.21+0.51=0.72). 노을 0.26 유지.
    P.exposureBase = 0.21 + day*0.51 + horizon*0.26;    // 밤 0.21 ~ 낮 0.72, 노을 동안 충분히 밝게(순서 보존)
    // 노을: 지평선 부근에서 turbidity/rayleigh 크게 올려 붉은 산란 풍부히(폭풍 없을 때 기준)
    //   ★turbidity 6→6+horizon*9, rayleigh 2.6→2.6+horizon*2.4 (직전 *5/*1.2 대비 강화)
    //   → 일몰 하늘 주황·붉음이 더 진하고 그라데이션이 깊다.
    P.turbidityBase = 6 + horizon*9;                    // 노을 turbidity↑ → 짙은 붉은 기운
    P.rayleighBase  = 2.6 + horizon*2.4;

    // 조명 — mas 공식 (폭풍이 아닐 때 적용; 폭풍 중엔 wind.js가 덮어씀)
    // ★재작업4(사령관 종합): 전경 사물 환경광을 곡선 전체에서 정비 — 낮 또렷↑, 박명 천천히, 깊은밤 어둑.
    //   하늘(nightsky)과 사물(hemi/sun)이 박명→깊은밤 같은 곡선으로 함께 하강(하늘만 밝음/사물만 어둠 제거).
    //   ★박명 보존 곡선: 해가 막 져도(elev<0) 사물이 검은 실루엣으로 급락 안 하게, sky의 skyDark와 같은 속도로.
    //   dusk = 박명 밝기 보존(해 지평선 위~약간 아래까지 천천히 0). day와 달리 elev<0에서도 한동안 유지.
    const dusk = _sm(-0.18, 0.18, elev);                  // 해 막 진 뒤에도 한동안 높게(사물 형체 유지)
    // sun: 낮 직사광. 해 지면 0이지만, 박명엔 hemi가 받쳐줌(아래). 노을색은 _sunCol.
    ctx.sky._sunBase  = Math.max(0, elev)*1.55 + 0.04;
    // hemi(섬·지형·배 환경광):
    //   ★낮 사물 또렷↑: day 기여 0.95→1.15 (정오 hemi 1.17→1.47). 낮 배·섬 생기. (hemi는 사물 메시만 — 하늘/바다색 비퇴행)
    //   ★박명 천천히: dusk 기여 추가(0.32) → 해 막 진 박명대 사물이 하늘 박명과 같이 은은히 보임(검정 급락 X).
    //   ★깊은밤 어둑: night 기여 0.18 유지(달빛 directional이 형체 담당). 하늘이 어두워졌으므로 사물도 어둑.
    ctx.sky._hemiBase = 0.30 + day*1.15 + dusk*0.32*(1.0-day) + night*0.18;
    // ★fill light(역광 음영 채우기): 낮에만 켜짐. 태양 반대쪽 약한 방향광으로 배·캐릭터 그늘면을 들어올림.
    //   ★재작업2: 0.55→0.70(안쪽 벽 더 채움). day에 비례(정오 최대 0.70), 밤엔 0. 입체감 위해 sun보다 약하게.
    ctx.sky._fillBase = day*0.70;
    // ★재작업2: fill directional이 못 닿는 선체 내부 깊은 면을 위한 약한 ambient(낮 한정, 정오 0.12).
    //   입체감 안 죽는 최소치 — 검정 죽음만 방지. 밤엔 0(밤 톤 비퇴행).
    ctx.sky._ambBase = day*0.30;   // 🌑 2026-07-24 0.12→0.30: 나무 캐노피 아랫면·안쪽이 검게 죽던 것(val 0.24) 완화. hemi로 안 닿는 면을 전방향 채움.
    _sunCol.copy(SUN_COL_DAY).lerp(SUN_COL_SET, horizon);
    if(!ctx.wind || !ctx.wind.raining){
      if(sun){ sun.intensity = ctx.sky._sunBase; sun.color.copy(_sunCol); }
      if(hemi){ hemi.intensity = ctx.sky._hemiBase;
        // 밤 hemi 천공색을 너무 어둡지 않은 청회색으로(기존 0x223044 → 형체 안 보임).
        hemi.color.copy(HEMI_SKY_DAY).lerp(HEMI_SKY_NIGHT, night); }
      if(fill){ fill.intensity = ctx.sky._fillBase;
        // fill은 태양 정반대 방향에서 비춤(역광면 채우기). 태양 위치(sunV)의 반대.
        fill.position.set(-sunV.x*600, Math.max(120, sunV.y*400+200), -sunV.z*600); }
      if(amb) amb.intensity = ctx.sky._ambBase;            // 안쪽 깊은 면 검정 죽음 방지(낮 한정)
    } else {
      if(fill) fill.intensity = ctx.sky._fillBase*0.4;   // 폭풍 중엔 약하게(강도는 대략 — wind.js가 sun/hemi만 소유)
      if(amb) amb.intensity = ctx.sky._ambBase*0.5;
      // 폭풍 중에도 색조는 시간대 반영(강도는 wind.js 소유)
      if(sun) sun.color.copy(_sunCol);
      if(hemi) hemi.color.copy(HEMI_SKY_DAY).lerp(HEMI_SKY_NIGHT, night);
    }

    // 천체 표시
    // ★일출/일몰 occlusion(사령관): 태양 스프라이트가 depthTest off라 수평선 아래서도 바다 위로 투명하게 비쳤다.
    //   → elev로 opacity fade: 수평선 막 넘을 때(elev 0~0.04) 서서히 등장, 아래(elev<0)면 0. "바다서 솟는 투명" 제거.
    //   (sunV 방향·조명·water 윤슬은 불변 — 스프라이트 가시성만 손댐)
    const _sunRise = THREE.MathUtils.smoothstep(elev, 0.0, 0.04);   // 수평선 위로 올라온 뒤에만 보임
    // ⛏️2026-07-22 던전 버그 (사령관 "던전인데 하늘에 달이랑 해 지나가는 게 보임")
    //   해·달·후광 스프라이트는 **depthTest:false** 라 던전 천장이 있어도 그 위에 그려진다.
    //   기밀검사(광선이 바깥으로 새는가)로는 절대 못 잡는 종류다 — 구멍이 아니라 렌더 순서 문제이기 때문.
    //   ⇒ 던전 안이면 하늘 요소를 통째로 끈다. 별·별박스도 같은 이유로 함께 끈다.
    const _inDg = !!(ctx.dungeon && ctx.dungeon.active);
    sunSprite.visible = !_inDg && (_sunRise > 0.001) && (!ctx.wind || !ctx.wind.raining || ctx.sky._stormK<0.55);
    ctx.sky._sunRise = _sunRise;   // setStorm/아래 opacity 합성용
    // ★ 석양 태양 글로우: 지평선 가까이(horizon↑)서 태양 스프라이트를 따뜻한 주황으로 물들여
    //   지는 해가 붉게 타오르게(노을과 동기). 정오(horizon=0)엔 흰빛 유지.
    sunSprite.material.color.copy(_SUN_GLOW_DAY).lerp(_SUN_GLOW_SET, horizon);
    sunSprite.material.opacity = (ctx.sky._stormActive ? Math.max(0,1-ctx.sky._stormK*1.6) : 1.0) * _sunRise;
    // 달 스프라이트/달무리: 달 고도(=-elev, 즉 태양 아래일 때 달 위)로 fade. 달이 수평선 아래면 0.
    //   달 실제 정렬방향 y(_moonAlign)가 있으면 그걸, 없으면 -elev 사용(달=태양 반대).
    const _moonY = (ctx.sky._moonAlign ? ctx.sky._moonAlign.y : -elev);
    const _moonRise = THREE.MathUtils.smoothstep(_moonY, -0.02, 0.10);   // 월출: 수평선 막 넘을 때 서서히
    ctx.sky._moonRise = _moonRise;
    moonSprite.visible = !_inDg && (elev < 0.08) && (_moonRise > 0.001);
    moonHalo.visible   = moonSprite.visible;
    // ═══════ ★B-1 별 3종 — 전부 유지, 단일 night 곡선 공유 페이드(2-4). "짠" 등장 제거 ═══════
    //   nightsky 볼류 별(셰이더, uNight) + Points 1500 + starbox 스카이박스 — 셋이 같은 night 곡선으로
    //   함께 서서히 페이드인. 이중상쇄(night*(1-volN))·하드상한(volN<0.99) 폐지.
    // ★재작업3(사령관 구름버그): (1) 별 늦게 등장 — _starFade를 smoothstep(0.45,0.95,night) 늦은 곡선으로
    //   (박명엔 거의 0, 깊은밤에 서서히). (2) 과밝기/뿌옇음 제거 — starbox 가중 0.85→0.22(은하수 은은한 배경),
    //   Points 0.6→0.45(작고 또렷한 점). 셋(볼류 0.7·Points 0.45·starbox 0.22) 동일 곡선 공유 → 선등장·뿌옇음 없음.
    // ★밤버그2: 하늘이 더 어두워졌으니 별 대비 유지 위해 Points 가중 0.45→0.52 살짝↑(과밝기 아님 — 또렷함 보정).
    const STAR_W1 = 0.52;  // Points 별 가중(어두운 하늘서 또렷하게)
    const STAR_W2 = 0.22;  // starbox 가중(은하수는 은은한 배경 — 허옇게 들뜨지 않게 대폭↓)
    const _starFade = THREE.MathUtils.smoothstep(night, 0.45, 0.95);   // ★늦은 등장 곡선(볼류 starVis와 정합)
    starMat.opacity = _starFade * STAR_W1;
    stars.visible   = !_inDg && _starFade > 0.002;                 // ⚡낮엔 draw 제출 자체 스킵 + 던전 안에선 항상 꺼짐
    starbox.visible = !_inDg && _starFade > 0.002;                 // 박명엔 사실상 꺼짐 + 던전 안에선 항상 꺼짐
    for(const m of _starboxMats) m.color.setScalar(_starFade * STAR_W2);
    // ★B-1: nightsky 돔이 유일한 하늘. 단일 dayTime 곡선(day/night/horizon)+태양방향을 매 프레임 주입.
    //   → 낮 파랑·태양, 노을 주황, 밤 남색+별/달/구름이 한 곡선으로 연속(three.js Sky 불필요).
    //   별/구름 페이드는 night 곡선(제곱·하드토글 제거 → 점진).
    if(ctx.nightsky && ctx.nightsky.setDayNight) ctx.nightsky.setDayNight(day, night, horizon, sunV);
    else if(ctx.nightsky) ctx.nightsky.setNight(night);
    // 볼류 밤하늘이 자체 달/달무리를 그리므로, 스프라이트 달은 밤 깊을수록 끔(이중 달 방지).
    if(night>0.6){ moonSprite.visible=false; moonHalo.visible=false; }
    cloudMat.uniforms.daylight.value = day;             // fbm 낮 구름 밤엔 어둑
    dome.visible = night < 0.85;                         // 밤 깊으면 fbm 구름 돔도 끔(볼류 구름이 대신)

    // ★ 수평선 톤 통일 — 안개/배경색을 Shadertoy 밤 수평선 톤(짙은 청)으로 끌어내려
    //   원경 바다가 볼류 하늘과 한 색으로 이어지게. (폭풍 중엔 wind.js가 fog 소유 → 손대지 않음)
    if(!ctx.sky || !ctx.sky._stormActive){
      const horizonNight = _NIGHT_HORIZON;             // ≈ getSkyColour 수평선값(0.3*skyColour 부근)
      // 기본: 낮 안개색 → 밤 수평선색 (night 따라).
      _fogTmp.copy(_DAY_FOG).lerp(horizonNight, night);
      // ★ 석양 안개 틴트: 일출/일몰(horizon) 구간엔 수평선 안개/배경을 따뜻한 노을색으로 물들임.
      //   주황(_SUNSET_WARM)을 horizon 강도로 섞어, 원경 바다·하늘 경계가 붉게 타오르는 석양.
      //   낮 한가운데(horizon=0)·깊은 밤(night=1)에는 영향 0 → 기존 톤 보존.
      const setMix = horizon * (1.0 - night*0.6);
      if(setMix>0.001) _fogTmp.lerp(_SUNSET_WARM, setMix*0.80);   // ★0.55→0.80: 석양 노을 더 붉게(원경 안개)
      if(scene.fog){ scene.fog.color.copy(_fogTmp); }
      if(scene.background && scene.background.isColor){ scene.background.copy(_fogTmp); }
    }

    // 🌙 볼류메트릭 밤하늘 달 = 영화 톤(구름 덱 위 낮은 보름달). 방위는 게임 달(moonV)과 정렬,
    //    고도는 0.28 고정(천정으로 솟지 않게). 이 달 방향을 water·sprite의 단일 기준으로 삼는다.
    let moonAlignDir = moonV;                                    // 폴백
    if(ctx.nightsky){ const mv=moonV.clone().normalize();
      // ★달도 실제 천체 궤도로(월출/월몰): 고도 고정(0.55) 폐지 → 실제 mv.y 사용.
      //   달=태양 정반대(moonV=-sunV)라, 해가 서쪽으로 지면 달이 동쪽 지평선에서 떠올라(고도 0→+)
      //   하늘을 가로질러 자정에 천정, 새벽에 진다 — 사령관이 원한 "한쪽에서 달이 올라오는" 자연스러운 월출.
      //   water uMoonDir·달빛 윤슬·달 스프라이트가 moonDir()을 단일 기준으로 쓰므로 모두 같은 실제 위치로 동기.
      ctx.nightsky.setMoon(Math.atan2(mv.z, mv.x), mv.y);
      moonAlignDir = ctx.nightsky.moonDir();                     // = (cos loc, mv.y, sin loc) ≈ 실제 달 방향
    }
    // 스프라이트 달·달무리도 같은 높은 방향으로(volN<0.6 전환 구간서 볼류 달과 위치 일치).
    ctx.sky._moonAlign = (ctx.sky._moonAlign||new THREE.Vector3()).copy(moonAlignDir).normalize();
    // 🌊 바다에 밤/달빛 주입 — uNight + 달/태양 방향. 달빛 윤슬을 볼류 하늘 달과 같은 방향으로.
    if(ctx.water && ctx.water.mat.uniforms){ const wu=ctx.water.mat.uniforms;
      wu.uNight.value = night;
      wu.uMoonDir.value.copy(moonAlignDir).normalize();
      wu.uSunDir.value.copy(sunV).normalize();
      // ★바다 fresnel 반사색 = 현재 하늘 수평선색(_fogTmp, 노을·밤 포함) → 바다가 하늘과 한 톤으로 일관.
      if(wu.uHorizonCol) wu.uHorizonCol.value.copy(_fogTmp);
    }
    // 🌙 달빛 directional 갱신 — 달 방향에서 비추게 위치 + night 비례 강도(상한 0.55, 낮처럼 안 밝게).
    if(!ctx.wind || !ctx.wind.raining){
      moonLight.position.copy(moonAlignDir).multiplyScalar(800);   // 달 쪽에서 내려옴
      // ★달빛 강도를 달 실제 고도에 비례 — 달이 막 떠오를 땐(지평선 근처) 약하고, 높이 뜰수록 밝게.
      //   '먼저 어두워졌다가, 달이 한쪽서 떠오르며 점점 밝아지는' 자연스러운 월출(사령관 요청).
      const moonUp = THREE.MathUtils.clamp(moonAlignDir.y*1.3, 0, 1);
      moonLight.intensity = (0.10 + 0.50*moonUp) * night;          // 막 뜰 때 은은 → 천정 보름달 밝게
    } else { moonLight.intensity = 0; }
    ctx.sky._night = night;

    // 🌙 달 가시성 강화 — 밤에 또렷한 보름달. 밝기/크기/달무리를 night에 비례해 키움.
    //   ★월출 occlusion: _moonRise(달 고도 fade) 곱 — 달이 수평선 아래면 0(바다서 투명하게 안 비침).
    { const mb = THREE.MathUtils.clamp(night*1.25, 0, 1) * (ctx.sky._moonRise!=null?ctx.sky._moonRise:1);
      moonSprite.material.opacity = mb;
      moonHalo.material.opacity   = mb*0.55;
      // ★달 축소: 150~190 → 96~118. 멀리 떠있는 작은 보름달(볼류 달 각크기와 정합).
      //   sprite는 전환 구간(volN<0.6)에만 보이므로 노을→초저녁의 작은 달 인상을 만든다.
      const ms = 96 + night*22;
      moonSprite.scale.set(ms, ms, 1);
      moonHalo.scale.set(ms*2.4, ms*2.4, 1);
    }

    // 폭풍이 아니면 day-night이 Sky 파라미터 소유. 폭풍이면 setStorm이 노을/exposure 위에 덮어씀.
    if(!ctx.sky._stormActive){
      P.turbidity = P.turbidityBase; P.rayleigh = P.rayleighBase; P.exposure = P.exposureBase;
      applySky();
    } else {
      // 폭풍 중: 태양 방향(elevation/azimuth)만 갱신, 어둡기/탁도는 setStorm 값 유지하되 밤이면 더 어둡게.
      applySky();
      renderer.toneMappingExposure = Math.max(0.05, Math.min(renderer.toneMappingExposure, P.exposureBase));
    }
  }

  // 🌧️ 폭풍 강도 0(맑음)~1(폭풍) — 시간과 독립. 현재 시간대의 노을/밝기 위에 어둠을 더한다.
  function setStorm(k){ k=Math.max(0,Math.min(1,k));
    ctx.sky._stormK = k; ctx.sky._stormActive = k>0.001;
    // 시간대 기준값(applyDayNight가 매 프레임 갱신) 위에 폭풍 가중.
    const tBase = P.turbidityBase!=null?P.turbidityBase:6, rBase = P.rayleighBase!=null?P.rayleighBase:2.6, eBase = P.exposureBase!=null?P.exposureBase:0.62;
    P.turbidity = tBase + k*14; P.rayleigh = Math.max(0.3, rBase - k*2.2);
    P.mieCoefficient = 0.003 + k*0.06;
    P.exposure = Math.max(0.05, eBase - k*0.30);          // 밤+폭풍이면 eBase가 이미 낮아 더 어둡게 합성(완전 검정 방지 하한)
    applySky();
    // ★일출 occlusion 보존: 폭풍 opacity에도 _sunRise(수평선 위 fade) 곱 — 수평선 아래 태양 안 비침.
    sunSprite.material.opacity = Math.max(0, 1 - k*1.6) * (ctx.sky._sunRise!=null?ctx.sky._sunRise:1);
    // sunSprite.visible은 applyDayNight가 시간·폭풍 함께 판단
    cloudMat.uniforms.coverage.value = 0.52 - k*0.34;
    cloudMat.uniforms.density.value  = 1.0;
    cloudMat.uniforms.opacity.value  = 0.85 + k*0.15;
    cloudMat.uniforms.storm.value    = k;
    cloudMat.uniforms.sunDir.value.copy(sunV).normalize();
    // 🌩️ 볼류메트릭 밤하늘에도 폭풍 전달 — 밤+폭풍이면 볼류 구름이 먹구름이 되어 달/별을 가린다.
    if(ctx.nightsky && ctx.nightsky.setStorm) ctx.nightsky.setStorm(k);
    // 🌊 바다에도 폭풍 전달 — 밤 팔레트 위에 storm 어둠 합성(밤+폭풍 거친 청회 바다).
    if(ctx.water && ctx.water.mat.uniforms && ctx.water.mat.uniforms.uStorm) ctx.water.mat.uniforms.uStorm.value = k;
    cloudMat.uniforms.tint.value.setRGB(0.86-k*0.58, 0.88-k*0.59, 0.92-k*0.60);
  }

  // 시간 제어 API
  function setTime(t){ dayTime = ((t%1)+1)%1; applyDayNight(); return dayTime; }
  function getTime(){ return dayTime; }

  ctx.onUpdate(dt=>{
    if(_tween.active){
      // ★ N키 부드러운 전환: from→to 최단호를 smoothstep(ease in-out)로 보간.
      //   horizon(일출/일몰) 구간을 지나며 석양/여명이 펼쳐진다. 끝나면 자연 시간흐름 복귀.
      _tween.el += dt;
      let s = Math.min(1, _tween.el/_tween.dur);
      const e = s*s*(3.0-2.0*s);                          // smoothstep ease
      dayTime = ((_tween.from + _fwdDelta(_tween.from,_tween.to)*e)%1+1)%1;
      if(s>=1){ _tween.active=false; dayTime=_tween.to; }
    } else {
      dayTime = (dayTime + (dt*timeScale)/DAY_LENGTH) % 1;
    }
    applyDayNight();
    if(ctx.sky._stormActive) setStorm(ctx.sky._stormK);    // 폭풍 중이면 시간 갱신 후 폭풍 어둠 재합성
    cloudMat.uniforms.time.value += dt;
    dome.position.set(camera.position.x, 0, camera.position.z);
    sunSprite.position.copy(camera.position).addScaledVector(sunV, 2600);
    // 달 스프라이트·달무리 = 볼류 달과 같은 높은 정렬방향(_moonAlign). 하늘 달·물 달빛과 위치 동기.
    const _ma = ctx.sky._moonAlign || moonV;
    moonSprite.position.copy(camera.position).addScaledVector(_ma, 2600);
    moonHalo.position.copy(camera.position).addScaledVector(_ma, 2600);
    stars.position.copy(camera.position);
    starbox.position.copy(camera.position);
  });

  ctx.sky={ dome, sunSprite, moonSprite, moonHalo, stars, starbox, setStorm, setTime, getTime, tweenTime,
            get tweening(){ return _tween.active; },
            sunDir:sunV, moonDir:moonV, params:P,
            _stormK:0, _stormActive:false, _sunBase:1.45, _hemiBase:1.15, _fillBase:0, _ambBase:0, _sunRise:1, _moonRise:1, _night:0,
            get night(){ return this._night; },
            get dayTime(){ return dayTime; }, set dayTime(v){ setTime(v); },
            get timeScale(){ return timeScale; }, set timeScale(v){ timeScale=v; } };
  applyDayNight();
  return ctx.sky;
}
