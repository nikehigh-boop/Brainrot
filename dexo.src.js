// Dexo: the Brainrot Dex mascot. An original brain-bot, built and animated in three.js.
// mount(canvas, {fixedTime}) -> {react(kind), setMood(mood), renderAt(t), dispose()}
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const LIME = new THREE.Color('#c5f33c'), MAG = new THREE.Color('#ff3df0'), CYAN = new THREE.Color('#3df0ff');
const sm = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// ---- LED face on the visor (drawn on a canvas, glows through bloom) ----
function makeFace() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'), tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
  function draw(o) {
    g.clearRect(0, 0, 512, 256);
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
    // faint scanlines for a display feel
    g.fillStyle = 'rgba(197,243,60,.05)'; for (let y = 0; y < 256; y += 6) g.fillRect(0, y, 512, 2);
    g.shadowColor = '#c5f33c'; g.shadowBlur = 26; g.fillStyle = '#d8ff6a';
    const ex = 150 + o.lookX * 34, ey = 118 + o.lookY * 20, gap = 212;
    for (const s of [0, 1]) {
      const x = ex + s * gap;
      if (o.mood === 'happy') {  // ^ ^ eyes
        g.lineWidth = 22; g.lineCap = 'round'; g.strokeStyle = '#d8ff6a';
        g.beginPath(); g.arc(x, ey + 22, 40, Math.PI * 1.12, Math.PI * 1.88); g.stroke();
      } else if (o.mood === 'wow') {  // big round eyes
        g.beginPath(); g.arc(x, ey, 46, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#000'; g.shadowBlur = 0; g.beginPath(); g.arc(x + 10, ey - 10, 12, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#d8ff6a'; g.shadowBlur = 26;
      } else {
        const h = Math.max(10, 96 * (1 - o.blink));
        rr(x - 36, ey - h / 2, 72, h, 30);
      }
    }
    if (o.mood === 'happy' || o.mood === 'wow') {  // little mouth
      g.lineWidth = 12; g.lineCap = 'round'; g.strokeStyle = '#d8ff6a';
      g.beginPath(); g.arc(256 + o.lookX * 20, 186, 26, Math.PI * .15, Math.PI * .85); g.stroke();
    }
    tex.needsUpdate = true;
  }
  return { tex, draw };
}

// ---- brain: smooth sphere with ridged folds and a centre fissure ----
function brainGeometry() {
  let geo = new THREE.IcosahedronGeometry(0.5, 40); geo.deleteAttribute('normal'); geo.deleteAttribute('uv'); geo = mergeVertices(geo); const p = geo.attributes.position, v = new THREE.Vector3();
  const n3 = (x, y, z) => Math.sin(x * 1.7 + Math.sin(y * 2.3)) * Math.sin(y * 1.9 + Math.sin(z * 2.1)) * Math.sin(z * 2.2 + Math.sin(x * 1.6));
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); const d = v.clone().normalize();
    let f = 0, a = 1, fr = 5.5;
    for (let o = 0; o < 2; o++) { f += a * (1 - Math.abs(n3(d.x * fr, d.y * fr, d.z * fr))); a *= .45; fr *= 1.9; }
    const fold = Math.pow(f / 1.45, 1.6) * .09;
    const fissure = -.11 * Math.exp(-(d.x * d.x) / .0035) * clamp01(d.y + .35);
    const r = .5 + fold + fissure;
    v.copy(d).multiplyScalar(r); v.y *= .84; v.z *= 1.1;
    if (v.y < -.06) v.y = -.06 + (v.y + .06) * .35;  // flat underside sits in the helmet
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function mount(canvas, opts = {}) {
  const W = () => canvas.clientWidth || canvas.width, H = () => canvas.clientHeight || canvas.height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: !!opts.capture, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, opts.dpr || window.devicePixelRatio || 1));
  renderer.setSize(W(), H(), false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const bgCol = new THREE.Color(opts.bg || '#0b0d09');
  scene.background = bgCol; scene.fog = new THREE.Fog(bgCol, 10, 20);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), .04).texture;
  scene.environmentIntensity = .32;

  const cam = new THREE.PerspectiveCamera(28, W() / H(), .1, 60);
  const camBase = new THREE.Vector3(0, 2.05, 9.4), lookAt = new THREE.Vector3(0, 1.55, 0);
  cam.position.copy(camBase); cam.lookAt(lookAt);

  // lights: warm key, lime + magenta rims, soft fill
  const key = new THREE.DirectionalLight('#fff6ea', 2.0); key.position.set(3.5, 6.5, 5); key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 4, bottom: -1, near: 1, far: 20 }); key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -.0004; key.shadow.normalBias = .02;
  scene.add(key);
  scene.add(new THREE.HemisphereLight('#dfe8ff', '#0b0a10', .25));
  const rimL = new THREE.SpotLight(LIME, 9, 14, .5, .7, 1.2); rimL.position.set(-3.4, 4.2, -2.6); rimL.target.position.set(0, 1.4, 0); scene.add(rimL, rimL.target);
  const rimM = new THREE.SpotLight(MAG, 7, 14, .5, .7, 1.2); rimM.position.set(3.6, 2.6, -2.8); rimM.target.position.set(0, 1.2, 0); scene.add(rimM, rimM.target);

  // stage: shadow catcher + lime ring + soft glow
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: .55 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const stage = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.55, .08, 64), new THREE.MeshPhysicalMaterial({ color: '#0b0e09', roughness: .55, metalness: .2, clearcoat: .4, envMapIntensity: .25 }));
  stage.position.y = -.04; stage.receiveShadow = true; scene.add(stage);
  const ringMat = new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 2.2 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, .012, 8, 128), ringMat); ring.rotation.x = Math.PI / 2; ring.position.y = .002; scene.add(ring);
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128); gr.addColorStop(0, 'rgba(197,243,60,.16)'); gr.addColorStop(.6, 'rgba(197,243,60,.04)'); gr.addColorStop(1, 'rgba(197,243,60,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 5.5), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = .01; scene.add(glow);

  // materials
  const M = {
    shell: new THREE.MeshPhysicalMaterial({ color: '#1b2019', metalness: .25, roughness: .42, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: .55 }),
    trim: new THREE.MeshPhysicalMaterial({ color: '#9aa394', metalness: 1, roughness: .22, envMapIntensity: .8 }),
    dark: new THREE.MeshPhysicalMaterial({ color: '#111410', metalness: .4, roughness: .45 }),
    lime: new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 2 }),
    brain: new THREE.MeshPhysicalMaterial({ color: '#ff4fc8', roughness: .38, clearcoat: .7, clearcoatRoughness: .25, sheen: .25, envMapIntensity: .45, sheenColor: new THREE.Color('#ffd0f2'), sheenRoughness: .5, emissive: '#3a0630', emissiveIntensity: .25 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: .02, metalness: 0, transmission: 1, thickness: .25, ior: 1.45, transparent: true, opacity: 1, envMapIntensity: 1.4, specularIntensity: 1 }),
  };
  const face = makeFace();
  M.visor = new THREE.MeshPhysicalMaterial({ color: '#020302', roughness: .08, metalness: .2, clearcoat: 1, emissive: '#ffffff', emissiveMap: face.tex, emissiveIntensity: 1.8 });
  const sh = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  // ---- build Dexo ----
  const root = new THREE.Group(); scene.add(root);
  const hips = new THREE.Group(); root.add(hips);
  const legs = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(.36 * sx, .74, 0); hips.add(leg);
    leg.add(sh(new THREE.Mesh(new THREE.SphereGeometry(.15, 32, 16), M.trim)));
    const shin = sh(new THREE.Mesh(new THREE.CapsuleGeometry(.12, .34, 8, 24), M.shell)); shin.position.y = -.28; leg.add(shin);
    const foot = sh(new THREE.Mesh(new RoundedBoxGeometry(.42, .2, .6, 4, .08), M.shell)); foot.position.set(0, -.62, .07); leg.add(foot);
    const sole = new THREE.Mesh(new RoundedBoxGeometry(.43, .04, .61, 2, .02), M.lime); sole.position.set(0, -.71, .07); leg.add(sole);
    legs.push(leg);
  }
  const torso = new THREE.Group(); torso.position.y = 1.3; hips.add(torso);
  // body: smooth lathe "egg" with a pinched waist
  const prof = []; for (let i = 0; i <= 24; i++) { const t = i / 24, y = -.55 + t * 1.1; const r = .5 + .14 * Math.sin(Math.PI * t) - .05 * Math.exp(-((t - .18) ** 2) / .004); prof.push(new THREE.Vector2(Math.max(.02, r * Math.sin(Math.PI * Math.min(1, t * 1.02 + .02)) ** .35), y)); }
  const body = sh(new THREE.Mesh(new THREE.LatheGeometry(prof, 64), M.shell)); torso.add(body);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(.6, .022, 12, 96), M.lime); belt.rotation.x = Math.PI / 2; belt.position.y = -.33; belt.scale.set(.98, .98, 1); torso.add(belt);
  // chest core: recessed bezel + glowing hex
  const bezel = sh(new THREE.Mesh(new THREE.TorusGeometry(.17, .045, 16, 48), M.trim)); bezel.position.set(0, .02, .62); torso.add(bezel);
  const well = new THREE.Mesh(new THREE.CircleGeometry(.16, 48), M.dark); well.position.set(0, .02, .61); torso.add(well);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(.09, .09, .05, 6), M.lime); core.rotation.x = Math.PI / 2; core.position.set(0, .02, .63); torso.add(core);
  // arms
  const arms = [];
  for (const sx of [-1, 1]) {
    const s = new THREE.Group(); s.position.set(.66 * sx, .2, 0); torso.add(s);
    s.add(sh(new THREE.Mesh(new THREE.SphereGeometry(.17, 32, 16), M.trim)));
    const up = sh(new THREE.Mesh(new THREE.CapsuleGeometry(.1, .3, 8, 24), M.shell)); up.position.y = -.28; s.add(up);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(.105, .02, 10, 32), M.lime); cuff.rotation.x = Math.PI / 2; cuff.position.y = -.47; s.add(cuff);
    const hand = sh(new THREE.Mesh(new THREE.SphereGeometry(.15, 32, 16), M.shell)); hand.scale.set(1, .9, 1.05); hand.position.y = -.6; s.add(hand);
    arms.push(s);
  }
  // head: rounded helmet, visor display, glass dome with brain, antenna
  const neck = new THREE.Group(); neck.position.y = .6; torso.add(neck);
  neck.add(sh(new THREE.Mesh(new THREE.CylinderGeometry(.15, .19, .16, 32), M.trim)));
  const head = new THREE.Group(); head.position.y = .42; neck.add(head);
  const helmet = sh(new THREE.Mesh(new RoundedBoxGeometry(1.12, .56, .92, 6, .22), M.shell)); head.add(helmet);
  const visor = new THREE.Mesh(new RoundedBoxGeometry(.92, .38, .06, 4, .05), M.visor); visor.position.set(0, -.01, .45); head.add(visor);
  // map the face onto the visor's front only
  { const uv = visor.geometry.attributes.uv, pos = visor.geometry.attributes.position; for (let i = 0; i < uv.count; i++) { uv.setXY(i, pos.getX(i) / .92 + .5, pos.getY(i) / .38 + .5); } uv.needsUpdate = true; }
  for (const sx of [-1, 1]) { const ear = sh(new THREE.Mesh(new THREE.CylinderGeometry(.13, .13, .08, 32), M.trim)); ear.rotation.z = Math.PI / 2; ear.position.set(.58 * sx, 0, 0); head.add(ear); const led = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .09, 24), M.lime); led.rotation.z = Math.PI / 2; led.position.set(.6 * sx, 0, 0); head.add(led); }
  const collar = sh(new THREE.Mesh(new THREE.TorusGeometry(.43, .035, 16, 64), M.trim)); collar.rotation.x = Math.PI / 2; collar.position.y = .29; head.add(collar);
  const brain = sh(new THREE.Mesh(brainGeometry(), M.brain)); brain.position.y = .34; brain.scale.setScalar(.8); head.add(brain);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(.44, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2), M.glass); dome.position.y = .29; head.add(dome);
  const ant = new THREE.Group(); ant.position.set(.3, .25, -.2); head.add(ant);
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(.014, .022, .5, 12), M.trim); stalk.position.y = .25; ant.add(stalk);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(.07, 24, 16), M.lime); bulb.position.y = .52; ant.add(bulb);
  const bulbLight = new THREE.PointLight(LIME, 2.5, 2.5, 2); bulbLight.position.y = .52; ant.add(bulbLight);

  // floating motes
  const NM = 70, mg = new THREE.BufferGeometry(), mp = new Float32Array(NM * 3), seeds = [];
  for (let i = 0; i < NM; i++) seeds.push([(Math.random() - .5) * 7, Math.random(), -1.5 - Math.random() * 3, Math.random(), Math.random() < .25]);
  mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  const motes = new THREE.Points(mg, new THREE.PointsMaterial({ color: LIME, size: .045, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(motes);

  // post: bloom on the emissive parts
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), .42, .35, .92); composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- behaviour ----
  const st = { t: 0, pointer: new THREE.Vector2(), look: new THREE.Vector2(), hop: -1, wave: -1, spin: -1, mood: 'idle', moodUntil: 0, blinkAt: 1.2, blink: 0, faceKey: '' };
  const react = (k) => {
    if (k === 'hop' && st.hop < 0) st.hop = 0;
    if (k === 'wave' && st.wave < 0) st.wave = 0;
    if (k === 'spin' && st.spin < 0) st.spin = 0;
    if (k === 'happy' || k === 'wow') { st.mood = k; st.moodUntil = st.t + 2.2; }
  };
  const setMood = (m) => { st.mood = m; st.moodUntil = Infinity; };

  function pose(t, dt) {
    const TAU = Math.PI * 2;
    // procedural idle
    const breath = Math.sin(t * 2.1);
    torso.position.y = 1.3 + .028 * breath;
    torso.scale.set(1 + .008 * breath, 1 - .006 * breath, 1 + .008 * breath);
    // look: pointer when present, otherwise wander
    const wander = new THREE.Vector2(Math.sin(t * .37) * .7 + Math.sin(t * 1.1) * .15, Math.sin(t * .29 + 1) * .35);
    const target = st.pointerActive ? st.pointer : wander;
    st.look.x = damp(st.look.x, target.x, 5, dt); st.look.y = damp(st.look.y, target.y, 5, dt);
    head.rotation.y = st.look.x * .42; head.rotation.x = -st.look.y * .2; head.rotation.z = Math.sin(t * .9) * .04;
    torso.rotation.y = st.look.x * .12;
    root.rotation.y = Math.sin(t * .23) * .22 + st.look.x * .1;
    arms[0].rotation.set(Math.sin(t * 2.1) * .05, 0, -.14 - .04 * breath);
    arms[1].rotation.set(-Math.sin(t * 2.1) * .05, 0, .14 + .04 * breath);
    ant.rotation.z = Math.sin(t * 1.6) * .12; ant.rotation.x = Math.sin(t * 1.3) * .08;
    brain.rotation.y = t * .25;
    let flare = 0;
    // hop: squash, launch, land
    if (st.hop >= 0) {
      st.hop += dt; const h = st.hop;
      const crouch = h < .18 ? sm(h / .18) : h < .26 ? 1 - sm((h - .18) / .08) : 0;
      const air = h > .22 && h < .78 ? Math.sin(Math.PI * (h - .22) / .56) : 0;
      const land = h > .76 && h < 1 ? Math.sin(Math.PI * (h - .76) / .24) : 0;
      root.position.y = .7 * air;
      hips.scale.set(1 + .08 * (crouch + land * .7), 1 - .12 * (crouch + land * .7), 1 + .08 * (crouch + land * .7));
      legs.forEach((l, i) => l.rotation.x = air * .35 * (i ? 1 : -1));
      arms[0].rotation.z -= air * .9; arms[1].rotation.z += air * .9;
      flare = air;
      if (h > 1) { st.hop = -1; root.position.y = 0; hips.scale.set(1, 1, 1); }
    }
    if (st.wave >= 0) {
      st.wave += dt; const w = st.wave, up = sm(clamp01(w / .3)) * sm(clamp01((1.9 - w) / .3));
      arms[1].rotation.z = .14 + up * 2.65; arms[1].rotation.x = up * (.15 + .32 * Math.sin(w * 15));
      head.rotation.z += up * .1;
      if (w > 1.9) st.wave = -1;
    }
    if (st.spin >= 0) {
      st.spin += dt; const s = st.spin;
      root.rotation.y += TAU * sm(clamp01(s / 1.1));
      root.position.y = Math.max(root.position.y, .25 * Math.sin(Math.PI * clamp01(s / 1.1)));
      if (s > 1.1) st.spin = -1;
    }
    // eyes: blink on a jittered timer
    if (t > st.blinkAt) { st.blink = 1; st.blinkAt = t + 2.2 + ((t * 7.13) % 1) * 2.8; }
    st.blink = Math.max(0, st.blink - dt * 7);
    if (st.moodUntil < t) { st.mood = 'idle'; st.moodUntil = 0; }
    const fk = `${st.mood}|${Math.round(st.look.x * 20)}|${Math.round(st.look.y * 20)}|${Math.round(st.blink * 8)}`;
    if (fk !== st.faceKey) { st.faceKey = fk; face.draw({ mood: st.mood, lookX: st.look.x, lookY: st.look.y, blink: sm(Math.min(1, st.blink * 1.6)) }); }
    // lights + glow
    const pulse = .5 + .5 * Math.sin(t * 3.2);
    M.lime.emissiveIntensity = 1.1 + .6 * pulse + 2 * flare;
    ringMat.emissiveIntensity = 1.2 + .8 * pulse + 2.5 * flare;
    bulbLight.intensity = .8 + 1.2 * pulse;
    core.rotation.y = t * 1.4;
    glow.material.opacity = .75 + .25 * pulse; glow.scale.setScalar(1 + .3 * flare);
    rimL.intensity = 8 + 3 * Math.sin(t * .8);
    // camera drift
    cam.position.set(camBase.x + Math.sin(t * .19) * .3, camBase.y + Math.sin(t * .23) * .08, camBase.z);
    cam.lookAt(lookAt);
    for (let i = 0; i < NM; i++) { const [x, y0, z, ph] = seeds[i]; const u = (t * .08 + ph) % 1; mp[i * 3] = x + .2 * Math.sin(TAU * (u * 2 + ph)); mp[i * 3 + 1] = (y0 + u) * 5 - .5; mp[i * 3 + 2] = z; }
    mg.attributes.position.needsUpdate = true;
  }

  // input
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; st.pointer.set(clamp01((p.clientX - r.left) / r.width) * 2 - 1, -(clamp01((p.clientY - r.top) / r.height) * 2 - 1)); st.pointerActive = true; clearTimeout(st.pt); st.pt = setTimeout(() => { st.pointerActive = false }, 2500); };
  const raycaster = new THREE.Raycaster();
  const onTap = (e) => {
    const r = canvas.getBoundingClientRect(), v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(v, cam);
    const hit = raycaster.intersectObject(root, true)[0];
    if (!hit) return;
    if (hit.object === brain || hit.object === dome) { react('spin'); react('wow'); }
    else if (hit.object === visor || hit.object === helmet) { react('wave'); react('happy'); }
    else { react('hop'); react('happy'); }
  };
  if (!opts.capture) { addEventListener('pointermove', onMove, { passive: true }); canvas.addEventListener('pointerdown', onTap); }

  const resize = () => { const w = W(), h = H(); if (!w || !h) return; renderer.setSize(w, h, false); composer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
    // wide panels: push Dexo right so text can sit on the left
    const wide = w > 720, sx = wide ? -Math.min(2.4, (cam.aspect - 1) * .95) : 0; camBase.set(sx, 2.05, wide ? 8.6 : 9.0); lookAt.set(sx, wide ? 1.55 : 1.22, 0); if (opts.capture) { camBase.set(0, 2.05, 9.4); lookAt.set(0, 1.55, 0); } };
  let raf = 0, last = 0, running = false;
  const frame = (now) => { raf = requestAnimationFrame(frame); const dt = Math.min(.05, last ? (now - last) / 1000 : .016); last = now; st.t += dt; pose(st.t, dt); composer.render(); };
  const start = () => { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  // deterministic render for capture: steps the sim at 60 fps up to time t
  const renderAt = (t) => { while (st.t < t) { const dt = Math.min(1 / 60, t - st.t); st.t += dt; pose(st.t, dt); } composer.render(); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; if (ro) ro.observe(canvas);
  resize();
  if (!opts.capture) start(); else { pose(0, 0); composer.render(); }
  return { react, setMood, renderAt, start, stop, dispose() { stop(); ro && ro.disconnect(); removeEventListener('pointermove', onMove); renderer.dispose(); } };
}
