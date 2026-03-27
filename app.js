/* ═══════════════════════════════════════════════════
   COSMIC SENSOR NETWORK — Application Logic
   APIs: NOAA Solar Wind · NOAA Kp · USGS Geomag
         USGS Earthquakes · NASA DONKI
   Globe: Globe.gl (npm)
   Charts: Chart.js 4.x (npm)
   ═══════════════════════════════════════════════════ */

import Globe from 'globe.gl';
import * as THREE from 'three';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

// ── NASA API KEY ───────────────────────────────────────
const NASA_KEY_STORE = 'csn_nasa_key';

/**
 * Priority: config.js (window.CSN_NASA_KEY) → localStorage → DEMO_KEY
 * config.js is local-only (.gitignore) — safest persistence.
 * localStorage popup still works as override.
 */
function getNasaKey() {
  const cfgKey = (window.CSN_NASA_KEY || '').trim();
  if (cfgKey && cfgKey !== 'DEMO_KEY') return cfgKey;
  return localStorage.getItem(NASA_KEY_STORE) || 'DEMO_KEY';
}

/** Wires up the NASA KEY button/popup in the top bar */
function initNasaKeyUI() {
  const btn    = document.getElementById('nasa-key-btn');
  const popup  = document.getElementById('nasa-key-popup');
  const input  = document.getElementById('nasa-key-input');
  const save   = document.getElementById('nasa-key-save');
  const clear  = document.getElementById('nasa-key-clear');
  const status = document.getElementById('nasa-key-status');

  function syncBtn() {
    const cfgKey = (window.CSN_NASA_KEY || '').trim();
    const lsKey  = localStorage.getItem(NASA_KEY_STORE);
    const active = (cfgKey && cfgKey !== 'DEMO_KEY') ? cfgKey : lsKey;
    if (active) {
      btn.classList.add('on');
      const src = (cfgKey && cfgKey !== 'DEMO_KEY') ? 'config.js' : 'localStorage';
      btn.title = `NASA KEY: ${active.slice(0, 6)}… [${src}]`;
    } else {
      btn.classList.remove('on');
      btn.title = 'NASA API Key (using DEMO_KEY — 30 req/h)';
    }
  }

  syncBtn();

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = popup.classList.toggle('open');
    if (opening) {
      input.value = localStorage.getItem(NASA_KEY_STORE) || '';
      status.textContent = '';
      input.focus();
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!popup.contains(e.target) && e.target !== btn) {
      popup.classList.remove('open');
    }
  });

  save.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val || val === 'DEMO_KEY') {
      localStorage.removeItem(NASA_KEY_STORE);
      status.style.color = 'var(--amber)';
      status.textContent = 'Using DEMO_KEY';
    } else {
      localStorage.setItem(NASA_KEY_STORE, val);
      status.style.color = 'var(--teal)';
      status.textContent = 'Saved — refreshing…';
      // Invalidate CME cache and refetch immediately
      localStorage.removeItem('csn_cme_v1');
      setTimeout(fetchSpaceEvents, 300);
    }
    syncBtn();
    setTimeout(() => {
      popup.classList.remove('open');
      status.textContent = '';
    }, 1400);
  });

  clear.addEventListener('click', () => {
    localStorage.removeItem(NASA_KEY_STORE);
    input.value = '';
    status.style.color = 'var(--amber)';
    status.textContent = 'Cleared — using DEMO_KEY';
    syncBtn();
    setTimeout(() => {
      popup.classList.remove('open');
      status.textContent = '';
    }, 1200);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  save.click();
    if (e.key === 'Escape') popup.classList.remove('open');
  });
}

// ── CONSTANTS ─────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const C = {
  teal:  '#00f5c4',
  amber: '#f5a623',
  red:   '#e24b4a',
  blue:  '#4a8fe2',
  dim:   '#48607a',
};

// ── STATE ─────────────────────────────────────────────
const APP = {
  kp:          0,
  earthquakes: [],
  // cmes removed — was declared but never written
};

// ── INSTANCES ─────────────────────────────────────────
let globe     = null;
let swChart   = null;
let emChart   = null;
let xrChart   = null;
let schmChart = null;
let pfChart   = null;   // particle flux (log scale)

// Globe ring state — earthquakes only
let eqRings  = [];

// Globe arc state — CME arcs only
let cmeArcs  = [];
let schmArcs = [];  // unused, kept for compat

// Schumann HTML elements (distinct visual from EQ rings)
let schmHtmlData = [];

// Globe point state
let eqPoints = [];   // earthquake epicenter dots
let sunPoint = [];   // subsolar glowing orb

// ── IN-FLIGHT GUARDS (prevent duplicate concurrent fetches) ──
let fastBusy = false;
let slowBusy = false;


/* ═══════════════════════════════════════════════════
   MODULE-LEVEL UTILITIES
   (eliminates duplication between tickClock/stampRefresh)
   ═══════════════════════════════════════════════════ */

/** Zero-pad a number to 2 digits */
const pad = v => String(v).padStart(2, '0');

/** Format a Date as "HH:MM:SS UTC" */
const utcTime = (d = new Date()) =>
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;

/** Escape HTML special chars — prevents XSS when inserting API strings into innerHTML */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deterministic 0–1 float derived from a string.
 * Used to make earthquake ring / CME arc positions STABLE across refreshes
 * (instead of Math.random(), which makes them jump every 5 min).
 */
function hashFloat(str, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xFFFFFFFF);
}

/**
 * Single source of truth for Kp → colour mapping.
 * Previously duplicated with inconsistent thresholds (≤2 vs ≤3).
 */
function kpColor(kp) {
  if (kp <= 3) return C.teal;
  if (kp <= 6) return C.amber;
  return C.red;
}

/** Kp → status label */
function kpLabel(kp) {
  if (kp <= 2) return 'QUIET';
  if (kp <= 4) return 'UNSETTLED';
  if (kp <= 6) return 'ACTIVE';
  return 'STORM';
}

/** Convert hex colour string "#rrggbb" → [R, G, B] */
function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Human-readable time-ago string */
function timeAgo(v) {
  if (!v) return '—';
  // NASA DONKI sends "2024-01-15 06:32Z" — replace first space to make ISO-parseable
  const d   = new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '—';
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 0)    return 'just now';
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** ISO date string N days ago (YYYY-MM-DD) */
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().split('T')[0];
}

/**
 * GOES X-ray flux (W/m²) → flare class string.
 * e.g. 2.3e-5 → "M2.3",  5.1e-4 → "X5.1"
 */
function xrayClass(flux) {
  if (!flux || flux <= 0) return '—';
  if (flux >= 1e-4) return `X${(flux / 1e-4).toFixed(1)}`;
  if (flux >= 1e-5) return `M${(flux / 1e-5).toFixed(1)}`;
  if (flux >= 1e-6) return `C${(flux / 1e-6).toFixed(1)}`;
  if (flux >= 1e-7) return `B${(flux / 1e-7).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}

/** X-ray flare class letter → display colour */
function xrayColor(cls) {
  if (cls === 'X') return C.red;
  if (cls === 'M') return C.amber;
  if (cls === 'C') return C.blue;
  return C.teal;  // A, B — background quiet level
}


/* ═══════════════════════════════════════════════════
   CLOCK
   ═══════════════════════════════════════════════════ */
function tickClock() {
  document.getElementById('clock').textContent = utcTime();
}


/* ═══════════════════════════════════════════════════
   GLOBE.GL SETUP
   ═══════════════════════════════════════════════════ */
function initGlobe() {
  const el = document.getElementById('globe-wrap');

  // Mount Globe.gl WITHOUT explicit dimensions.
  // getBoundingClientRect() may return 0 at DOMContentLoaded;
  // sizeGlobe() is called after layout paints (see timeouts below).
  globe = Globe()
    // ── Textures (minimal — custom shader takes over) ──
    .globeImageUrl('https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg')
    .bumpImageUrl('https://raw.githubusercontent.com/turban/webgl-earth/master/images/elev_bump_4k.jpg')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .backgroundColor('#080808')
    // ── Atmosphere disabled — shader has its own ────
    .atmosphereAltitude(0)
    // ── No graticule grid ───────────────────────────
    .showGraticules(false)
    // ── Earthquake rings ────────────────────────────
    .ringsData([])
    .ringLat(d => d.lat)
    .ringLng(d => d.lng)
    .ringColor(d => {
      const [r, g, b] = d.rgb;
      return t => `rgba(${r},${g},${b},${1 - t})`;  // fade solid → transparent
    })
    .ringMaxRadius(d => d.r)
    .ringPropagationSpeed(d => d.spd)
    .ringRepeatPeriod(d => d.rep)
    // ── CME arcs ─────────────────────────────────────
    .arcsData([])
    .arcStartLat(d => d.slat).arcStartLng(d => d.slng)
    .arcEndLat(d => d.elat).arcEndLng(d => d.elng)
    .arcColor(d => d.color)            // array = gradient amber → red
    .arcStroke(d => d.w)
    .arcDashLength(d => d.dashLen ?? 0.35)
    .arcDashGap(d => d.dashGap ?? 0.15)
    .arcDashAnimateTime(d => d.t)
    // ── Earthquake epicenter points ──────────────────
    .pointsData([])
    .pointLat(d => d.lat)
    .pointLng(d => d.lng)
    .pointColor(d => d.col)
    .pointAltitude(d => d.alt ?? 0.005)
    .pointRadius(d => d.r)
    // ── Magnitude labels (M5.5+) ─────────────────────
    .labelsData([])
    .labelLat(d => d.lat)
    .labelLng(d => d.lng)
    .labelText(d => d.text)
    .labelSize(0.38)
    .labelDotRadius(0)
    .labelColor(() => 'rgba(255,220,180,0.85)')
    .labelResolution(3)
    // ── Schumann HTML markers ─────────────────────────
    .htmlElementsData([])
    .htmlElement(d => d.el)
    .htmlLat(d => d.lat)
    .htmlLng(d => d.lng)
    .htmlAltitude(0.01)
    (el);                              // ← mount to DOM element

  // ── Size correction ─────────────────────────────────
  const sizeGlobe = () => {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w > 0 && h > 0) globe.width(w).height(h);
  };
  // Two passes: quick (catches most cases) + late fallback (slow CSS/font loads)
  setTimeout(sizeGlobe, 100);
  setTimeout(sizeGlobe, 1000);
  new ResizeObserver(sizeGlobe).observe(el);

  // ── Camera & rotation ────────────────────────────────
  setTimeout(() => {
    globe.pointOfView({ lat: 22, lng: 15, altitude: 2.1 });
    const ctrl = globe.controls();
    ctrl.autoRotate      = true;
    ctrl.autoRotateSpeed = 0.28;
    ctrl.enableDamping   = true;
    ctrl.dampingFactor   = 0.08;
    ctrl.minDistance     = 101.5;   // allows zoom to ~city level (altitude ≈ 0.015)
  }, 150);

  // ── Retina ────────────────────────────────────────────
  setTimeout(() => {
    try { globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2)); } catch (_) {}
  }, 200);

  // ── Custom Earth Shader ───────────────────────────────
  // Replaces globe.gl's PhongMaterial with a full ShaderMaterial:
  // day/night blend · specular ocean · bump · clouds · atmosphere
  let _shaderTries = 0;
  const initEarthShader = () => {
    if (_shaderTries++ > 25) return;
    try {
      // Find globe mesh via its material reference
      const baseMat = globe.globeMaterial?.();
      if (!baseMat) { setTimeout(initEarthShader, 600); return; }
      let globeMesh = null;
      globe.scene().traverse(obj => {
        if (!globeMesh && obj.isMesh && obj.material === baseMat) globeMesh = obj;
      });
      if (!globeMesh) { setTimeout(initEarthShader, 600); return; }

      const RADIUS = globeMesh.geometry.parameters?.radius ?? 100;
      const tl     = new THREE.TextureLoader();
      // 4K textures from turban/webgl-earth (raw.githubusercontent = CORS OK)
      // Clouds: matteason live cloud map (updates every 3h, CORS enabled)
      const GH  = 'https://raw.githubusercontent.com/turban/webgl-earth/master/images/';

      Promise.allSettled([
        tl.loadAsync(GH + '2_no_clouds_4k.jpg'),           // day — clean surface, no baked clouds
        tl.loadAsync('https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg'),
        tl.loadAsync(GH + 'water_4k.png'),                 // specular ocean mask
        tl.loadAsync(GH + 'elev_bump_4k.jpg'),             // 4K elevation bump
        tl.loadAsync('https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg'), // live clouds
      ]).then(([r0, r1, r2, r3, r4]) => {
        const ok = r => r.status === 'fulfilled' ? r.value : null;
        const dayTex   = ok(r0);
        const nightTex = ok(r1);
        const waterTex = ok(r2);
        const bumpTex  = ok(r3);
        const cloudTex = ok(r4);
        if (!dayTex) return;

        // Cloud texture must repeat horizontally so the offset scroll never shows seams
        if (cloudTex) {
          cloudTex.wrapS = THREE.RepeatWrapping;
          cloudTex.needsUpdate = true;
        }

        const sunDir = new THREE.Vector3();
        const updateSun = () => {
          const h = new Date();
          const utcH = h.getUTCHours() + h.getUTCMinutes() / 60 + h.getUTCSeconds() / 3600;
          const lng  = (180 - utcH * 15) * Math.PI / 180;
          sunDir.set(Math.cos(lng), 0.1, Math.sin(lng)).normalize();
        };
        updateSun();

        // ── Earth ShaderMaterial ──────────────────────
        const earthMat = new THREE.ShaderMaterial({
          uniforms: {
            uDay:      { value: dayTex },
            uNight:    { value: nightTex ?? dayTex },
            uWater:    { value: waterTex ?? dayTex },
            uBump:     { value: bumpTex  ?? dayTex },
            uCloud:    { value: cloudTex ?? dayTex },
            uCloudOffset: { value: 0.0 },
            uCloudFade:   { value: 1.0 },   // 1 = full clouds, 0 = invisible
            uSunDir:   { value: sunDir },
            uHasNight: { value: nightTex ? 1.0 : 0.0 },
            uHasWater: { value: waterTex ? 1.0 : 0.0 },
            uHasBump:  { value: bumpTex  ? 1.0 : 0.0 },
            uHasCloud: { value: cloudTex ? 1.0 : 0.0 },
          },
          vertexShader: /* glsl */`
            varying vec2  vUv;
            varying vec3  vNormal;
            varying vec3  vViewPos;
            void main() {
              vUv      = uv;
              vNormal  = normalize(normalMatrix * normal);
              vViewPos = (modelViewMatrix * vec4(position, 1.0)).xyz;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: /* glsl */`
            uniform sampler2D uDay, uNight, uWater, uBump, uCloud;
            uniform float uCloudOffset, uCloudFade, uHasNight, uHasWater, uHasBump, uHasCloud;
            uniform vec3  uSunDir;
            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vViewPos;

            void main() {
              vec3 N = normalize(vNormal);
              vec3 V = normalize(-vViewPos);
              vec3 L = normalize(uSunDir);

              // Enhanced screen-space bump mapping
              vec3 bN = N;
              if (uHasBump > 0.5) {
                vec2 px  = vec2(dFdx(vUv.x), dFdy(vUv.y));
                float b0 = texture2D(uBump, vUv).r;
                float bx = texture2D(uBump, vUv + vec2(px.x, 0.0)).r;
                float by = texture2D(uBump, vUv + vec2(0.0, px.y)).r;
                // Stronger bump strength (2.8 vs 1.4) for visible terrain relief
                bN = normalize(N
                  + 2.8 * (bx - b0) * normalize(cross(N, vec3(0.0, 1.0, 0.01)))
                  + 2.8 * (by - b0) * normalize(cross(N, vec3(1.0, 0.0, 0.0))));
              }

              float diff   = dot(bN, L);
              float rawDiff = dot(N, L);
              float dayMix = smoothstep(-0.15, 0.25, diff);

              // Day: slight contrast boost + ambient floor so night-side ocean isn't pure black
              vec3 day = texture2D(uDay, vUv).rgb;
              day = pow(day, vec3(0.92));              // gamma lift for vibrancy
              day = day * (0.08 + 0.92 * max(diff, 0.0));

              vec3 color = day;
              if (uHasNight > 0.5) {
                vec3 night = texture2D(uNight, vUv).rgb;
                // Boost city lights, subtle bloom
                night = night * night * 3.8;
                night *= (1.0 - smoothstep(-0.28, 0.10, rawDiff));
                color  = mix(night, day, dayMix);
              }

              // Specular ocean — tighter, brighter highlight
              if (uHasWater > 0.5) {
                float water = texture2D(uWater, vUv).r;
                vec3  H     = normalize(L + V);
                float spec  = pow(max(dot(bN, H), 0.0), 140.0) * max(diff, 0.0);
                // Wide soft glare + tight hot spot
                float specSoft = pow(max(dot(bN, H), 0.0), 30.0) * max(diff, 0.0) * 0.08;
                color += water * (spec * 0.75 + specSoft) * vec3(1.0, 0.96, 0.90);
              }

              // Clouds — fade out on zoom (uCloudFade 0→1)
              if (uHasCloud > 0.5 && uCloudFade > 0.01) {
                vec2  cUv   = vec2(fract(vUv.x + uCloudOffset), vUv.y);
                float cloud = texture2D(uCloud, cUv).r * uCloudFade;
                float cLit  = max(dot(N, L), 0.0) * 0.7 + 0.3;
                float cShadow = 1.0 - cloud * 0.35;
                color *= mix(1.0, cShadow, dayMix);
                color  = mix(color, vec3(cLit), cloud * 0.82);
              }

              // Fresnel rim — subtle blue hint from atmosphere shader
              float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0);
              color += rim * 0.055 * vec3(0.30, 0.60, 1.0) * max(rawDiff * 0.5 + 0.5, 0.0);

              gl_FragColor = vec4(color, 1.0);
            }
          `,
        });

        globeMesh.material = earthMat;

        // ── Atmosphere sphere (inner — tight blue rim) ────
        const atmFrag = /* glsl */`
          uniform vec3  uSunDir;
          uniform float uAtmFade;
          varying vec3 vNormal;
          varying vec3 vViewPos;
          void main() {
            vec3  N    = normalize(vNormal);
            vec3  V    = normalize(-vViewPos);
            float rim  = 1.0 - max(dot(N, V), 0.0);
            rim         = pow(rim, 2.2);
            float day   = max(dot(N, normalize(uSunDir)) * 0.5 + 0.62, 0.0);
            // Terminator tint: night side gets a warmer orange limb
            float night = max(-dot(N, normalize(uSunDir)) * 0.4 + 0.1, 0.0);
            vec3  dayCol   = vec3(0.18, 0.50, 1.00);
            vec3  nightCol = vec3(0.45, 0.18, 0.08);
            vec3  col = mix(nightCol * night, dayCol * day, smoothstep(0.0, 0.5, day));
            float a   = rim * 0.42 * uAtmFade;
            gl_FragColor = vec4(col * a, a);
          }
        `;
        const atmVert = /* glsl */`
          varying vec3 vNormal;
          varying vec3 vViewPos;
          void main() {
            vNormal  = normalize(normalMatrix * normal);
            vViewPos = (modelViewMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `;
        const makeAtmMat = (uni) => new THREE.ShaderMaterial({
          transparent: true, side: THREE.FrontSide,
          depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: uni, vertexShader: atmVert, fragmentShader: atmFrag,
        });

        // Inner atmosphere (tight rim)
        const atmMesh = new THREE.Mesh(
          new THREE.SphereGeometry(RADIUS * 1.030, 64, 32),
          makeAtmMat({ uSunDir: { value: sunDir }, uAtmFade: { value: 1.0 } })
        );
        globeMesh.parent.add(atmMesh);

        // Outer diffuse glow (deep-space aurora look)
        const outerMat = new THREE.ShaderMaterial({
          transparent: true, side: THREE.FrontSide,
          depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uSunDir: { value: sunDir }, uAtmFade: { value: 1.0 } },
          vertexShader: atmVert,
          fragmentShader: /* glsl */`
            uniform vec3  uSunDir;
            uniform float uAtmFade;
            varying vec3 vNormal;
            varying vec3 vViewPos;
            void main() {
              vec3  N   = normalize(vNormal);
              vec3  V   = normalize(-vViewPos);
              float rim = 1.0 - max(dot(N, V), 0.0);
              rim        = pow(rim, 1.5);
              float day  = max(dot(N, normalize(uSunDir)) * 0.4 + 0.55, 0.0);
              vec3  col  = vec3(0.08, 0.28, 0.85);
              float a    = rim * 0.10 * day * uAtmFade;
              gl_FragColor = vec4(col * a, a);
            }
          `,
        });
        const outerMesh = new THREE.Mesh(
          new THREE.SphereGeometry(RADIUS * 1.065, 48, 24),
          outerMat
        );
        globeMesh.parent.add(outerMesh);

        // ── ESRI Satellite tile overlay ─────────────────────
        // Tiles are added to globe.scene() (scene root) — Globe.gl never clears it.
        // Coordinate mapping: phi=(lng+180)*π/180, theta=(90-lat)*π/180 matches
        // Three.js SphereGeometry UV→world space (verified with Globe.gl's coordinate system).
        const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
        const tileScene  = globe.scene();
        const tileParent = new THREE.Group();
        tileScene.add(tileParent);

        const tileCache = new Map();   // key → { mesh, loading }
        const tileTL    = new THREE.TextureLoader();
        tileTL.crossOrigin = 'anonymous';
        const MAX_TILES = 64;

        // Altitude → Web Mercator zoom level (0 = disabled)
        function altToZoom(alt) {
          if (alt > 0.80) return 0;
          if (alt > 0.35) return 5;
          if (alt > 0.14) return 7;
          if (alt > 0.05) return 10;
          if (alt > 0.02) return 13;
          return 15;
        }

        function tile2lng(x, z) { return x / (1 << z) * 360 - 180; }
        function tile2lat(y, z) {
          const n = Math.PI * (1 - 2 * y / (1 << z));
          return (180 / Math.PI) * Math.atan(Math.sinh(n));
        }

        function removeTile(key) {
          const v = tileCache.get(key);
          if (!v) return;
          if (v.mesh) {
            tileParent.remove(v.mesh);
            v.mesh.geometry.dispose();
            v.mesh.material.map?.dispose();
            v.mesh.material.dispose();
          }
          tileCache.delete(key);
        }

        function evictOldest() {
          let oldestT = Infinity, oldestKey = null;
          tileCache.forEach((v, k) => { if (v.ts < oldestT) { oldestT = v.ts; oldestKey = k; } });
          if (oldestKey) removeTile(oldestKey);
        }

        function loadTile(key, tx, ty, tz) {
          if (tileCache.has(key)) { tileCache.get(key).ts = Date.now(); return; }
          if (tileCache.size >= MAX_TILES) evictOldest();

          const entry = { ts: Date.now(), mesh: null, loading: true };
          tileCache.set(key, entry);

          tileTL.load(
            `${ESRI_URL}/${tz}/${ty}/${tx}`,
            tex => {
              if (!tileCache.has(key)) { tex.dispose(); return; }
              // Build sphere patch matching this tile's lat/lng bounds
              const n = tile2lat(ty,     tz),  s = tile2lat(ty + 1, tz);
              const w = tile2lng(tx,     tz),  e = tile2lng(tx + 1, tz);
              const phi0   = (w + 180) * Math.PI / 180;
              const phiLen = (e - w)   * Math.PI / 180;
              const th0    = (90 - n)  * Math.PI / 180;
              const thLen  = (n  - s)  * Math.PI / 180;
              const segs   = tz >= 13 ? 32 : tz >= 10 ? 20 : tz >= 7 ? 12 : 8;
              const geo = new THREE.SphereGeometry(
                RADIUS * 1.0012, segs, segs, phi0, phiLen, th0, thLen
              );
              tex.colorSpace = THREE.SRGBColorSpace;
              const mat = new THREE.MeshBasicMaterial({
                map: tex, transparent: true, opacity: 0,
                depthWrite: false, depthTest: true,
              });
              const mesh = new THREE.Mesh(geo, mat);
              mesh.renderOrder = 5;
              tileParent.add(mesh);
              entry.mesh    = mesh;
              entry.loading = false;
              // Smooth fade-in over ~400ms
              let t = 0;
              const fadeIn = () => {
                t = Math.min(1, t + 0.05);
                mat.opacity = t;
                if (t < 1) requestAnimationFrame(fadeIn);
              };
              fadeIn();
            },
            undefined,
            err => { console.warn('[tiles] load failed:', key, err); tileCache.delete(key); }
          );
        }

        // Track last grid params
        let _tLat = 999, _tLng = 999, _tZoom = -1, _tPanTimer = null;

        function updateTiles() {
          const pov = globe?.pointOfView?.();
          if (!pov) return;
          const { lat, lng, altitude: alt } = pov;
          const tz = altToZoom(alt);

          if (tz === 0) { tileParent.visible = false; return; }
          tileParent.visible = true;

          // Zoom level changed → load immediately (no debounce: user needs to see tiles)
          if (tz !== _tZoom) {
            _tLat = lat; _tLng = lng; _tZoom = tz;
            _doLoadTiles(lat, lng, tz);
            return;
          }

          // Same zoom, small pan → debounce to avoid request spam while dragging
          const tileDeg = 360 / (1 << tz);
          const panned = Math.abs(lat - _tLat) > tileDeg * 0.4
                      || Math.abs(lng - _tLng) > tileDeg * 0.4;
          if (!panned) return;

          clearTimeout(_tPanTimer);
          _tPanTimer = setTimeout(() => {
            const p2 = globe?.pointOfView?.();
            if (!p2 || altToZoom(p2.altitude) !== tz) return;
            _tLat = p2.lat; _tLng = p2.lng;
            _doLoadTiles(p2.lat, p2.lng, tz);
          }, 200);
        }

        function _doLoadTiles(lat, lng, tz) {

          const tmax = 1 << tz;
          // Camera center tile (Web Mercator)
          const cx = Math.floor((lng + 180) / 360 * tmax);
          const sinLat = Math.sin(lat * Math.PI / 180);
          const cy = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * tmax);

          // Grid radius by zoom: more tiles at lower zooms to cover the visible area
          const r = tz <= 5 ? 3 : tz <= 7 ? 2 : 1;
          const wantedKeys = new Set();
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const tx  = ((cx + dx) % tmax + tmax) % tmax;
              const ty  = Math.max(0, Math.min(tmax - 1, cy + dy));
              const key = `${tz}/${ty}/${tx}`;
              wantedKeys.add(key);
              loadTile(key, tx, ty, tz);
            }
          }
          // Remove tiles outside current grid (different zoom or far from view)
          tileCache.forEach((_, k) => {
            const kz = parseInt(k.split('/')[0]);
            if (kz !== tz || !wantedKeys.has(k)) removeTile(k);
          });
        }

        // ── Animate: clouds + sun + atmosphere + tiles ───────
        let cloudOffset = 0;
        const tick = () => {
          requestAnimationFrame(tick);
          cloudOffset += 0.000025;
          earthMat.uniforms.uCloudOffset.value = cloudOffset;

          const alt = globe?.pointOfView?.()?.altitude ?? 1.0;

          // Cloud fade: full at alt≥0.4, gone at alt≤0.05
          earthMat.uniforms.uCloudFade.value = Math.max(0, Math.min(1,
            (alt - 0.05) / (0.4 - 0.05)
          ));

          // Atmosphere fade: full at alt≥0.5, gone at alt≤0.10
          const atmFade = Math.max(0, Math.min(1, (alt - 0.10) / (0.50 - 0.10)));
          atmMesh.material.uniforms.uAtmFade.value  = atmFade;
          outerMat.uniforms.uAtmFade.value          = atmFade;

          // Satellite tile overlay
          updateTiles();
        };
        tick();
        setInterval(updateSun, 60_000); // update sun position every minute
      });
    } catch (_) {}
  };
  setTimeout(initEarthShader, 1200);

  // Pause rotation on drag, resume after 4 s.
  // FIX: listen on window for pointerup/pointercancel so release outside
  // the element doesn't leave the globe permanently paused.
  let rotateTimer;
  const pauseRotation = () => {
    if (globe) globe.controls().autoRotate = false;
    clearTimeout(rotateTimer);
  };
  const resumeRotation = () => {
    rotateTimer = setTimeout(() => {
      if (globe) globe.controls().autoRotate = true;
    }, 4000);
  };
  el.addEventListener('pointerdown', pauseRotation);
  el.addEventListener('wheel',       pauseRotation, { passive: true });
  window.addEventListener('pointerup',     resumeRotation);
  window.addEventListener('pointercancel', resumeRotation);

  // ── Hide loader (2.5 s gives textures time to fetch & render) ───
  setTimeout(() => {
    const ldr = document.getElementById('globe-loading');
    ldr.classList.add('fade-out');
    setTimeout(() => (ldr.style.display = 'none'), 1100);
  }, 2500);
}

/** EQ rings only */
function syncRings() {
  if (!globe) return;
  globe.ringsData(eqRings);
}

/** CME arcs only */
function syncArcs() {
  if (!globe) return;
  globe.arcsData(cmeArcs);
}

/** Schumann HTML markers */
function syncSchmHtml() {
  if (!globe) return;
  globe.htmlElementsData(schmHtmlData);
}

/** EQ epicenter dots + subsolar orb → pointsData */
function syncPoints() {
  if (!globe) return;
  globe.pointsData([...eqPoints, ...sunPoint]);
}

/**
 * Glowing orb at the current subsolar point (where Sun is directly overhead).
 * Uses pointsData with large radius + elevated altitude → always on the globe,
 * never outside the globe boundary (unlike htmlElementsData).
 * Color driven by X-ray flux class. Size: ~3× larger than biggest EQ dot.
 */
function updateSubsolar(flux) {
  if (!globe || !flux || flux <= 0) return;
  const now    = new Date();
  const doy    = Math.round((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  const sunLat = 23.45 * Math.sin(2 * Math.PI * (doy - 81) / 365);
  const h      = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const sunLng = ((h / 24) * -360 + 180 + 360) % 360 - 180;

  const cls     = xrayClass(flux);
  const col     = xrayColor(cls[0]);
  const isFlare = cls[0] === 'X' || cls[0] === 'M';

  // Large glowing orb at altitude — visually unique vs EQ dots (tiny, altitude 0.005)
  sunPoint = [{ lat: sunLat, lng: sunLng, col, r: isFlare ? 1.1 : 0.75, alt: 0.07 }];
  syncPoints();
}

/** Known Schumann resonance source regions (tropical lightning hotspots) */
const SCHM_SOURCES = [
  { lat:  5, lng:  20 },   // Central Africa   (~60% of global lightning)
  { lat: -5, lng: -60 },   // Amazon / Americas
  { lat:  5, lng: 105 },   // SE Asia / Maritime Continent
];

/**
 * Schumann resonance markers — custom SVG HTML elements at 3 source regions.
 * Diamond/crosshair shape with CSS pulse — visually distinct from EQ rings
 * (which are circular expanding waves on the ring layer).
 */
function updateSchmGlobe(state, col) {
  if (!globe) return;

  const dur  = state === 'SPIKE' ? '0.65s' : state === 'ACTIVE' ? '1.5s' : '3.0s';
  const sz   = 26;
  const half = sz / 2;

  schmHtmlData = SCHM_SOURCES.map(s => {
    const el = document.createElement('div');
    el.style.cssText = `width:${sz}px;height:${sz}px;pointer-events:none`;
    el.innerHTML = `<svg width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}"
      style="display:block;animation:schm-pulse ${dur} ease-in-out infinite"
      xmlns="http://www.w3.org/2000/svg">
      <style>@keyframes schm-pulse{0%,100%{opacity:.9;transform:scale(1)}50%{opacity:.4;transform:scale(1.2)}}</style>
      <polygon points="${half},2 ${sz-2},${half} ${half},${sz-2} 2,${half}"
        fill="none" stroke="${col}" stroke-width="1.4" opacity="0.9"/>
      <line x1="${half}" y1="${half-5}" x2="${half}" y2="${half+5}"
        stroke="${col}" stroke-width="0.9" opacity="0.65"/>
      <line x1="${half-5}" y1="${half}" x2="${half+5}" y2="${half}"
        stroke="${col}" stroke-width="0.9" opacity="0.65"/>
      <circle cx="${half}" cy="${half}" r="2" fill="${col}" opacity="1"/>
      <circle cx="${half}" cy="${half}" r="${half-2}" fill="none"
        stroke="${col}" stroke-width="0.5" opacity="0.22" stroke-dasharray="2 4"/>
    </svg>`;
    return { lat: s.lat, lng: s.lng, el };
  });
  syncSchmHtml();
}

/**
 * Render earthquake rings with THREE distinct visual classes:
 *   M3.5–4.5 → rapid small rings + micro dot
 *   M4.5–5.5 → medium rings + visible dot
 *   M5.5+    → single slow large ring + bright dot + magnitude label
 */
function updateGlobeEQ(features) {
  if (!globe) return;

  const rings = features.map(f => {
    const [lng, lat, depth] = f.geometry.coordinates;
    const mag = f.properties.mag ?? 3.5;
    const col = depth < 70 ? C.red : depth < 300 ? C.amber : C.blue;
    const id  = f.id || `${lat},${lng}`;
    const big = mag >= 5.5;
    const med = mag >= 4.5 && !big;
    return {
      lat, lng,
      rgb: hexToRgb(col),
      // Radius: M5.5+ dramatically large, others scale linearly
      r:   big ? Math.max(4.0, mag * 1.8)
               : med ? Math.max(1.5, mag * 1.0)
               :       Math.max(0.6, mag * 0.60),
      // Speed: big quakes expand very slowly for dramatic effect
      spd: big ? 0.14 + hashFloat(id, 1) * 0.10
               : med  ? 0.45 + hashFloat(id, 1) * 0.30
               :        0.9  + hashFloat(id, 1) * 0.7,
      // Repeat: big = rare single slow ring, small = rapid flicker
      rep: big ? 4500 + hashFloat(id, 2) * 2000
               : med  ? 1400 + hashFloat(id, 2) * 700
               :        600  + hashFloat(id, 2) * 380,
    };
  });
  eqRings = rings;
  syncRings();

  // Glowing epicenter dots — elevated altitude for glow effect, radius by magnitude
  eqPoints = features.map(f => {
    const [lng, lat, depth] = f.geometry.coordinates;
    const mag = f.properties.mag ?? 3.5;
    const col = depth < 70 ? C.red : depth < 300 ? C.amber : C.blue;
    const big = mag >= 5.5;
    return {
      lat, lng, col,
      r:   Math.max(0.10, (mag - 3.0) * (big ? 0.18 : 0.13)),
      alt: big ? 0.012 : 0.005,  // bigger quakes elevated = more visible glow
    };
  });
  syncPoints();

  // Labels for significant events only (M5.5+)
  globe.labelsData(
    features
      .filter(f => (f.properties.mag ?? 0) >= 5.5)
      .map(f => {
        const [lng, lat] = f.geometry.coordinates;
        return { lat, lng, text: `M${f.properties.mag.toFixed(1)}` };
      })
  );
}

/** Render CME arcs on globe with STABLE positions (seeded by event time) */
function updateGlobeCME(cmes) {
  if (!globe || !cmes.length) return;
  // Single Date call to avoid crossing a minute boundary mid-computation
  const now    = new Date();
  const h      = now.getUTCHours() + now.getUTCMinutes() / 60;
  const sunLng = ((h / 24) * -360 + 180 + 360) % 360 - 180;

  const arcs = cmes.map((c, i) => {
    const key = c.time || String(i);
    // FIX: deterministic positions so arcs don't jump on every refresh
    return {
      slat:  (hashFloat(key, 1) - 0.5) * 28,
      slng:  sunLng + (hashFloat(key, 2) - 0.5) * 35,
      elat:  (hashFloat(key, 3) - 0.5) * 60,
      elng:  hashFloat(key, 4) * 360 - 180,
      color: [C.amber, C.red],
      w:     0.6 + hashFloat(key, 5) * 0.7,
      t:     Math.max(1200, 5000 - (c.speed || 500) * 2),
      dashLen: 0.28,
      dashGap: 0.08,
    };
  });
  cmeArcs = arcs;
  syncArcs();
}


/* ═══════════════════════════════════════════════════
   CHART.JS SETUP
   ═══════════════════════════════════════════════════ */
function initCharts() {
  Chart.defaults.font.family = "'Fira Code', monospace";
  Chart.defaults.color       = C.dim;

  const noAxes = { x: { display: false }, y: { display: false } };
  const baseOpts = {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           { duration: 350 },
    plugins:             { legend: { display: false }, tooltip: { enabled: false } },
  };

  // Solar wind sparkline — speed (teal) + density (amber) on separate Y axes
  swChart = new Chart(
    document.getElementById('sw-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels:   [],
        datasets: [
          { label:'Speed',   data:[], yAxisID:'y',  borderColor:C.teal,  borderWidth:1.5, pointRadius:0, tension:0.35 },
          { label:'Density', data:[], yAxisID:'y2', borderColor:C.amber, borderWidth:1.5, pointRadius:0, tension:0.35 },
        ],
      },
      options: {
        ...baseOpts,
        scales: { x:{display:false}, y:{display:false}, y2:{display:false} },
      },
    }
  );

  // EM field waveform — single line with fill
  emChart = new Chart(
    document.getElementById('em-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels:   [],
        datasets: [{
          data: [], borderColor: C.teal, borderWidth: 1.5,
          pointRadius: 0, tension: 0.25, fill: true,
          backgroundColor: 'rgba(0,245,196,0.07)',
        }],
      },
      options: { ...baseOpts, scales: noAxes },
    }
  );

  // X-ray flux sparkline — logarithmic Y (flux spans many orders of magnitude)
  xrChart = new Chart(
    document.getElementById('xr-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels:   [],
        datasets: [{
          data: [], borderColor: C.teal, borderWidth: 1.5,
          pointRadius: 0, tension: 0.2, fill: true,
          backgroundColor: 'rgba(0,245,196,0.07)',
        }],
      },
      options: {
        ...baseOpts,
        scales: { x: { display: false }, y: { display: false, type: 'logarithmic' } },
      },
    }
  );

  // Schumann proxy — 3-station detrended comparison (BOU / GUA / SJG)
  schmChart = new Chart(
    document.getElementById('schm-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels:   [],
        datasets: [
          { label: 'BOU', data: [], borderColor: C.teal,  borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false },
          { label: 'GUA', data: [], borderColor: C.blue,  borderWidth: 1.0, pointRadius: 0, tension: 0.25, fill: false },
          { label: 'SJG', data: [], borderColor: C.amber, borderWidth: 1.0, pointRadius: 0, tension: 0.25, fill: false },
        ],
      },
      options: { ...baseOpts, scales: noAxes },
    }
  );

  // ── Particle flux chart (LOG scale — visually distinct) ──
  // Threshold lines drawn as flat datasets (no annotation plugin needed)
  const thrLine = (val, col) => ({
    data: [], borderColor: col, borderWidth: 1,
    borderDash: [4, 3], pointRadius: 0, fill: false,
    _thr: val,   // custom marker used in updatePfThresholds()
  });

  pfChart = new Chart(
    document.getElementById('pf-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels:   [],
        datasets: [
          // Real data
          { label: 'Proton',   data: [], borderColor: C.amber, borderWidth: 1.5, pointRadius: 0, tension: 0.1, fill: false },
          { label: 'Electron', data: [], borderColor: C.blue,  borderWidth: 1.0, pointRadius: 0, tension: 0.1, fill: false },
          // Threshold reference lines
          thrLine(10,   'rgba(76,175,80,.55)'),    // S1
          thrLine(100,  'rgba(245,166,35,.55)'),   // S2
          thrLine(1000, 'rgba(226,75,74,.55)'),    // S3
        ],
      },
      options: {
        ...baseOpts,
        scales: {
          x: { display: false },
          y: {
            type: 'logarithmic',
            min: 0.01,
            max: 100_000,
            grid:   { color: 'rgba(30,47,80,.6)', drawBorder: false },
            ticks:  {
              color: 'rgba(72,96,122,.8)',
              font:  { family: "'Fira Code',monospace", size: 8 },
              callback: v => {
                if (v === 0.01) return '.01';
                if (v === 0.1)  return '.1';
                if (v === 1)    return '1';
                if (v === 10)   return '10';
                if (v === 100)  return '100';
                if (v === 1000) return '1k';
                if (v === 10000)  return '10k';
                if (v === 100000) return '100k';
                return null;
              },
              maxTicksLimit: 7,
            },
          },
        },
      },
    }
  );
}


/* ═══════════════════════════════════════════════════
   STATUS HELPERS
   ═══════════════════════════════════════════════════ */
const setDot = (id, s) => { const el = document.getElementById(id); if (el) el.className = `src-dot ${s}`; };
const setBst = (id, s) => { const el = document.getElementById(id); if (el) el.className = `bst ${s}`;     };

// FIX: setNoaa covers both dots — called explicitly in each NOAA fetcher
const setNoaa = s => { setDot('d-noaa', s); setBst('bs-sw',   s); setBst('bs-kp',   s); };
const setGoes = s => { setDot('d-goes', s); setBst('bs-xray', s);                        };
const setGeo  = s => { setDot('d-geo',  s); setBst('bs-em',   s); setBst('bs-schm', s); };
const setEq   = s => { setDot('d-usgs', s); setBst('bs-eq',   s);                        };
const setNasa = s => { setDot('d-nasa', s); setBst('bs-nasa', s);                        };
const setSwpc = s => { setDot('d-swpc', s); setBst('bs-alrt', s); setBst('bs-prtn', s); };


/* ═══════════════════════════════════════════════════
   FETCH HELPER
   ═══════════════════════════════════════════════════ */

/** Fetch JSON safely; returns null on any network or HTTP error */
async function get(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[CSN]', url.slice(0, 64), err.message);
    return null;
  }
}


/* ═══════════════════════════════════════════════════
   BLOCK 1 — SOLAR WIND (NOAA)
   Endpoint: /products/solar-wind/plasma-1-day.json
   Row: [time_tag, density, speed, temperature]
   Refresh: 60 s
   ═══════════════════════════════════════════════════ */
async function fetchSolarWind() {
  setNoaa('wait');
  const data = await get(
    'https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json'
  );

  if (!data || data.length < 2) { setNoaa('error'); return; }

  // Row 0 = header; skip null speed/density rows
  const rows = data.slice(1).filter(r => r[2] != null && r[1] != null);
  if (!rows.length) { setNoaa('error'); return; }

  const last    = rows[rows.length - 1];
  const speed   = parseFloat(last[2]);
  const density = parseFloat(last[1]);

  document.getElementById('sw-spd').textContent = isNaN(speed)   ? '—' : Math.round(speed);
  document.getElementById('sw-den').textContent = isNaN(density) ? '—' : density.toFixed(1);

  // Last ~144 points ≈ 24 h at 10-min cadence
  const slice = rows.slice(-144);
  swChart.data.labels           = slice.map((_, i) => i);
  swChart.data.datasets[0].data = slice.map(r => parseFloat(r[2]) || null);
  swChart.data.datasets[1].data = slice.map(r => parseFloat(r[1]) || null);
  swChart.update('none');

  setNoaa('ok');
}


/* ═══════════════════════════════════════════════════
   BLOCK 1b — IMF Bz / Solar Wind Magnetic Field (NOAA/DSCOVR)
   Endpoint: /products/solar-wind/mag-1-day.json
   Row: [time_tag, bx_gsm, by_gsm, bz_gsm, lon_gsm, lat_gsm, bt]
   Bz < 0 (southward) = geomagnetic storm risk
   Refresh: 60 s
   ═══════════════════════════════════════════════════ */
async function fetchMag() {
  const data = await get(
    'https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json'
  );
  if (!data || data.length < 2) return;

  const rows  = data.slice(1).filter(r => r[3] != null);
  if (!rows.length) return;

  const bz  = parseFloat(rows[rows.length - 1][3]);
  if (isNaN(bz)) return;

  const bzEl  = document.getElementById('sw-bz');
  const dirEl = document.getElementById('sw-bz-dir');

  bzEl.textContent = (bz >= 0 ? '+' : '') + bz.toFixed(1);

  const isNorth = bz >= 0;
  const col     = isNorth ? C.teal : C.red;
  bzEl.style.color      = col;
  bzEl.style.textShadow = `0 0 12px ${col}66`;

  dirEl.textContent       = isNorth ? '↑ NORTH' : '↓ SOUTH';
  dirEl.style.color       = col;
  dirEl.style.background  = `${col}18`;
}


/* ═══════════════════════════════════════════════════
   BLOCK 2 — KP INDEX (NOAA)
   Endpoint: /products/noaa-planetary-k-index.json
   Row: [time_tag, Kp, estimated_kp, noaa_scale]
   Refresh: 60 s
   ═══════════════════════════════════════════════════ */
async function fetchKpIndex() {
  // FIX: was missing setNoaa('wait') — caused dot to stay 'ok' during refetch
  setNoaa('wait');

  const data = await get(
    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'
  );
  // FIX: was silently returning without setNoaa('error') on failure
  if (!data || data.length < 2) { setNoaa('error'); return; }

  const rows = data.slice(1).filter(r => r[1] != null);
  const kp   = parseFloat(rows[rows.length - 1]?.[1]);
  if (isNaN(kp)) { setNoaa('error'); return; }

  APP.kp = kp;

  const col = kpColor(kp);   // FIX: single source — was duplicated with different thresholds

  const valEl   = document.getElementById('kp-val');
  const badgeEl = document.getElementById('kp-badge');
  const fillEl  = document.getElementById('kp-fill');

  valEl.textContent          = kp.toFixed(1);
  valEl.style.color          = col;
  valEl.style.textShadow     = `0 0 22px ${col}77`;
  badgeEl.textContent        = kpLabel(kp);
  badgeEl.style.color        = col;
  badgeEl.style.borderColor  = col;
  badgeEl.style.background   = `${col}18`;
  fillEl.style.width         = `${(kp / 9) * 100}%`;
  fillEl.style.background    = col;

  setNoaa('ok');
}


/* ═══════════════════════════════════════════════════
   BLOCK 3 — EM FIELD / SCHUMANN PROXY (USGS Geomag)
   Stations: BOU (Americas), GUA (Pacific/SE Asia), SJG (Atlantic)
   Element: F (total field), sampling 60 s, last 60 min
   Refresh: 60 s
   ═══════════════════════════════════════════════════ */

/** Amplitude decay ratios for SR harmonics 1–5 (approx) */
const SR_RATIOS = [1.0, 0.62, 0.42, 0.28, 0.18];

/**
 * Update vertical harmonic bars in the Schumann panel.
 * Uses BOU std-dev scaled to [0,1], multiplied by harmonic decay ratios.
 * A ±18% jitter makes each bar look independently active.
 */
function updateSchmBars(sd, col) {
  const base = Math.min(Math.max(sd / 5, 0.08), 1.0); // 5 nT → full bars
  SR_RATIOS.forEach((ratio, i) => {
    const el = document.getElementById(`sh-${i}`);
    if (!el) return;
    const jitter = 0.82 + Math.random() * 0.36;
    const pct    = Math.round(base * ratio * jitter * 100);
    el.style.height     = `${Math.min(Math.max(pct, 4), 97)}%`;
    el.style.background = col;
    el.style.boxShadow  = `0 0 8px ${col}60`;
  });
}

/** Spectrogram source config indexed by tab key */
const SPEC_SOURCES = {
  '1h':  { url: 'https://www.etna-ero.it/live_etna/last-coil_1h.jpg',  label: 'ELF · ETNA-ERO (IT) · LAST 1H',   hzOverlay: true  },
  '8h':  { url: 'https://www.etna-ero.it/live_etna/last-coil_8h.jpg',  label: 'ELF · ETNA-ERO (IT) · LAST 8H',   hzOverlay: true  },
  '24h': { url: 'https://www.etna-ero.it/live_etna/last-coil_24h.jpg', label: 'ELF · ETNA-ERO (IT) · LAST 24H',  hzOverlay: true  },
  'day': { url: 'https://sosrff.tsu.ru/new/shm.jpg',                   label: 'SCHUMANN · TOMSK TSU (RU) · TODAY', hzOverlay: false },
};

/** Track active window for lightbox */
let _activeSpecKey = '1h';

/**
 * Switch spectrogram tab: 1H / 8H / 24H (ETNA-ERO) / DAY (Tomsk TSU).
 * Called from inline onclick on .spec-tab buttons.
 */
window.switchSpec = function(btn, win) {
  _activeSpecKey = win;
  const src = SPEC_SOURCES[win];
  const img     = document.getElementById('schm-spec-img');
  const lbl     = document.getElementById('spec-source-label');
  const overlay = document.querySelector('.spec-hz-overlay');
  if (img)     img.src             = src.url + '?t=' + Date.now();
  if (lbl)     lbl.textContent     = win === 'day' ? 'SR · TOMSK (RU)' : 'ELF · ETNA-ERO (IT)';
  if (overlay) overlay.style.display = src.hzOverlay ? '' : 'none';
  document.querySelectorAll('.spec-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
};

/** Open spectrogram fullscreen lightbox */
window.openSpecZoom = function() {
  const src   = SPEC_SOURCES[_activeSpecKey];
  const modal = document.getElementById('spec-modal');
  const mimg  = document.getElementById('spec-modal-img');
  const minfo = document.getElementById('spec-modal-info');
  if (!modal || !mimg) return;
  mimg.src             = src.url + '?t=' + Date.now();
  if (minfo) minfo.textContent = src.label;
  modal.classList.add('open');
};

/** Close lightbox — backdrop click or ✕ button */
window.closeSpecZoom = function(e) {
  // Click directly on the image should NOT close
  if (e && e.target === document.getElementById('spec-modal-img')) return;
  document.getElementById('spec-modal')?.classList.remove('open');
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.closeSpecZoom();
});

async function fetchGeomag() {
  setGeo('wait');

  const now   = Date.now();
  const end   = new Date(now).toISOString().slice(0, 16);
  const start = new Date(now - 3_600_000).toISOString().slice(0, 16);

  const makeUrl = id => [
    `https://geomag.usgs.gov/ws/data/?id=${id}&format=json`,
    '&elements=F&sampling_period=60&type=variation',
    `&starttime=${start}&endtime=${end}`,
  ].join('');

  // Fetch 3 stations in parallel — GUA (Guam) and SJG (Puerto Rico) may time-out; handled gracefully
  const [dBOU, dGUA, dSJG] = await Promise.all([
    get(makeUrl('BOU')),
    get(makeUrl('GUA')),
    get(makeUrl('SJG')),
  ]);

  if (!dBOU?.values?.[0]) { setGeo('error'); return; }

  /** Extract valid F values from a station response */
  const extract = d => {
    if (!d?.values?.[0]) return [];
    return (d.values[0].values || []).filter(v => v !== null && Math.abs(v) < 99000);
  };

  /** Detrend: subtract mean so all 3 series share the same Y axis */
  const detrend = arr => {
    if (!arr.length) return [];
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.map(v => v - m);
  };

  const bouRaw = extract(dBOU);
  if (bouRaw.length < 4) { setGeo('error'); return; }

  const guaRaw = extract(dGUA);
  const sjgRaw = extract(dSJG);

  // Standard deviation of BOU as proxy for global EM activity
  const mean = bouRaw.reduce((a, b) => a + b, 0) / bouRaw.length;
  const sd   = Math.sqrt(bouRaw.reduce((a, b) => a + (b - mean) ** 2, 0) / bouRaw.length);

  document.getElementById('em-var').textContent = sd.toFixed(2);

  let emLabel, emCol;
  if      (sd < 1) { emLabel = 'CALM';   emCol = C.teal;  }
  else if (sd < 5) { emLabel = 'ACTIVE'; emCol = C.amber; }
  else             { emLabel = 'SPIKE';  emCol = C.red;   }

  // ── EM FIELD block (block 4) ─────────────────────────────────────────
  const stateEl = document.getElementById('em-state');
  stateEl.textContent       = emLabel;
  stateEl.style.color       = emCol;
  stateEl.style.borderColor = emCol;
  stateEl.style.background  = `${emCol}15`;

  const bouSlice = bouRaw.slice(-60);
  emChart.data.labels                      = bouSlice.map((_, i) => i);
  emChart.data.datasets[0].data            = bouSlice;
  emChart.data.datasets[0].borderColor     = emCol;
  emChart.data.datasets[0].backgroundColor = `${emCol}0d`;
  emChart.update('none');

  // ── SCHUMANN block (block 5) ─────────────────────────────────────────
  const schmStateEl = document.getElementById('schm-state');
  schmStateEl.textContent       = emLabel;
  schmStateEl.style.color       = emCol;
  schmStateEl.style.borderColor = emCol;
  schmStateEl.style.background  = `${emCol}15`;

  // Detrended series — same Y-axis scale across stations
  const bouD = detrend(bouRaw).slice(-60);
  const guaD = guaRaw.length >= 4 ? detrend(guaRaw).slice(-60) : [];
  const sjgD = sjgRaw.length >= 4 ? detrend(sjgRaw).slice(-60) : [];

  schmChart.data.labels               = bouD.map((_, i) => i);
  schmChart.data.datasets[0].data     = bouD;
  schmChart.data.datasets[1].data     = guaD;
  schmChart.data.datasets[2].data     = sjgD;
  schmChart.update('none');

  // Harmonic mode bars
  updateSchmBars(sd, emCol);

  // Globe splat arcs
  updateSchmGlobe(emLabel, emCol);

  setGeo('ok');
}


/* ═══════════════════════════════════════════════════
   BLOCK 4 — EARTHQUAKES (USGS FDSNWS)
   Endpoint: earthquake.usgs.gov — GeoJSON, M≥2.5
   Refresh: 5 min
   ═══════════════════════════════════════════════════ */
async function fetchEarthquakes() {
  setEq('wait');
  const data = await get(
    'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=3.5&limit=35&orderby=time'
  );

  if (!data?.features) { setEq('error'); return; }

  APP.earthquakes = data.features;

  // Count events in last 24 h
  const now   = Date.now();
  const cnt24 = data.features.filter(f => now - f.properties.time < 86_400_000).length;
  document.getElementById('eq-cnt').textContent = cnt24;

  // Render top-5 list
  const top5   = data.features.slice(0, 5);
  const listEl = document.getElementById('eq-list');

  listEl.innerHTML = top5.length
    ? top5.map(f => {
        const { mag, place, time } = f.properties;
        const depth = f.geometry.coordinates[2];
        // FIX: explicit null check for mag (USGS can return null for unresolved events)
        const mc = (mag != null && mag >= 6) ? C.red
                 : (mag != null && mag >= 4.5) ? C.amber
                 : C.teal;
        const dc = depth < 70 ? C.red : depth < 300 ? C.amber : C.blue;
        // FIX: escHtml() prevents XSS from API-supplied place names
        return `
          <div class="qitem">
            <span class="qmag" style="color:${mc}">M${(mag ?? 0).toFixed(1)}</span>
            <div class="qbody">
              <div class="qplace">${escHtml(place) || 'Unknown region'}</div>
              <div class="qrow2">
                <span class="qdepth" style="color:${dc}">${(depth ?? 0).toFixed(0)} km depth</span>
                <span class="qtime">${timeAgo(time)}</span>
              </div>
            </div>
          </div>`;
      }).join('')
    : '<div class="empty">No events</div>';

  updateGlobeEQ(data.features);
  setEq('ok');
}


/* ═══════════════════════════════════════════════════
   BLOCK 5 — SPACE EVENTS (NASA DONKI)
   Solar Flares: /DONKI/FLR  — last 30 d
   CME:          /DONKI/CME  — last 7 d
   NOTE: DEMO_KEY = 30 req/hour/IP. For production
         replace with a registered key from api.nasa.gov
   Refresh: 5 min
   ═══════════════════════════════════════════════════ */
async function fetchSpaceEvents() {
  setNasa('wait');

  const [flares, cmes] = await Promise.all([
    get(`https://api.nasa.gov/DONKI/FLR?api_key=${getNasaKey()}&startDate=${daysAgo(30)}`),
    get(`https://api.nasa.gov/DONKI/CME?api_key=${getNasaKey()}&startDate=${daysAgo(7)}`),
  ]);

  // ── Solar flares ──────────────────────────────────
  const flareEl = document.getElementById('flare-list');
  if (Array.isArray(flares) && flares.length) {
    const last3 = flares.slice(-3).reverse();
    flareEl.innerHTML = last3.map(f => {
      const cls = f.classType || '?';
      const col = cls[0] === 'X' ? C.red : cls[0] === 'M' ? C.amber : C.teal;
      // FIX: escHtml() on API-supplied sourceLocation
      return `
        <div class="eitem">
          <span class="ecls" style="color:${col}">${escHtml(cls)}</span>
          <div class="ebody">
            <div class="edesc">${escHtml(f.sourceLocation) || 'Solar disk'}</div>
            <div class="etime">${timeAgo(f.beginTime || f.peakTime)}</div>
          </div>
        </div>`;
    }).join('');
  } else {
    flareEl.innerHTML = '<div class="empty">No recent flares</div>';
  }

  // ── CMEs ──────────────────────────────────────────
  const cmeEl    = document.getElementById('cme-list');
  const CME_KEY  = 'csn_cme_v1';
  const CME_TTL  = 12 * 3_600_000; // 12 h cache

  let processed = null;

  if (Array.isArray(cmes) && cmes.length) {
    // Fresh data — extract and cache
    processed = cmes.slice(-2).reverse().map(c => {
      const a = c.cmeAnalyses?.find(x => x.isMostAccurate) ?? c.cmeAnalyses?.[0];
      return { speed: a?.speed ?? null, time: c.startTime };
    });
    try { localStorage.setItem(CME_KEY, JSON.stringify({ t: Date.now(), data: processed })); } catch (_) {}
  } else {
    // API failed / rate-limited / empty — try cache
    try {
      const cached = JSON.parse(localStorage.getItem(CME_KEY) || 'null');
      if (cached && Date.now() - cached.t < CME_TTL) processed = cached.data;
    } catch (_) {}
  }

  if (processed?.length) {
    cmeEl.innerHTML = processed.map(c => {
      const spd = c.speed ? `${Math.round(c.speed)} km/s` : 'Speed N/A';
      return `
        <div class="eitem">
          <span class="ecls" style="color:${C.amber}">CME</span>
          <div class="ebody">
            <div class="edesc">${escHtml(spd)}</div>
            <div class="etime">${timeAgo(c.time)}</div>
          </div>
        </div>`;
    }).join('');
    updateGlobeCME(processed);
  } else {
    cmeEl.innerHTML = '<div class="empty">No recent CMEs</div>';
  }

  // FIX: show 'ok' if at least one API returned a valid array (partial success ok),
  // 'error' only if both returned null (network/HTTP failure)
  setNasa(Array.isArray(flares) || Array.isArray(cmes) ? 'ok' : 'error');
}


/* ═══════════════════════════════════════════════════
   BLOCK 8 — SPACE WEATHER ALERTS (NOAA SWPC)
   Endpoints:
     /products/noaa-scales.json  → current G/R/S levels
     /products/alerts.json       → latest alert message
   Refresh: 5 min
   ═══════════════════════════════════════════════════ */

/** Paint the G / R / S alarm cells for one row */
function updateGRSRow(rowId, descId, level) {
  const container = document.getElementById(rowId);
  const cells = container ? container.querySelectorAll('.grs-cell') : [];
  // quiet class on container when level = 0
  if (container) container.classList.toggle('quiet', level === 0);
  cells.forEach(cell => {
    const lvl = parseInt(cell.dataset.lvl, 10);
    cell.className = 'grs-cell';
    if (lvl === level)    cell.classList.add(`on-${lvl}`);   // current — bright
    else if (lvl < level) cell.classList.add(`sub-${lvl}`);  // below — dim glow
    // above → stays dark (default)
  });
  // descId is handled by caller with richer text
}

async function fetchSWPCAlerts() {
  setSwpc('wait');

  const [scales, alerts] = await Promise.all([
    get('https://services.swpc.noaa.gov/products/noaa-scales.json'),
    get('https://services.swpc.noaa.gov/products/alerts.json'),
  ]);

  // ── G / R / S status board ─────────────────────
  // NOAA returns Scale as "0"–"5" OR "G0"–"G5" — handle both
  const parseScale = s => {
    const n = parseInt(s, 10);
    if (!isNaN(n)) return n;
    const m = String(s ?? '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };

  if (scales && scales['0']) {
    const today = scales['0'];
    const gLvl  = parseScale(today.G?.Scale);
    const rLvl  = parseScale(today.R?.Scale);
    const sLvl  = parseScale(today.S?.Scale);

    updateGRSRow('g-cells', 'g-text', gLvl);
    updateGRSRow('r-cells', 'r-text', rLvl);
    updateGRSRow('s-cells', 's-text', sLvl);

    const label = (lvl, letter, text) =>
      lvl > 0 ? `${letter}${lvl} · ${text ?? ''}` : 'NONE';

    const gDesc = document.getElementById('g-text');
    const rDesc = document.getElementById('r-text');
    const sDesc = document.getElementById('s-text');
    if (gDesc) gDesc.textContent = label(gLvl, 'G', today.G?.Text);
    if (rDesc) rDesc.textContent = label(rLvl, 'R', today.R?.Text);
    if (sDesc) sDesc.textContent = label(sLvl, 'S', today.S?.Text);

    // Show data timestamp from scales (not from alert)
    const ds = today.DateStamp ?? '';
    const ts = today.TimeStamp ?? '';
    // DateStamp may be "20260314" or "2026-03-14"
    const dateStr = ds.length === 8
      ? `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`
      : ds;
    // TimeStamp may be "2100" or "21:00:00"
    const timeStr = ts.includes(':') ? ts.slice(0, 5) : `${ts.slice(0,2)}:${ts.slice(2,4)}`;
    const dataEl = document.getElementById('alrt-msg');
    if (dataEl && dateStr) {
      dataEl.dataset.stamp = `DATA: ${dateStr} ${timeStr} UTC`;
    }
  }

  // ── Latest alert message ───────────────────────
  const msgEl = document.getElementById('alrt-msg');
  if (msgEl) {
    const stamp = msgEl.dataset.stamp ?? '';
    if (Array.isArray(alerts) && alerts.length) {
      const latest = alerts[alerts.length - 1];
      const raw    = latest.message || '';
      const lines  = raw.split('\n').map(l => l.trim()).filter(Boolean);
      // Skip boilerplate headers, find first content line
      const skipPat = /^(Space Weather Message|Serial Number|ISSUE TIME|NWS|www\.|NOAA\/NWS)/i;
      const summary = lines.find(l => l.length > 15 && !skipPat.test(l)) || lines[0] || '—';
      // Format issue date simply: "2026-02-12 12:00:00.000" → "12 Feb · 12:00 UTC"
      const dt = latest.issue_datetime ?? '';
      const dParts = dt.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
      const alertDate = dParts
        ? `${parseInt(dParts[3])} ${MONTHS[parseInt(dParts[2])-1]} · ${dParts[4]}:${dParts[5]} UTC`
        : '';
      msgEl.textContent =
        `${stamp ? stamp + '\n' : ''}LAST ALERT: ${alertDate}\n${escHtml(summary).slice(0, 100)}`;
    } else {
      msgEl.textContent = `${stamp ? stamp + '\n' : ''}No active alerts`;
    }
  }

  setSwpc(scales ? 'ok' : 'error');
}


/* ═══════════════════════════════════════════════════
   BLOCK 9 — PARTICLE FLUX (NOAA / GOES-18)
   Endpoints:
     /json/goes/primary/integral-protons-1-day.json
     /json/goes/primary/integral-electrons-1-day.json
   Channels: proton ≥10 MeV, electron ≥2.0 MeV
   Refresh: 5 min
   ═══════════════════════════════════════════════════ */
async function fetchParticleFlux() {
  const [protons, electrons] = await Promise.all([
    get('https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json'),
    get('https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json'),
  ]);

  if (!pfChart) return;

  // ── Proton ≥10 MeV ────────────────────────────
  let pLabels = [];
  if (Array.isArray(protons)) {
    const ch = protons.filter(d => d.energy === '>=10 MeV' && d.flux != null);
    const stride = Math.max(1, Math.floor(ch.length / 120));  // max 120 pts
    const pts    = ch.filter((_, i) => i % stride === 0);
    pLabels = pts.map(d => d.time_tag);
    pfChart.data.labels = pLabels;
    pfChart.data.datasets[0].data = pts.map(d => Math.max(d.flux, 0.005));

    // Update threshold lines length to match labels
    const n = pLabels.length;
    pfChart.data.datasets[2].data = Array(n).fill(10);
    pfChart.data.datasets[3].data = Array(n).fill(100);
    pfChart.data.datasets[4].data = Array(n).fill(1000);

    // Peak proton flux badge
    const peak = Math.max(...pts.map(d => d.flux));
    const peakEl = document.getElementById('pf-peak');
    if (peakEl && peak > 0) {
      const sLvl = peak >= 100000 ? 'S5' : peak >= 10000 ? 'S4' : peak >= 1000 ? 'S3'
                 : peak >= 100 ? 'S2' : peak >= 10 ? 'S1' : null;
      peakEl.textContent = `PEAK ${peak < 1 ? peak.toFixed(2) : Math.round(peak)} pfu${sLvl ? ' · ' + sLvl : ''}`;
      peakEl.style.color = sLvl ? C.amber : 'var(--dim)';
    }
  }

  // ── Electron ≥2.0 MeV ─────────────────────────
  if (Array.isArray(electrons)) {
    const ch = electrons.filter(d => d.energy === '>=2.0 MeV' && d.flux != null);
    const stride = Math.max(1, Math.floor(ch.length / 120));
    const pts    = ch.filter((_, i) => i % stride === 0);

    // Align to proton labels length
    const nTarget = pLabels.length || pts.length;
    const ePts    = pts.slice(-nTarget);
    pfChart.data.datasets[1].data = ePts.map(d => Math.max(d.flux, 0.005));
  }

  pfChart.update('none');
  setSwpc('ok');
}


/* ═══════════════════════════════════════════════════
   BLOCK 3 — X-RAY FLUX (NOAA / GOES-Primary)
   Endpoint: /json/goes/primary/xrays-7-day.json
   Channel:  0.1–0.8 nm (long channel — flare classification)
   Refresh:  60 s (1-min cadence at source)
   ═══════════════════════════════════════════════════ */
async function fetchXRay() {
  setGoes('wait');
  const data = await get(
    'https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json'
  );

  if (!Array.isArray(data) || !data.length) { setGoes('error'); return; }

  // Long channel (0.1–0.8 nm) is the standard flare classification channel
  const longCh = data.filter(d => d.energy === '0.1-0.8nm' && d.flux != null && d.flux > 0);
  if (!longCh.length) { setGoes('error'); return; }

  const last = longCh[longCh.length - 1];
  const flux = last.flux;
  const cls  = xrayClass(flux);
  const col  = xrayColor(cls[0]);

  const clsEl  = document.getElementById('xr-cls');
  const fluxEl = document.getElementById('xr-flux');
  clsEl.textContent      = cls;
  clsEl.style.color      = col;
  clsEl.style.textShadow = `0 0 16px ${col}77`;
  fluxEl.textContent     = flux.toExponential(2);
  updateSubsolar(flux);

  // Sparkline: last ~24 h at 1-min cadence → up to 1440 pts, sample every 10th
  const slice = longCh.slice(-1440);
  const pts   = slice.filter((_, i) => i % 10 === 0);
  xrChart.data.labels                      = pts.map((_, i) => i);
  xrChart.data.datasets[0].data            = pts.map(d => d.flux);
  xrChart.data.datasets[0].borderColor     = col;
  xrChart.data.datasets[0].backgroundColor = `${col}15`;
  xrChart.update('none');

  setGoes('ok');
}


/* ═══════════════════════════════════════════════════
   ORCHESTRATION
   ═══════════════════════════════════════════════════ */
function stampRefresh() {
  document.getElementById('refresh-txt').textContent = `Refreshed ${utcTime()}`;
}

/**
 * Fast group: NOAA + Geomag — every 60 s
 * FIX: in-flight guard prevents duplicate concurrent fetches on slow connections
 */
async function refreshFast() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    await Promise.all([fetchSolarWind(), fetchMag(), fetchKpIndex(), fetchGeomag(), fetchXRay()]);
    stampRefresh();
  } finally {
    fastBusy = false;
  }
}

/**
 * Slow group: USGS-EQ + NASA — every 5 min
 * FIX: in-flight guard prevents duplicate concurrent fetches
 */
async function refreshSlow() {
  if (slowBusy) return;
  slowBusy = true;
  try {
    await Promise.all([fetchEarthquakes(), fetchSpaceEvents(), fetchSWPCAlerts(), fetchParticleFlux()]);
    stampRefresh();
  } finally {
    slowBusy = false;
  }
}

/** Initial full refresh at boot */
async function refreshAll() {
  await Promise.all([refreshFast(), refreshSlow()]);
}


/* ═══════════════════════════════════════════════════
   PANEL TOGGLE CHIPS
   Persists hidden blocks to localStorage ('csn-hidden')
   ═══════════════════════════════════════════════════ */
function initChips() {
  const hidden = new Set(JSON.parse(localStorage.getItem('csn-hidden') || '[]'));

  document.querySelectorAll('.pchip').forEach(btn => {
    const blockId = btn.dataset.block;
    const block   = document.getElementById(blockId);

    // Restore hidden state from storage
    if (hidden.has(blockId)) {
      btn.classList.remove('on');
      if (block) block.style.display = 'none';
    }

    btn.addEventListener('click', () => {
      const isOn = btn.classList.toggle('on');
      if (block) block.style.display = isOn ? '' : 'none';
      if (isOn) hidden.delete(blockId);
      else      hidden.add(blockId);
      localStorage.setItem('csn-hidden', JSON.stringify([...hidden]));
    });
  });
}


/* ═══════════════════════════════════════════════════
   SOLAR SYSTEM — Geocentric overlay canvas
   Earth (= the Globe) sits at canvas center.
   Planets placed at correct geocentric ecliptic angles
   computed from J2000.0 mean Keplerian elements.
   Radial scale is visual (ring_f × maxR) — angular
   positions are accurate to < 2° for most situations.
   ═══════════════════════════════════════════════════ */

const _D2R = Math.PI / 180;

// Earth mean elements (J2000.0)
const _E_L0 = 100.46457, _E_n = 0.98564736;

// Planet mean elements + visual properties
// rf = ring fraction (planet's orbit ring as % of maxR)
const SOL_PLANETS = [
  { abbr:'Hg', col:'#9a9aae', L0:252.25084, n:4.09233445, a:0.387, pr:4,   rf:0.19 },
  { abbr:'V',  col:'#f5e078', L0:181.97973, n:1.60213874, a:0.723, pr:5.5, rf:0.30 },
  { abbr:'Ma', col:'#e26060', L0:355.45332, n:0.52402068, a:1.524, pr:4.5, rf:0.45 },
  { abbr:'J',  col:'#f5a055', L0: 34.89427, n:0.08308529, a:5.203, pr:9,   rf:0.65, glow:true },
  { abbr:'S',  col:'#c0d4f0', L0: 49.55953, n:0.03344927, a:9.537, pr:8,   rf:0.83, satRing:true },
].map(p => ({ ...p, rgb: hexToRgb(p.col) }));

/**
 * Geocentric ecliptic angle (rad) — direction from Earth to planet.
 * Uses simplified circular orbits (mean longitude only).
 * Accuracy: ~1–3° (sufficient for a background visual).
 */
function solGeoAngle(planet, dJ) {
  const Lp = ((planet.L0 + planet.n * dJ) % 360 + 360) % 360 * _D2R;
  const Le = ((_E_L0   + _E_n   * dJ) % 360 + 360) % 360 * _D2R;
  return Math.atan2(
    planet.a * Math.sin(Lp) - Math.sin(Le),
    planet.a * Math.cos(Lp) - Math.cos(Le)
  );
}

/** Geocentric angle from Earth toward Sun */
function solSunAngle(dJ) {
  const Le = ((_E_L0 + _E_n * dJ) % 360 + 360) % 360 * _D2R;
  return Math.atan2(-Math.sin(Le), -Math.cos(Le));
}

// ── Planet metadata for interactivity ──
const SOL_PLANET_INFO = {
  E:  { name:'Earth',   type:'Terrestrial', period:'365.25 d', fact:'Only known inhabited world · 1.00 AU' },
  Hg: { name:'Mercury', type:'Terrestrial', period:'87.97 d',  fact:'No atmosphere · extreme temp swings' },
  V:  { name:'Venus',   type:'Terrestrial', period:'224.70 d', fact:'Hottest planet · avg 465 °C surface' },
  Ma: { name:'Mars',    type:'Terrestrial', period:'686.97 d', fact:'Olympus Mons · largest volcano' },
  J:  { name:'Jupiter', type:'Gas Giant',   period:'11.86 yr', fact:'Great Red Spot active 350+ years' },
  S:  { name:'Saturn',  type:'Gas Giant',   period:'29.46 yr', fact:'Rings span 282,000 km across' },
};

// ── State ──
let _solCanvas = null, _solCtx = null;
let _solOn      = true;
let _solLastTs  = 0;
let _solHovered = null;
let _solSelected= null;
let _solMouseX  = -9999, _solMouseY = -9999;
const _solPlanetPos = {};  // { abbr: { px, py, hR } }

// Per-object visibility toggled by sol-controls chips
const _solVisible = {
  SOL: true, Hg: true, V: true, E: true,
  Ma: true,  J: true,  S: true, ORBITS: true,
};

function initSolarSystem() {
  // Globe.gl replaces #globe-wrap innerHTML on mount, so we must
  // create the canvas programmatically AFTER initGlobe() runs.
  const wrap = document.getElementById('globe-wrap');
  if (!wrap) return;
  _solCanvas = document.createElement('canvas');
  _solCanvas.id = 'solar-bg';
  wrap.appendChild(_solCanvas);
  _solCtx = _solCanvas.getContext('2d');

  // Match canvas pixel size to globe-wrap
  function resizeSol() {
    const wrap = document.getElementById('globe-wrap');
    if (!wrap) return;
    const { width: w, height: h } = wrap.getBoundingClientRect();
    if (w > 0 && h > 0) {
      _solCanvas.width  = w;
      _solCanvas.height = h;
    }
  }
  resizeSol();
  setTimeout(resizeSol, 120);    // retry after first paint
  setTimeout(resizeSol, 900);    // fallback for slow layouts
  new ResizeObserver(resizeSol).observe(document.getElementById('globe-wrap'));

  // ── Planet visibility control bar (top-center of globe) ──
  const solCtrlDefs = [
    { key:'SOL',    label:'SOL',    col:'#ffd840' },
    { key:'Hg',     label:'Hg',     col:'#9a9aae' },
    { key:'V',      label:'V',      col:'#f5e078' },
    { key:'E',      label:'E',      col:'#00f5c4' },
    { key:'Ma',     label:'Ma',     col:'#e26060' },
    { key:'J',      label:'J',      col:'#f5a055' },
    { key:'S',      label:'S',      col:'#c0d4f0' },
    null,  // separator
    { key:'ORBITS', label:'ORBITS', col:'#4a7a9b' },
  ];
  const solCtrl = document.createElement('div');
  solCtrl.id = 'sol-controls';
  solCtrlDefs.forEach(def => {
    if (!def) {
      const sep = document.createElement('div');
      sep.className = 'sol-sep';
      solCtrl.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'sol-chip';
    btn.textContent = def.label;
    btn.style.color = def.col;
    btn.style.borderColor = def.col + '55';
    btn.dataset.solKey = def.key;
    btn.addEventListener('click', () => {
      _solVisible[def.key] = !_solVisible[def.key];
      btn.classList.toggle('off', !_solVisible[def.key]);
    });
    solCtrl.appendChild(btn);
  });
  wrap.appendChild(solCtrl);

  // SOLAR chip toggle (independent of sidebar chip system)
  const chip = document.getElementById('chip-solar');
  if (chip) {
    chip.addEventListener('click', () => {
      _solOn = chip.classList.toggle('on');
      _solCanvas.classList.toggle('sol-off', !_solOn);
    });
    chip.classList.add('on');  // start enabled
  }

  // ── Hover / click — document-level so Globe.gl can't override cursor ──
  document.addEventListener('mousemove', e => {
    if (!_solOn || !_solCanvas) { _solHovered = null; return; }
    const rect = _solCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) {
      if (_solHovered) { _solHovered = null; document.body.style.cursor = ''; }
      return;
    }
    let hit = null;
    const allKeys = ['E', ...SOL_PLANETS.map(p => p.abbr)];
    for (const key of allKeys) {
      const pos = _solPlanetPos[key];
      if (!pos) continue;
      const dx = mx - pos.px, dy = my - pos.py;
      if (Math.sqrt(dx * dx + dy * dy) < pos.hR) { hit = key; break; }
    }
    if (hit !== _solHovered) {
      _solHovered = hit;
      document.body.style.cursor = hit ? 'pointer' : '';
    }
  });

  document.addEventListener('click', e => {
    if (!_solOn || !_solCanvas) return;
    const rect = _solCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
    _solSelected = _solHovered
      ? (_solSelected === _solHovered ? null : _solHovered)
      : null;
  });

  // Expose internals for debugging / eval access
  window._dbgSol = { pos: _solPlanetPos, on: () => _solOn, hov: () => _solHovered };

  requestAnimationFrame(_solFrame);
}

function _solFrame(ts) {
  requestAnimationFrame(_solFrame);
  if (!_solOn || !_solCanvas || !_solCtx) return;
  if (ts - _solLastTs < 50) return;   // ~20 fps cap
  _solLastTs = ts;
  drawSolarSystem(ts);
}

function drawSolarSystem(ts) {
  const cv = _solCanvas, ctx = _solCtx;
  if (!cv || !ctx) return;
  const W = cv.width, H = cv.height;
  if (!W || !H) return;

  ctx.clearRect(0, 0, W, H);

  const cx   = W / 2;
  const cy   = H / 2;
  const maxR = Math.min(cx, cy) * 0.91;

  // Days since J2000.0
  const dJ = Date.now() / 86_400_000 + 2440587.5 - 2451545.0;

  // ── Heliocentric layout ───────────────────────────────────
  // Sun at (cx, cy).  Use sqrt(AU) scaling so inner planets
  // aren't squashed — Saturn fills ~88% of maxR.
  const s  = maxR * 0.88 / Math.sqrt(9.537);   // px per sqrt(AU)
  const Le = ((_E_L0 + _E_n * dJ) % 360 + 360) % 360 * _D2R;
  const eX = cx + s * Math.cos(Le);   // Earth canvas position
  const eY = cy - s * Math.sin(Le);

  // ── Diffuse solar corona ──────────────────────────────────
  if (_solVisible['SOL']) {
    const sgBig = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.55);
    sgBig.addColorStop(0,    'rgba(255,200,60,0.13)');
    sgBig.addColorStop(0.25, 'rgba(255,150,30,0.05)');
    sgBig.addColorStop(0.65, 'rgba(255,100,10,0.01)');
    sgBig.addColorStop(1,    'rgba(255,80,0,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = sgBig;
    ctx.fill();
  }

  // ── Radial ecliptic grid ──────────────────────────────────
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + maxR * Math.cos(a), cy - maxR * Math.sin(a));
    ctx.strokeStyle = 'rgba(0,245,196,0.018)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  // ── Orbit rings (heliocentric, centered on Sun) ───────────
  // Helper: draw 3-pass orbit ring (outer glow → inner glow → crisp line)
  function drawOrbit(r, R, G, B) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${R},${G},${B},0.04)`; ctx.lineWidth = 9; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${R},${G},${B},0.09)`; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${R},${G},${B},0.38)`; ctx.lineWidth = 0.6; ctx.stroke();
  }

  const eOrbitR = s;
  if (_solVisible['ORBITS'] && _solVisible['E']) drawOrbit(eOrbitR, 0, 245, 196);

  SOL_PLANETS.forEach(p => {
    if (!_solVisible['ORBITS'] || !_solVisible[p.abbr]) return;
    drawOrbit(s * Math.sqrt(p.a), ...p.rgb);
  });

  // ── Sun disc ──────────────────────────────────────────────
  if (_solVisible['SOL']) {
    const sPulse = 0.06 + 0.04 * Math.sin(ts * 0.0007);
    const outerR = 50 + 8 * Math.sin(ts * 0.0004);
    const corona = ctx.createRadialGradient(cx, cy, 6, cx, cy, outerR);
    corona.addColorStop(0,    `rgba(255,240,130,${sPulse + 0.08})`);
    corona.addColorStop(0.35, `rgba(255,180,40,${sPulse})`);
    corona.addColorStop(0.70, `rgba(255,100,10,0.02)`);
    corona.addColorStop(1,    'rgba(255,80,0,0)');
    ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = corona; ctx.fill();

    const sunGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 28);
    sunGlow.addColorStop(0,    'rgba(255,252,210,1)');
    sunGlow.addColorStop(0.25, 'rgba(255,228,110,0.90)');
    sunGlow.addColorStop(0.60, 'rgba(255,160,30,0.40)');
    sunGlow.addColorStop(1,    'rgba(255,100,0,0)');
    ctx.beginPath(); ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fillStyle = sunGlow; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fffde0'; ctx.fill();

    ctx.font = '500 8px "Fira Code",monospace';
    ctx.fillStyle = 'rgba(255,218,90,0.55)';
    ctx.textAlign = 'center';
    ctx.fillText('SOL', cx, cy - 22);
  }

  // ── Helper: draw a 3D sphere ──────────────────────────────
  function drawSphere(px, py, pr, r, g, b, litX, litY) {
    const lA  = Math.atan2(litY - py, litX - px);
    const lx  = px + Math.cos(lA) * pr * 0.42;
    const ly  = py + Math.sin(lA) * pr * 0.42;
    const sph = ctx.createRadialGradient(lx, ly, 0, px, py, pr);
    sph.addColorStop(0,    `rgba(${Math.min(255,r+80)},${Math.min(255,g+80)},${Math.min(255,b+80)},1)`);
    sph.addColorStop(0.40, `rgba(${r},${g},${b},1)`);
    sph.addColorStop(0.75, `rgba(${Math.max(0,r-55)},${Math.max(0,g-55)},${Math.max(0,b-55)},1)`);
    sph.addColorStop(1,    `rgba(${Math.max(0,r-90)},${Math.max(0,g-90)},${Math.max(0,b-90)},1)`);
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fillStyle = sph; ctx.fill();
    // specular
    const sx = px + Math.cos(lA) * pr * 0.55, sy = py + Math.sin(lA) * pr * 0.55;
    const sp = ctx.createRadialGradient(sx, sy, 0, sx, sy, pr * 0.38);
    sp.addColorStop(0, 'rgba(255,255,255,0.55)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(sx, sy, pr * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = sp; ctx.fill();
  }

  // ── Planets ───────────────────────────────────────────────
  SOL_PLANETS.forEach(p => {
    if (!_solVisible[p.abbr]) return;
    const Lp = ((p.L0 + p.n * dJ) % 360 + 360) % 360 * _D2R;
    const diR = s * Math.sqrt(p.a);
    const px  = cx + diR * Math.cos(Lp);
    const py  = cy - diR * Math.sin(Lp);
    const [r, g, b] = p.rgb;

    // Atmosphere
    const atmR = p.glow ? p.pr * 5.0 : p.pr * 3.2;
    const atm  = ctx.createRadialGradient(px, py, p.pr * 0.6, px, py, atmR);
    atm.addColorStop(0,   `rgba(${r},${g},${b},0.28)`);
    atm.addColorStop(0.5, `rgba(${r},${g},${b},0.07)`);
    atm.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    ctx.beginPath(); ctx.arc(px, py, atmR, 0, Math.PI * 2);
    ctx.fillStyle = atm; ctx.fill();

    // Saturn ring — back half
    if (p.satRing) {
      ctx.save(); ctx.translate(px, py); ctx.rotate(-0.38);
      ctx.beginPath(); ctx.ellipse(0, 0, p.pr*3.0, p.pr*0.65, 0, Math.PI, Math.PI*2);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, p.pr*2.2, p.pr*0.48, 0, Math.PI, Math.PI*2);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.18)`; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }

    // 3D sphere (light from Sun at cx,cy)
    drawSphere(px, py, p.pr, r, g, b, cx, cy);

    // Saturn ring — front half
    if (p.satRing) {
      ctx.save(); ctx.translate(px, py); ctx.rotate(-0.38);
      ctx.beginPath(); ctx.ellipse(0, 0, p.pr*3.0, p.pr*0.65, 0, 0, Math.PI);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.60)`; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, p.pr*2.2, p.pr*0.48, 0, 0, Math.PI);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }

    // Hit area
    const hR = Math.max(p.pr * 3.5, 14);
    _solPlanetPos[p.abbr] = { px, py, hR };

    // Hover / select ring
    const isAct = _solHovered === p.abbr || _solSelected === p.abbr;
    if (isAct) {
      ctx.beginPath(); ctx.arc(px, py, p.pr + 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.lineWidth = 1.5; ctx.setLineDash([3,4]); ctx.stroke(); ctx.setLineDash([]);
      if (_solSelected === p.abbr) {
        ctx.beginPath(); ctx.arc(px, py, p.pr + 11, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r},${g},${b},0.28)`; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // Leader line from label baseline to planet edge
    const labelY  = py - p.pr - 15;
    const edgeY   = py - p.pr - 2;
    ctx.beginPath();
    ctx.moveTo(px, labelY + 1);
    ctx.lineTo(px, edgeY);
    ctx.strokeStyle = `rgba(${r},${g},${b},${isAct ? 0.55 : 0.28})`;
    ctx.lineWidth = 0.7; ctx.setLineDash([]); ctx.stroke();

    ctx.font = isAct ? '700 9px "Fira Code",monospace' : '500 8px "Fira Code",monospace';
    ctx.fillStyle = isAct ? `rgba(${r},${g},${b},1)` : `rgba(${r},${g},${b},0.72)`;
    ctx.textAlign = 'center';
    ctx.fillText(p.abbr, px, labelY);
  });

  // ── Earth at heliocentric position ────────────────────────
  const t      = ts * 0.001;
  const ePulse = 9 + Math.sin(t * 1.3) * 2.5;
  const eAlpha = 0.55 + 0.25 * Math.sin(t * 1.3);

  if (_solVisible['E']) {
    // Outer soft glow halo
    const eAtm = ctx.createRadialGradient(eX, eY, 5, eX, eY, 24);
    eAtm.addColorStop(0,   'rgba(0,245,196,0.18)');
    eAtm.addColorStop(0.55,'rgba(0,200,160,0.06)');
    eAtm.addColorStop(1,   'rgba(0,245,196,0)');
    ctx.beginPath(); ctx.arc(eX, eY, 24, 0, Math.PI * 2);
    ctx.fillStyle = eAtm; ctx.fill();

    // 3D sphere (light from Sun)
    drawSphere(eX, eY, 6, 30, 150, 220, cx, cy);

    // Pulsing ring
    ctx.beginPath(); ctx.arc(eX, eY, ePulse, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,245,196,${eAlpha.toFixed(2)})`;
    ctx.lineWidth = 1.2; ctx.stroke();

    // Crosshair tick marks at cardinal points on the pulsing ring
    [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach(angle => {
      const tx1 = eX + Math.cos(angle) * (ePulse - 3);
      const ty1 = eY + Math.sin(angle) * (ePulse - 3);
      const tx2 = eX + Math.cos(angle) * (ePulse + 3.5);
      const ty2 = eY + Math.sin(angle) * (ePulse + 3.5);
      ctx.beginPath(); ctx.moveTo(tx1, ty1); ctx.lineTo(tx2, ty2);
      ctx.strokeStyle = `rgba(0,245,196,${(eAlpha * 0.7).toFixed(2)})`;
      ctx.lineWidth = 0.8; ctx.stroke();
    });

    // Hit area
    _solPlanetPos['E'] = { px: eX, py: eY, hR: 22 };

    // Hover / select ring
    const eAct = _solHovered === 'E' || _solSelected === 'E';
    if (eAct) {
      ctx.beginPath(); ctx.arc(eX, eY, 14, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,245,196,0.80)';
      ctx.lineWidth = 1.2; ctx.setLineDash([3,5]); ctx.stroke(); ctx.setLineDash([]);
      if (_solSelected === 'E') {
        ctx.beginPath(); ctx.arc(eX, eY, 21, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,245,196,0.25)'; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }

    // Leader line + label
    const eLabelY = eY - ePulse - 11;
    ctx.beginPath();
    ctx.moveTo(eX, eLabelY + 1);
    ctx.lineTo(eX, eY - ePulse - 2);
    ctx.strokeStyle = `rgba(0,245,196,${eAct ? 0.55 : 0.32})`;
    ctx.lineWidth = 0.7; ctx.setLineDash([]); ctx.stroke();

    ctx.font = eAct ? '700 9px "Fira Code",monospace' : '500 8px "Fira Code",monospace';
    ctx.fillStyle = eAct ? 'rgba(0,245,196,1)' : 'rgba(0,245,196,0.82)';
    ctx.textAlign = 'center';
    ctx.fillText('E', eX, eLabelY);
  }

  // ── CME shockwave from Earth ──────────────────────────────
  if (_solVisible['E'] && typeof cmeArcs !== 'undefined' && cmeArcs.length > 0) {
    const f      = ((Date.now() / 9000) % 1);
    const waveR  = 10 + f * maxR * 0.55;
    const wAlpha = (1 - f) * 0.42;
    ctx.beginPath(); ctx.arc(eX, eY, waveR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(245,166,35,${wAlpha.toFixed(2)})`;
    ctx.lineWidth = 2; ctx.stroke();
  }

  // ── Tooltip on hover ──────────────────────────────────────
  if (_solHovered && _solPlanetPos[_solHovered]) {
    _solDrawTooltip(ctx, _solPlanetPos[_solHovered], dJ, W);
  }

  // ── Info panel on click ───────────────────────────────────
  if (_solSelected && _solPlanetPos[_solSelected]) {
    _solDrawInfoPanel(ctx, H, dJ);
  }

  // ── Date stamp ────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  ctx.font = '400 8px "Fira Code",monospace';
  ctx.fillStyle = 'rgba(72,96,122,0.50)';
  ctx.textAlign = 'right';
  ctx.fillText('HELIOCENTRIC · ' + dateStr, W - 14, H - 14);
}

// ── Distance from Earth to planet (AU) ───────────────────────
function _solDist(abbr, dJ) {
  if (abbr === 'E') return 0;
  const p = SOL_PLANETS.find(q => q.abbr === abbr);
  if (!p) return 0;
  const Le  = ((_E_L0 + _E_n * dJ) % 360 + 360) % 360 * _D2R;
  const Lp  = ((p.L0  + p.n   * dJ) % 360 + 360) % 360 * _D2R;
  const dx  = p.a * Math.cos(Lp) - Math.cos(Le);
  const dy  = p.a * Math.sin(Lp) - Math.sin(Le);
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Colour helper (handles Earth 'E') ────────────────────────
function _solColor(abbr) {
  if (abbr === 'E') return [0, 245, 196];
  const p = SOL_PLANETS.find(q => q.abbr === abbr);
  return p ? hexToRgb(p.col) : [150, 180, 210];
}

// ── Hover tooltip ─────────────────────────────────────────────
function _solDrawTooltip(ctx, pos, dJ, canvasW) {
  const info = SOL_PLANET_INFO[_solHovered];
  if (!info) return;
  const [r, g, b] = _solColor(_solHovered);
  const dist  = _solDist(_solHovered, dJ).toFixed(2);
  const lines = [info.name, dist + ' AU from Earth'];
  const pad   = 9, lh = 15, pw = 130, ph = pad * 2 + lh * lines.length;
  let tx = pos.px - pw / 2;
  tx = Math.max(6, Math.min(tx, canvasW - pw - 6));
  const ty = pos.py - pos.hR - ph - 6;

  ctx.fillStyle = 'rgba(6,14,24,0.88)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, pw, ph, 5);
  ctx.fill();
  ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
  ctx.lineWidth   = 0.8;
  ctx.stroke();

  ctx.textAlign = 'left';
  lines.forEach((l, i) => {
    ctx.font      = i === 0 ? '700 10px "Fira Code",monospace' : '400 9px "Fira Code",monospace';
    ctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(170,200,225,0.90)';
    ctx.fillText(l, tx + pad, ty + pad + lh * i + 10);
  });
}

// ── Click info panel ──────────────────────────────────────────
function _solDrawInfoPanel(ctx, canvasH, dJ) {
  const info = SOL_PLANET_INFO[_solSelected];
  if (!info) return;
  const [r, g, b] = _solColor(_solSelected);
  const distVal = _solDist(_solSelected, dJ);
  const distTxt = _solSelected === 'E' ? '1.000 AU (you are here)' : distVal.toFixed(3) + ' AU from Earth';
  const rows  = [
    { text: info.name,              font:'700 11px', col:'#ffffff' },
    { text: info.type,              font:'400 9px',  col:`rgba(${r},${g},${b},0.95)` },
    { text: 'Period  ' + info.period, font:'400 9px', col:'rgba(150,185,215,0.90)' },
    { text: 'Dist    ' + distTxt,   font:'400 9px',  col:'rgba(150,185,215,0.90)' },
    { text: info.fact,              font:'400 8px',  col:'rgba(110,155,190,0.80)' },
  ];
  const pad = 11, lh = 16, pw = 168, ph = pad * 2 + lh * rows.length + 2;
  const tx = 14, ty = canvasH - ph - 16;

  ctx.fillStyle = 'rgba(5,12,22,0.90)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, pw, ph, 7);
  ctx.fill();
  ctx.strokeStyle = `rgba(${r},${g},${b},0.45)`;
  ctx.lineWidth   = 1;
  ctx.stroke();

  // Colour accent bar on left edge
  ctx.fillStyle = `rgba(${r},${g},${b},0.55)`;
  ctx.beginPath();
  ctx.roundRect(tx, ty + 8, 3, ph - 16, 2);
  ctx.fill();

  ctx.textAlign = 'left';
  rows.forEach(({ text, font, col }, i) => {
    ctx.font      = `${font} "Fira Code",monospace`;
    ctx.fillStyle = col;
    ctx.fillText(text, tx + pad + 4, ty + pad + lh * i + 11);
  });

  // Close hint
  ctx.font      = '400 7px "Fira Code",monospace';
  ctx.fillStyle = 'rgba(90,120,150,0.60)';
  ctx.textAlign = 'right';
  ctx.fillText('click to close', tx + pw - pad, ty + ph - 5);
}


/* ═══════════════════════════════════════════════════
   BOOT
   FIX: readyState guard prevents double-boot if script
        loads after DOMContentLoaded has already fired
   ═══════════════════════════════════════════════════ */
let booted = false;   // extra guard against any edge-case double-call

function boot() {
  if (booted) return;
  booted = true;

  initGlobe();

  initCharts();
  initChips();
  initNasaKeyUI();
  initSolarSystem();
  refreshAll();

  setInterval(refreshFast,  60_000);   // 60 s
  setInterval(refreshSlow, 300_000);   // 5 min
}

// Clock runs independently of boot
tickClock();
setInterval(tickClock, 1000);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
