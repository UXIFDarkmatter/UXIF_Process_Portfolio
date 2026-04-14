import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Lensflare, LensflareElement } from "three/addons/objects/Lensflare.js";

// --- Config ---------------------------------------------------------------
// Edit titles here. Front (1) -> back (4).
const CARDS = [
  { src: "images/Wildcard1.png", title: "Component Guide" },
  { src: "images/Wildcard2.png", title: "UI Design" },
  { src: "images/Wildcard3.png", title: "UX Design", video: "images/UX_Wires_04_V3.mp4" },
  { src: "images/Wildcard4.png", title: "UX Audit" },
];

// Speed multiplier for video playback. 1.0 = real-time, 2.0 = 2x faster, etc.
const VIDEO_PLAYBACK_RATE = 2.0;

const CARD_WIDTH = 4; // world units; height derived from image aspect
const STACK_OFFSET = { x: 0.55, y: 0.45, z: -1.1 }; // each card behind the previous

const ORANGE = "#ff7a1a";
const CORNER_RADIUS_PX = 28; // corner radius on the card texture (pixels on source image)
const BORDER_PX = 8; // orange border thickness
const TAB_HEIGHT_RATIO = 0.11; // tab height as % of card HEIGHT
const TAB_WIDTH_RATIO = 0.32; // tab width as % of card WIDTH
const TAB_OFFSET_RATIO = 0.06; // tab left margin as % of card WIDTH

// --- Renderer / Scene -----------------------------------------------------
const canvas = document.getElementById("bg");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x06080d, 0.05);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(4.25, 2.125, 7.65);

// --- Post-processing (bloom + depth of field) -----------------------------
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.setSize(window.innerWidth, window.innerHeight);

composer.addPass(new RenderPass(scene, camera));

// Depth of field — focus follows the orbit target each frame
const bokehPass = new BokehPass(scene, camera, {
  focus: 9.0,
  aperture: 0.00025, // smaller = wider depth of field (less blur)
  maxblur: 0.0018,
});
composer.addPass(bokehPass);

// Bloom — only the brightest elements (glow, sparkles) bloom
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.28, // strength
  0.5, // radius
  0.85 // threshold
);
composer.addPass(bloomPass);

composer.addPass(new OutputPass());

// --- Orbit controls -------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.7;
controls.enableZoom = false;
controls.enablePan = false;
controls.minDistance = 3;
// maxDistance set below to lock the starting zoom as the farthest allowed.
controls.enabled = false; // Enabled after intro animation completes


// Mouse-driven subtle orbit (replaces drag-orbit). The camera direction
// follows the pointer smoothly within a very small angular range.
const baseAz = Math.atan2(camera.position.x, camera.position.z);
const basePolar = Math.acos(camera.position.y / camera.position.length());
let smoothAz = baseAz;
let smoothPolar = basePolar;
const MOUSE_AZ_RANGE = 0.12;    // ±~7° horizontal
const MOUSE_POLAR_RANGE = 0.07; // ±~4° vertical
const MOUSE_SMOOTH = 0.04;       // per-frame smoothing factor

// --- Intro animation state ------------------------------------------------
// Intro timeline (all times in seconds from intro start).
// Sequence:
//   UX Audit slides up, floaty camera while it holds alone,
//   UX Design slides up, hold, UI Design slides up, hold,
//   Zoom back (camera + stack rotate to final), last leg of zoom back
//   the three cards separate into their spread positions,
//   then Component Guide zooms back from close-to-camera to settle in front.
const INTRO_TIMINGS = {
  uxAudit:   { start: 0.3, duration: 0.6 },
  uxDesign:  { start: 1.8, duration: 0.25 },
  // After the UX Design video plays, zoom back + separate. During separation,
  // UX Audit pushes back, UX Design settles, AND UI Design pushes forward
  // simultaneously (fading in as it goes).
  zoomBack:  { start: 12.6, duration: 1.9 },
  separate:  { start: 13.7, duration: 0.9 },
  componentEntry: { start: 14.7, duration: 0.9 },
};

function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}

const cardMeshes = []; // set in buildStack
const introStackedPos = []; // where cards end up after sliding (tightly stacked, facing camera)
const finalPos = []; // original stack-spread positions
const introCameraPos = new THREE.Vector3(0, 0.3, 3.6);
const introTarget = new THREE.Vector3(0, 0.3, 0);
const finalCameraPos = new THREE.Vector3();
const finalTarget = new THREE.Vector3();
const componentEntryStartLocal = new THREE.Vector3();
let finalStackRotX = 0;
let finalStackRotY = 0;

// Background character (Bolgar_Burr_Versus) — parented to camera so it
// stays pinned to the right side of the screen regardless of orbit.
let characterMesh = null;
let bgMeshRef = null; // BG image plane for parallax
let emberGeo = null;  // ember particle geometry (updated per-frame)
const emberVelocities = []; // per-particle upward drift speed
const EMBER_COUNT = 180;

// --- Detail (tab) view state -----------------------------------------------
let viewMode = "3d"; // "3d" | "to-detail" | "detail" | "to-3d"
let activeCardIndex = -1;
let detailProgress = 0; // 0 = 3D layout, 1 = tab layout
let lastFrameTime = 0;
const savedWorldPositions = []; // card world positions at moment of entering detail
const savedWorldQuats = [];     // card world quaternions at moment of entering detail
const tabWorldPositions = [];   // target world positions in tab layout
const tabWorldQuat = new THREE.Quaternion(); // shared facing-camera quaternion
const tabActiveOffset = new THREE.Vector3(); // offset pushing active card toward camera
const saved3DCameraPos = new THREE.Vector3();
const detailCameraPos = new THREE.Vector3();
const detailCameraTarget = new THREE.Vector3();

// References to overlay DOM (wired up after DOM ready)
let detailOverlay, detailTitle, detailClose;
const CHAR_X = 6.2;
const CHAR_Z = -16;
const CHAR_START_Y = -1.4;
const CHAR_END_Y = 0.5;
const CHAR_HEIGHT = 20;

let introReady = false;
let introComplete = false;
let introStartedAt = 0;
let introCompletedAt = 0;
let introOpacity = 0; // 0 during intro, tweens to 1 at the end (fades in edge lines/glow)


function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Camera must be in the scene graph so anything parented to it renders.
scene.add(camera);

// --- Hover effect state ---------------------------------------------------
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2(-999, -999);
const hoverScaleUp = new THREE.Vector3(1.05, 1.05, 1.05);
const hoverScaleDefault = new THREE.Vector3(1, 1, 1);
const hoverColorBright = new THREE.Color(1.35, 1.35, 1.35);
const hoverColorDefault = new THREE.Color(1, 1, 1);

window.addEventListener("pointermove", (e) => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// --- Card builder ---------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawCardContent(ctx, source, title, imgW, imgH, tabH) {
  const tabW = Math.round(imgW * TAB_WIDTH_RATIO);
  const tabX = Math.round(imgW * TAB_OFFSET_RATIO);

  ctx.clearRect(0, 0, imgW, imgH + tabH);

  // --- Tab (orange rounded rect at top-left, overlapping the image top edge) ---
  const tabOverlap = Math.round(CORNER_RADIUS_PX * 0.9);
  ctx.fillStyle = ORANGE;
  roundRect(ctx, tabX, 0, tabW, tabH + tabOverlap, CORNER_RADIUS_PX * 0.7);
  ctx.fill();

  // Tab text
  const fontSize = Math.round(tabH * 0.48);
  ctx.fillStyle = "#000000";
  ctx.font = `700 ${fontSize}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, tabX + tabW / 2, tabH / 2);

  // --- Image/video area: rounded-rect clip, draw source, then orange border ---
  const imgY = tabH;
  ctx.save();
  roundRect(ctx, 0, imgY, imgW, imgH, CORNER_RADIUS_PX);
  ctx.clip();
  ctx.drawImage(source, 0, imgY, imgW, imgH);
  ctx.restore();

  // Orange border around the image
  ctx.lineWidth = BORDER_PX;
  ctx.strokeStyle = ORANGE;
  roundRect(
    ctx,
    BORDER_PX / 2,
    imgY + BORDER_PX / 2,
    imgW - BORDER_PX,
    imgH - BORDER_PX,
    CORNER_RADIUS_PX - BORDER_PX / 2
  );
  ctx.stroke();
}

function crossDissolveTitle(ctx, fromTitle, toTitle, blend, imgW, tabH) {
  const tabW = Math.round(imgW * TAB_WIDTH_RATIO);
  const tabX = Math.round(imgW * TAB_OFFSET_RATIO);
  const tabOverlap = Math.round(CORNER_RADIUS_PX * 0.9);

  // Redraw the tab background to clear old text
  ctx.fillStyle = ORANGE;
  roundRect(ctx, tabX, 0, tabW, tabH + tabOverlap, CORNER_RADIUS_PX * 0.7);
  ctx.fill();

  // Blend both titles
  const fontSize = Math.round(tabH * 0.48);
  ctx.font = `700 ${fontSize}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000000";

  if (blend < 1) {
    ctx.globalAlpha = 1 - blend;
    ctx.fillText(fromTitle, tabX + tabW / 2, tabH / 2);
  }
  if (blend > 0) {
    ctx.globalAlpha = blend;
    ctx.fillText(toTitle, tabX + tabW / 2, tabH / 2);
  }
  ctx.globalAlpha = 1;
}

function buildCardTexture(source, title) {
  const imgW = source.videoWidth || source.width;
  const imgH = source.videoHeight || source.height;
  const tabH = Math.round(imgH * TAB_HEIGHT_RATIO);

  const cvs = document.createElement("canvas");
  cvs.width = imgW;
  cvs.height = imgH + tabH;
  const ctx = cvs.getContext("2d");

  drawCardContent(ctx, source, title, imgW, imgH, tabH);

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;

  return {
    texture: tex,
    aspect: cvs.width / cvs.height,
    imgAspect: imgW / imgH,
    tabRatio: tabH / (imgH + tabH),
    canvas: cvs,
    ctx,
    imgW,
    imgH,
    tabH,
  };
}

// --- Load and build cards -------------------------------------------------
const loader = new THREE.TextureLoader();
const imgLoader = new THREE.ImageLoader();

const stack = new THREE.Group();
scene.add(stack);

// Side edge lines (populated in buildStack). Each entry: { group, side }.
const sideLines = [];

// Front-panel glow + sparkles (populated in buildStack)
const sparkles = []; // { sprite, baseOpacity, phase, speed, center, radius }
let frontGlowMain = null;
let frontGlowSoft = null;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    imgLoader.load(url, resolve, undefined, reject);
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.loop = false;      // play once, freeze on last frame
    v.autoplay = false;  // started manually when the card is in position
    v.playsInline = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    // Place in the DOM behind the canvas, at a normal size, so the browser
    // treats it as a visible element. Detached or tiny/opacity:0 videos get
    // throttled in some browsers, which is why playback can appear slow.
    Object.assign(v.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "320px",
      height: "180px",
      zIndex: "-1",
      pointerEvents: "none",
    });
    document.body.appendChild(v);
    v.addEventListener(
      "loadeddata",
      () => {
        v.playbackRate = VIDEO_PLAYBACK_RATE;
        resolve(v);
      },
      { once: true }
    );
    v.addEventListener(
      "error",
      () => reject(new Error(`Failed to load video ${url}`)),
      { once: true }
    );
    v.load();
  });
}

// Cards that need their canvas redrawn each frame (video-backed panels).
// Each entry: { source, title, ctx, imgW, imgH, tabH, texture }
const videoCards = [];

function sampleTopColor(image, scale = 1.0) {
  // Average the top band of the image down to one pixel to get a representative color.
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext("2d");
  const bandH = Math.max(1, Math.floor(image.height * 0.04));
  ctx.drawImage(image, 0, 0, image.width, bandH, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * scale)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function makeBackgroundTexture(centerColor, edgeColor = "#06080d") {
  const w = 1024;
  const h = 1024;
  const cvs = document.createElement("canvas");
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext("2d");
  const centerX = w * 0.5;
  const centerY = h * 0.32;
  const radius = Math.max(w, h) * 0.9;
  const g = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  g.addColorStop(0, centerColor);
  g.addColorStop(1, edgeColor);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function buildStack() {
  // --- Asset loading with progress bar ---
  const progressBar = document.getElementById("preloader-bar");
  const videoCount = CARDS.filter((c) => c.video).length;
  const totalAssets = 2 + CARDS.length + videoCount; // bg + char + cards + videos
  let loadedCount = 0;
  function trackLoad(promise) {
    return promise.then((result) => {
      loadedCount++;
      if (progressBar)
        progressBar.style.width = (loadedCount / totalAssets) * 100 + "%";
      return result;
    });
  }

  const [bgImage, charImage, ...images] = await Promise.all([
    trackLoad(loadImage("images/BG_UXIF_Portfolio.png")),
    trackLoad(loadImage("images/Bolgar_Burr_Versus.webp")),
    ...CARDS.map((c) => trackLoad(loadImage(c.src))),
  ]);

  // Load any videos referenced by cards (keyed by card index)
  const videos = {};
  await Promise.all(
    CARDS.map(async (cfg, i) => {
      if (cfg.video) videos[i] = await trackLoad(loadVideo(cfg.video));
    })
  );

  // If the UX Design card has a video, align downstream intro timings so that
  // UI Design lands right as the video finishes, regardless of actual duration.
  if (videos[2]) {
    const v = videos[2];
    const ux = INTRO_TIMINGS.uxDesign;
    const videoStart = ux.start + ux.duration + 0.1;
    const videoDuration = v.duration || 9; // fallback to 9s if unknown
    // Effective wall-clock duration accounts for the playback rate.
    const effectiveDuration = videoDuration / VIDEO_PLAYBACK_RATE;
    // Extra wall-clock safety pad in case the browser plays the video slower
    // than real-time.
    const VIDEO_TAIL_PADDING = 5;
    const videoEnd = videoStart + effectiveDuration + VIDEO_TAIL_PADDING;

    // Time zoomBack to begin right after the video finishes (+ padding).
    const zb = INTRO_TIMINGS.zoomBack;
    const originalZbStart = zb.start;
    zb.start = videoEnd;
    const delta = zb.start - originalZbStart;
    INTRO_TIMINGS.separate.start += delta;
    INTRO_TIMINGS.componentEntry.start += delta;
  }

  // Build background character mesh and parent to camera (so it tracks the viewport)
  {
    const charTex = new THREE.CanvasTexture(charImage);
    charTex.colorSpace = THREE.SRGBColorSpace;
    charTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const charAspect = charImage.width / charImage.height;
    const charWidth = CHAR_HEIGHT * charAspect;
    const charGeo = new THREE.PlaneGeometry(charWidth, CHAR_HEIGHT);
    const charMat = new THREE.MeshBasicMaterial({
      map: charTex,
      transparent: true,
      alphaTest: 0.05,
      opacity: 0,
      depthWrite: false,
    });
    characterMesh = new THREE.Mesh(charGeo, charMat);
    characterMesh.position.set(CHAR_X, CHAR_START_Y, CHAR_Z);
    camera.add(characterMesh);
  }

  // Background image (BG_UXIF_Portfolio) — blurred, 20% opaque, behind the
  // character but in front of the gradient. Parented to camera.
  {
    // Draw the image onto a canvas with a blur filter applied.
    const blurPx = 4;
    const bgCvs = document.createElement("canvas");
    bgCvs.width = bgImage.width;
    bgCvs.height = bgImage.height;
    const bgCtx = bgCvs.getContext("2d");
    bgCtx.filter = `blur(${blurPx}px)`;
    bgCtx.drawImage(bgImage, 0, 0);
    bgCtx.filter = "none";

    const bgTex = new THREE.CanvasTexture(bgCvs);
    bgTex.colorSpace = THREE.SRGBColorSpace;

    const BG_Z = -22; // behind the character (CHAR_Z = -16)
    // Size the plane to fill the viewport at that depth.
    const vFov = (camera.fov * Math.PI) / 180;
    const bgH = 2 * Math.abs(BG_Z) * Math.tan(vFov / 2) * 1.45; // 30% larger + overshoot
    const bgW = bgH * (bgImage.width / bgImage.height);
    const bgGeo = new THREE.PlaneGeometry(bgW, bgH);
    const bgMat = new THREE.MeshBasicMaterial({
      map: bgTex,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });
    const bgMesh = new THREE.Mesh(bgGeo, bgMat);
    bgMesh.position.set(0, -3.5, BG_Z);
    camera.add(bgMesh);
    bgMeshRef = bgMesh;
  }

  // Darkening vignette — over the BG image but behind the character.
  {
    const vSize = 512;
    const vCvs = document.createElement("canvas");
    vCvs.width = vSize;
    vCvs.height = vSize;
    const vCtx = vCvs.getContext("2d");
    const g = vCtx.createRadialGradient(
      vSize / 2, vSize / 2, vSize * 0.2,
      vSize / 2, vSize / 2, vSize * 0.5
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.25, "rgba(0,0,0,0.4)");
    g.addColorStop(0.5, "rgba(0,0,0,0.8)");
    g.addColorStop(0.75, "rgba(0,0,0,0.95)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    vCtx.fillStyle = g;
    vCtx.fillRect(0, 0, vSize, vSize);

    const vTex = new THREE.CanvasTexture(vCvs);
    const VIG_Z = -18; // between character (-16) and BG (-22)
    const vFovR = (camera.fov * Math.PI) / 180;
    const vigH = 2 * Math.abs(VIG_Z) * Math.tan(vFovR / 2) * 1.3;
    const vigW = vigH * (window.innerWidth / window.innerHeight);
    const vigGeo = new THREE.PlaneGeometry(vigW, vigH);
    const vigMat = new THREE.MeshBasicMaterial({
      map: vTex,
      transparent: true,
      depthWrite: false,
    });
    const vigMesh = new THREE.Mesh(vigGeo, vigMat);
    vigMesh.position.set(0, 0, VIG_Z);
    camera.add(vigMesh);
  }

  // Pull the blue from the top edge of the first image and use it for the
  // page's radial gradient background.
  const topBlue = sampleTopColor(images[0], 0.22);
  scene.background = makeBackgroundTexture(topBlue);

  // --- Burning ember particles drifting through the background ---
  {
    // Soft radial-gradient ember texture
    const eSize = 64;
    const eCvs = document.createElement("canvas");
    eCvs.width = eSize;
    eCvs.height = eSize;
    const eCtx = eCvs.getContext("2d");
    const eg = eCtx.createRadialGradient(
      eSize / 2, eSize / 2, 0,
      eSize / 2, eSize / 2, eSize / 2
    );
    eg.addColorStop(0, "rgba(255,210,120,1)");
    eg.addColorStop(0.25, "rgba(255,150,50,0.7)");
    eg.addColorStop(0.6, "rgba(255,90,20,0.25)");
    eg.addColorStop(1, "rgba(255,60,0,0)");
    eCtx.fillStyle = eg;
    eCtx.fillRect(0, 0, eSize, eSize);
    const emberTex = new THREE.CanvasTexture(eCvs);
    emberTex.colorSpace = THREE.SRGBColorSpace;

    const positions = new Float32Array(EMBER_COUNT * 3);
    for (let i = 0; i < EMBER_COUNT; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 30; // x spread
      positions[i * 3 + 1] = (Math.random() - 0.5) * 24; // y spread
      positions[i * 3 + 2] = -14 - Math.random() * 10;   // z: -14 to -24 camera-local (behind character)
      emberVelocities.push(0.002 + Math.random() * 0.006);
    }

    emberGeo = new THREE.BufferGeometry();
    emberGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const emberMat = new THREE.PointsMaterial({
      map: emberTex,
      color: 0xffaa55,
      size: 0.35,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const embers = new THREE.Points(emberGeo, emberMat);
    camera.add(embers);
  }

  // --- Lens flare ---
  {
    // Procedural flare textures
    function makeFlareTexture(innerColor, outerColor, size) {
      const cvs = document.createElement("canvas");
      cvs.width = size;
      cvs.height = size;
      const ctx = cvs.getContext("2d");
      const g = ctx.createRadialGradient(
        size / 2, size / 2, 0,
        size / 2, size / 2, size / 2
      );
      g.addColorStop(0, innerColor);
      g.addColorStop(1, outerColor);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(cvs);
    }

    const flareMain = makeFlareTexture(
      "rgba(255,250,230,1)",
      "rgba(255,120,20,0)",
      256
    );
    const flareRing = makeFlareTexture(
      "rgba(255,180,80,0.15)",
      "rgba(255,140,40,0)",
      256
    );

    const lensflare = new Lensflare();
    lensflare.addElement(new LensflareElement(flareMain, 350, 0, new THREE.Color(0xffeedd)));
    lensflare.addElement(new LensflareElement(flareRing, 120, 0.15, new THREE.Color(0xffcc88)));
    lensflare.addElement(new LensflareElement(flareRing, 90, 0.4, new THREE.Color(0xffaa66)));
    lensflare.addElement(new LensflareElement(flareRing, 60, 0.65, new THREE.Color(0xff9944)));
    lensflare.addElement(new LensflareElement(flareRing, 40, 0.85, new THREE.Color(0xff8833)));

    // Position the flare source in world space — upper-right, behind the stack.
    lensflare.position.set(8, 7, -6);
    scene.add(lensflare);
  }

  CARDS.forEach((cfg, i) => {
    const source = videos[i] || images[i];
    const built = buildCardTexture(source, cfg.title);
    const { texture, aspect } = built;

    if (videos[i]) {
      // Delay playback until the card has finished its slide-in.
      // Only UX Design (index 2) has a video in the current setup.
      const timing = i === 2 ? INTRO_TIMINGS.uxDesign : null;
      const startDelay = timing ? timing.start + timing.duration + 0.1 : 0;
      videoCards.push({
        source: videos[i],
        title: cfg.title,
        ctx: built.ctx,
        imgW: built.imgW,
        imgH: built.imgH,
        tabH: built.tabH,
        texture,
        startDelay,
        hasStarted: false,
        swapImage: images[i], // static image to replace the video with later
        swapped: false,
      });
    }

    const planeW = CARD_WIDTH;
    const planeH = planeW / aspect;

    const geo = new THREE.PlaneGeometry(planeW, planeH, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Stack offsets: card i=0 is front, i=3 is back.
    mesh.position.set(
      i * STACK_OFFSET.x,
      i * STACK_OFFSET.y,
      i * STACK_OFFSET.z
    );

    stack.add(mesh);
  });

  // Re-center stack on its bounding box so orbit rotates around the middle
  const box = new THREE.Box3().setFromObject(stack);
  const center = new THREE.Vector3();
  box.getCenter(center);
  stack.position.sub(center);

  // Add dotted edge lines + arrows on all four side edges. Opacity is driven
  // by camera angle in the animate loop (left/right pairs fade in/out).
  buildEdgeLines();

  // Orange glow + sparkles on the front panel
  buildFrontGlow();

  // Initial orientation to match the mockup angle (this is the FINAL state)
  stack.rotation.y = -0.35;
  stack.rotation.x = 0.12;

  controls.target.set(0, 0, 0);
  controls.update();

  // --- Snapshot final state, then apply intro start state -----------------
  cardMeshes.push(...stack.children.filter((c) => c.isMesh));

  // stack.position was shifted by the re-centering above. Intro-stacked card
  // positions must counteract that so the cards appear at world origin
  // (aligned with the camera target) during the intro.
  const stackOffset = stack.position.clone();

  for (let i = 0; i < cardMeshes.length; i++) {
    finalPos[i] = cardMeshes[i].position.clone();
    // Card i=0 (Component Guide) closest to camera, i=3 (UX Audit) behind.
    introStackedPos[i] = new THREE.Vector3(
      -stackOffset.x,
      -stackOffset.y,
      -stackOffset.z - 0.003 * i
    );
  }
  finalCameraPos.copy(camera.position);
  finalTarget.copy(controls.target);
  finalStackRotX = stack.rotation.x;
  finalStackRotY = stack.rotation.y;

  // Component Guide's entry start: far out along the stack's local +Z axis
  // (perpendicular to the panels), so it zooms back flush with the other cards
  // instead of traveling diagonally through the scene.
  // finalPos[0] is (0,0,0) local, so start at (0, 0, +Z_OFFSET).
  componentEntryStartLocal.set(0, 0, 12);


  // Apply intro starting state: camera close/head-on, stack unrotated,
  // all cards parked offscreen below the frame.
  camera.position.copy(introCameraPos);
  controls.target.copy(introTarget);
  stack.rotation.set(0, 0, 0);
  for (let i = 0; i < cardMeshes.length; i++) {
    cardMeshes[i].position.set(
      introStackedPos[i].x,
      -5,
      introStackedPos[i].z
    );
  }
  camera.lookAt(controls.target);

  introReady = true;
  introStartedAt = clock.getElapsedTime();
}

function updateIntro(now) {
  if (!introReady || introComplete) return;
  const t = now - introStartedAt;
  const T = INTRO_TIMINGS;

  // --- Default: all cards parked offscreen ---
  for (let i = 0; i < cardMeshes.length; i++) {
    cardMeshes[i].position.set(
      introStackedPos[i].x,
      -5,
      introStackedPos[i].z
    );
  }
  // UX Design (i=2) parks offscreen RIGHT instead of below.
  cardMeshes[2].position.set(
    introStackedPos[2].x + 8,
    introStackedPos[2].y,
    introStackedPos[2].z
  );

  // --- UX Audit (i=3): slides up from below ---
  if (t >= T.uxAudit.start) {
    const k = THREE.MathUtils.clamp(
      (t - T.uxAudit.start) / T.uxAudit.duration,
      0,
      1
    );
    cardMeshes[3].position.y = THREE.MathUtils.lerp(
      -5,
      introStackedPos[3].y,
      easeOutCubic(k)
    );
  }

  // --- UX Design (i=2): flies in fast from screen right ---
  if (t >= T.uxDesign.start) {
    const k = THREE.MathUtils.clamp(
      (t - T.uxDesign.start) / T.uxDesign.duration,
      0,
      1
    );
    cardMeshes[2].position.x = THREE.MathUtils.lerp(
      introStackedPos[2].x + 8,
      introStackedPos[2].x,
      easeOutQuart(k)
    );
    cardMeshes[2].position.y = introStackedPos[2].y;
  }

  // --- Zoom back: camera + stack rotation lerp toward final orbit view ---
  let zbE = 0;
  if (t >= T.zoomBack.start) {
    const zbK = THREE.MathUtils.clamp(
      (t - T.zoomBack.start) / T.zoomBack.duration,
      0,
      1
    );
    zbE = easeInOutCubic(zbK);
  }
  camera.position.lerpVectors(introCameraPos, finalCameraPos, zbE);
  controls.target.lerpVectors(introTarget, finalTarget, zbE);
  stack.rotation.x = THREE.MathUtils.lerp(0, finalStackRotX, zbE);
  stack.rotation.y = THREE.MathUtils.lerp(0, finalStackRotY, zbE);

  // --- Separation: UX Audit (3) pushes back, UX Design (2) settles, and
  //     UI Design (1) simultaneously fades in while pushing forward to its slot. ---
  if (t < T.separate.start) {
    cardMeshes[1].visible = false;
    cardMeshes[1].material.opacity = 0;
  } else {
    cardMeshes[1].visible = true;
    const sepK = THREE.MathUtils.clamp(
      (t - T.separate.start) / T.separate.duration,
      0,
      1
    );
    const sepE = easeInOutCubic(sepK);
    for (const idx of [1, 2, 3]) {
      cardMeshes[idx].position.lerpVectors(introStackedPos[idx], finalPos[idx], sepE);
    }
    // UI Design fades in faster than the separation so it reaches full opacity
    // while still mid-push — fade completes at ~60% of the separation.
    cardMeshes[1].material.opacity = THREE.MathUtils.clamp(sepK / 0.6, 0, 1);

    // When UI Design is mostly faded in, swap the UX Design video to its
    // original image (behind UI Design so the swap is not visible).
    if (sepK >= 0.5) {
      for (const vc of videoCards) {
        if (!vc.swapped && vc.swapImage) {
          drawCardContent(vc.ctx, vc.swapImage, vc.title, vc.imgW, vc.imgH, vc.tabH);
          vc.texture.needsUpdate = true;
          vc.swapped = true;
        }
      }
    }
  }

  // --- Component Guide entry: zooms back along local +Z from far in front
  //      to its final position (flush with the other cards). Hidden until then. ---
  if (t < T.componentEntry.start) {
    cardMeshes[0].visible = false;
  } else {
    cardMeshes[0].visible = true;
    const ceK = THREE.MathUtils.clamp(
      (t - T.componentEntry.start) / T.componentEntry.duration,
      0,
      1
    );
    cardMeshes[0].position.lerpVectors(
      componentEntryStartLocal,
      finalPos[0],
      easeOutQuart(ceK)
    );
  }

  // --- Subtle floaty camera during the "hold" phases (fades out during zoom back) ---
  const floatMult = 1 - zbE;
  if (floatMult > 0.001) {
    camera.position.x += Math.sin(t * 0.55) * 0.12 * floatMult;
    camera.position.y += Math.cos(t * 0.43) * 0.07 * floatMult;
    camera.position.z += Math.sin(t * 0.31) * 0.05 * floatMult;
  }

  // --- Background character: slide up + fade in, long ease-out so it drifts to a stop ---
  if (characterMesh) {
    const charStart = T.zoomBack.start;
    const charEnd = T.componentEntry.start + T.componentEntry.duration;
    const chK = THREE.MathUtils.clamp(
      (t - charStart) / (charEnd - charStart),
      0,
      1
    );
    const chE = easeOutQuart(chK);
    characterMesh.position.y = THREE.MathUtils.lerp(CHAR_START_Y, CHAR_END_Y, chE);
    characterMesh.material.opacity = chE;
  }

  // --- Fade in extras (edge lines, glow, sparkles) near the end of the sequence ---
  const fadeStart = T.componentEntry.start;
  const fadeEnd = T.componentEntry.start + T.componentEntry.duration;
  introOpacity = THREE.MathUtils.clamp((t - fadeStart) / (fadeEnd - fadeStart), 0, 1);

  // --- Done ---
  if (t >= T.componentEntry.start + T.componentEntry.duration) {
    introComplete = true;
    introCompletedAt = now;
    introOpacity = 1;
    controls.enableRotate = false; // rotation driven by mouse position, not drag
    controls.enabled = true;
    smoothAz = baseAz;
    smoothPolar = basePolar;
    controls.update();
  }
}

function buildEdgeLines() {
  const cards = stack.children.filter((c) => c.isMesh);
  if (cards.length < 2) return;

  const front = cards[0];
  const back = cards[cards.length - 1];

  const planeW = front.geometry.parameters.width;
  const planeH = front.geometry.parameters.height;
  const halfW = planeW / 2;
  const halfH = planeH / 2;

  // Small outward nudge so lines don't z-fight with the card edges
  const NUDGE = 0.02;

  const corner = (card, sx, sy) =>
    new THREE.Vector3(
      card.position.x + sx * (halfW + NUDGE),
      card.position.y + sy * (halfH + NUDGE),
      card.position.z
    );

  const ORANGE_HEX = 0xff7a1a;

  // [fromCorner, toCorner, side, vertical]
  const edges = [
    { from: corner(back, -1, +1), to: corner(front, -1, +1), side: "left", vertical: "top" },
    { from: corner(back, -1, -1), to: corner(front, -1, -1), side: "left", vertical: "bottom" },
    { from: corner(back, +1, +1), to: corner(front, +1, +1), side: "right", vertical: "top" },
    { from: corner(back, +1, -1), to: corner(front, +1, -1), side: "right", vertical: "bottom" },
  ];

  for (const edge of edges) {
    const group = new THREE.Group();

    // Dotted line (very short dashes + equal gaps reads as dotted)
    const lineGeo = new THREE.BufferGeometry().setFromPoints([edge.from, edge.to]);
    const lineMat = new THREE.LineDashedMaterial({
      color: ORANGE_HEX,
      dashSize: 0.06,
      gapSize: 0.09,
      transparent: true,
      opacity: 0,
      linewidth: 1,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    group.add(line);

    // Arrow head at the front end (tip at edge.to)
    const dir = new THREE.Vector3().subVectors(edge.to, edge.from).normalize();
    const arrowLen = 0.16;
    const arrowRadius = 0.045;
    const arrowGeo = new THREE.ConeGeometry(arrowRadius, arrowLen, 14);
    const arrowMat = new THREE.MeshBasicMaterial({
      color: ORANGE_HEX,
      transparent: true,
      opacity: 0,
    });
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    arrow.position.copy(edge.to).addScaledVector(dir, -arrowLen / 2);
    group.add(arrow);

    stack.add(group);
    sideLines.push({ group, side: edge.side });
  }
}

// --- Glow / sparkle textures (procedural) ---------------------------------
function makeRadialTexture(stops) {
  const size = 256;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, color] of stops) g.addColorStop(t, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSparkleTexture() {
  const size = 128;
  const c = size / 2;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d");

  // Soft core
  const core = ctx.createRadialGradient(c, c, 0, c, c, size / 3);
  core.addColorStop(0, "rgba(255,230,190,1)");
  core.addColorStop(0.4, "rgba(255,180,90,0.6)");
  core.addColorStop(1, "rgba(255,140,40,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  // Cross streaks (4-point star)
  ctx.globalCompositeOperation = "screen";
  function streak(x1, y1, x2, y2, thickness) {
    const lg = ctx.createLinearGradient(x1, y1, x2, y2);
    lg.addColorStop(0, "rgba(255,210,150,0)");
    lg.addColorStop(0.5, "rgba(255,235,200,0.9)");
    lg.addColorStop(1, "rgba(255,210,150,0)");
    ctx.fillStyle = lg;
    if (y1 === y2) ctx.fillRect(x1, y1 - thickness / 2, x2 - x1, thickness);
    else ctx.fillRect(x1 - thickness / 2, y1, thickness, y2 - y1);
  }
  streak(0, c, size, c, 2);
  streak(c, 0, c, size, 2);

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildFrontGlow() {
  const cards = stack.children.filter((c) => c.isMesh);
  if (cards.length === 0) return;
  const front = cards[0];
  const halfW = front.geometry.parameters.width / 2;
  const halfH = front.geometry.parameters.height / 2;

  // Glow is positioned on the top-right region of the front card
  const glowCenter = new THREE.Vector3(
    front.position.x + halfW * 0.75,
    front.position.y + halfH * 0.78,
    front.position.z + 0.2
  );

  // Main hot glow — bright center, falls off to orange
  const hotTex = makeRadialTexture([
    [0.0, "rgba(255,240,210,1)"],
    [0.15, "rgba(255,190,110,0.9)"],
    [0.45, "rgba(255,120,40,0.35)"],
    [1.0, "rgba(255,90,0,0)"],
  ]);
  const hotMat = new THREE.SpriteMaterial({
    map: hotTex,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 1,
  });
  frontGlowMain = new THREE.Sprite(hotMat);
  frontGlowMain.position.copy(glowCenter);
  frontGlowMain.scale.set(1.6, 1.6, 1);
  stack.add(frontGlowMain);

  // Softer, larger halo behind for the amorphous spread
  const haloTex = makeRadialTexture([
    [0.0, "rgba(255,160,70,0.6)"],
    [0.35, "rgba(255,110,30,0.25)"],
    [1.0, "rgba(255,90,0,0)"],
  ]);
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.85,
  });
  frontGlowSoft = new THREE.Sprite(haloMat);
  frontGlowSoft.position.copy(glowCenter).add(new THREE.Vector3(0, 0, -0.05));
  frontGlowSoft.scale.set(4.0, 4.0, 1);
  stack.add(frontGlowSoft);

  // Sparkles clustered around the glow + trailing along the top edge
  const sparkleTex = makeSparkleTexture();
  const COUNT = 55;
  for (let i = 0; i < COUNT; i++) {
    const spMat = new THREE.SpriteMaterial({
      map: sparkleTex,
      color: 0xffd9a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(spMat);

    // Bias cluster toward the glow, with a few stragglers along the top edge
    const strayOnEdge = Math.random() < 0.35;
    let offset;
    if (strayOnEdge) {
      offset = new THREE.Vector3(
        (Math.random() - 0.8) * halfW * 1.6, // skew to the left along top edge
        (Math.random() - 0.3) * halfH * 0.25,
        (Math.random() - 0.5) * 0.15
      );
    } else {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 1.8) * 1.6;
      offset = new THREE.Vector3(
        Math.cos(angle) * r,
        Math.sin(angle) * r * 0.85,
        (Math.random() - 0.5) * 0.25
      );
    }
    sprite.position.copy(glowCenter).add(offset);

    const size = 0.05 + Math.pow(Math.random(), 2) * 0.22;
    sprite.scale.set(size, size, 1);

    sparkles.push({
      sprite,
      baseOpacity: 0.35 + Math.random() * 0.65,
      phase: Math.random() * Math.PI * 2,
      speed: 0.7 + Math.random() * 2.4,
    });
    stack.add(sprite);
  }
}

function updateFrontGlow(t) {
  if (frontGlowMain) {
    frontGlowMain.material.opacity =
      (0.85 + 0.12 * Math.sin(t * 1.6)) * introOpacity;
  }
  if (frontGlowSoft) {
    frontGlowSoft.material.opacity =
      (0.7 + 0.15 * Math.sin(t * 0.9 + 1.1)) * introOpacity;
  }
  for (const s of sparkles) {
    const pulse = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
    // Sharpen the twinkle with a power curve
    s.sprite.material.opacity =
      s.baseOpacity * Math.pow(pulse, 2.2) * introOpacity;
  }
}

function updateSideLineOpacity() {
  if (sideLines.length === 0) return;

  // Camera position in stack-local space. Positive x => right side faces camera.
  const localCam = stack.worldToLocal(camera.position.clone());

  // Smooth mapping: tanh gives a nice ease in/out around the midline.
  const t = Math.tanh(localCam.x * 0.8);
  const rightOpacity = THREE.MathUtils.clamp(0.5 + 0.5 * t, 0, 1);
  const leftOpacity = 1 - rightOpacity;

  for (const { group, side } of sideLines) {
    const target = (side === "right" ? rightOpacity : leftOpacity) * introOpacity;
    group.traverse((child) => {
      if (child.material && "opacity" in child.material) {
        child.material.opacity = target;
      }
    });
  }
}

// --- Detail mode functions --------------------------------------------------
// Tab order: left to right = UX Audit, UX Design, UI Design, Component Guide
const TAB_ORDER = [3, 2, 1, 0];
const TAB_X_SPACING = 0.55;    // horizontal staircase step to the right
const TAB_Y_STEP = 0.5;        // vertical staircase step upward for back cards
const TAB_ACTIVE_Z = 0.4;      // how far the active card is pushed toward the camera
const TAB_CENTER_X = -1.6;     // shift whole layout left so card sits in left half
const DETAIL_CAM_DIST = 6.2;   // camera distance — pulls back enough to see full card + tabs
const tabLocalPositions = []; // stack-local target positions for each card
let shuffleProgress = 1;      // 1 = settled, <1 = tab-switch shuffle in progress
let shuffleFrom = [];         // card positions at start of a tab switch

// Y-positions by depth rank: 0 = active (front/lowest), 1 = just behind, 2 = mid, 3 = farthest/highest.
// Rank 1 sits so its tab is just above the active card; rank 3 is the highest.
const RANK_Y = [-0.15, 0.28, 0.55, 0.85];

// Fixed anchor for the front (active) card — matches where UX Audit sits at rank 0.
const ACTIVE_X = TAB_CENTER_X + (0 - (TAB_ORDER.length - 1) / 2) * TAB_X_SPACING;

function computeTabLayout(activeIdx) {
  const posMap = {};

  // Find which j-index in TAB_ORDER is the active card.
  let activeJ = 0;
  for (let j = 0; j < TAB_ORDER.length; j++) {
    if (TAB_ORDER[j] === activeIdx) { activeJ = j; break; }
  }

  // Non-active j-indices sorted ascending (lower j = closer behind active).
  const nonActiveJs = [];
  for (let j = 0; j < TAB_ORDER.length; j++) {
    if (j !== activeJ) nonActiveJs.push(j);
  }
  nonActiveJs.sort((a, b) => a - b);

  // Active card: always at the same fixed anchor (front-left).
  posMap[TAB_ORDER[activeJ]] = new THREE.Vector3(
    ACTIVE_X,
    RANK_Y[0],
    TAB_ACTIVE_Z
  );

  // Non-active cards: staircase up-right from the anchor, rank-based so
  // the shape is identical regardless of which card is active.
  for (let rank = 0; rank < nonActiveJs.length; rank++) {
    const j = nonActiveJs[rank];
    posMap[TAB_ORDER[j]] = new THREE.Vector3(
      ACTIVE_X + (rank + 1) * TAB_X_SPACING,
      RANK_Y[rank + 1],
      -(rank + 1) * 0.015
    );
  }

  tabLocalPositions.length = 0;
  for (let i = 0; i < cardMeshes.length; i++) {
    tabLocalPositions[i] = posMap[i] || new THREE.Vector3();
  }

  // Camera: approach the stack from its natural forward direction (where
  // cards already face), so no card rotation is needed.
  const stackForward = new THREE.Vector3(0, 0, 1).applyQuaternion(stack.quaternion);
  const stackCenter = stack.position.clone();
  detailCameraPos.copy(stackCenter).addScaledVector(stackForward, DETAIL_CAM_DIST);
  detailCameraTarget.copy(stackCenter).add(new THREE.Vector3(0, 0.15, 0));
}

function enterDetailMode(index) {
  if (viewMode !== "3d") return;
  viewMode = "to-detail";
  activeCardIndex = index;
  detailProgress = 0;
  shuffleProgress = 1;

  // Save current stack-local positions (these are the 3D spread positions).
  for (let i = 0; i < cardMeshes.length; i++) {
    savedWorldPositions[i] = cardMeshes[i].position.clone();
  }
  saved3DCameraPos.copy(camera.position);
  computeTabLayout(index);
  typeTitle(CARDS[index].title);
}

let typeTitleTimer = null;
function typeTitle(text) {
  // Clear any in-progress typing
  if (typeTitleTimer) clearInterval(typeTitleTimer);
  detailTitle.textContent = "";
  detailTitle.classList.add("typing");
  let i = 0;
  typeTitleTimer = setInterval(() => {
    detailTitle.textContent = text.slice(0, ++i);
    if (i >= text.length) {
      clearInterval(typeTitleTimer);
      typeTitleTimer = null;
      // Keep caret visible briefly, then fade it
      setTimeout(() => detailTitle.classList.remove("typing"), 800);
    }
  }, 45);
}

function exitDetailMode() {
  if (viewMode !== "detail" && viewMode !== "to-detail") return;
  viewMode = "to-3d";
  detailOverlay.classList.remove("active");
  detailTitle.classList.remove("typing");
  if (typeTitleTimer) { clearInterval(typeTitleTimer); typeTitleTimer = null; }
}

function switchTab(newIndex) {
  if (newIndex === activeCardIndex || viewMode !== "detail") return;
  shuffleFrom = cardMeshes.map((c) => c.position.clone());
  activeCardIndex = newIndex;
  computeTabLayout(newIndex);
  typeTitle(CARDS[newIndex].title);
  shuffleProgress = 0;
}

function updateDetailTransition(dt) {
  // --- Main enter / exit transition ---
  const speed = 1.6;
  if (viewMode === "to-detail") {
    detailProgress = Math.min(1, detailProgress + dt * speed);
    if (detailProgress >= 1) viewMode = "detail";
  } else if (viewMode === "to-3d") {
    detailProgress = Math.max(0, detailProgress - dt * speed);
    if (detailProgress <= 0) {
      viewMode = "3d";
      for (let i = 0; i < cardMeshes.length; i++) {
        cardMeshes[i].position.copy(savedWorldPositions[i]);
        cardMeshes[i].scale.set(1, 1, 1);
        cardMeshes[i].material.color.setScalar(1);
      }
      return;
    }
  }

  const t = easeInOutCubic(detailProgress);

  // Camera: lerp from 3D orbit position → detail head-on position
  camera.position.lerpVectors(saved3DCameraPos, detailCameraPos, t);
  const lookTarget = new THREE.Vector3().lerpVectors(
    new THREE.Vector3(0, 0, 0),
    detailCameraTarget,
    t
  );
  camera.lookAt(lookTarget);

  // --- Tab-switch shuffle (runs on top of main transition when in detail) ---
  if (shuffleProgress < 1) {
    shuffleProgress = Math.min(1, shuffleProgress + dt * 3.0);
    const st = easeOutCubic(shuffleProgress);
    for (let i = 0; i < cardMeshes.length; i++) {
      cardMeshes[i].position.lerpVectors(shuffleFrom[i], tabLocalPositions[i], st);
      // Smoothly update brightness/scale during shuffle
      const isActive = i === activeCardIndex;
      const tgtB = isActive ? 1.15 : 0.55;
      cardMeshes[i].material.color.lerp(
        new THREE.Color(tgtB, tgtB, tgtB),
        st * 0.3
      );
      const tgtS = isActive ? 1.0 : 0.92;
      const s = THREE.MathUtils.lerp(cardMeshes[i].scale.x, tgtS, st * 0.3);
      cardMeshes[i].scale.set(s, s, s);
    }
  }

  // --- Card positions (enter / exit) ---
  if (shuffleProgress >= 1) {
    for (let i = 0; i < cardMeshes.length; i++) {
      cardMeshes[i].position.lerpVectors(
        savedWorldPositions[i],
        tabLocalPositions[i],
        t
      );
    }
  }

  // --- Per-card scale + brightness ---
  for (let i = 0; i < cardMeshes.length; i++) {
    const isActive = i === activeCardIndex;
    const targetScale = isActive ? 1.0 : 0.92;
    const s = THREE.MathUtils.lerp(1, targetScale, t);
    cardMeshes[i].scale.set(s, s, s);

    const targetBright = isActive ? 1.15 : 0.55;
    const b = THREE.MathUtils.lerp(1, targetBright, t);
    cardMeshes[i].material.color.setScalar(b);
  }

  // Bloom fades to 0 during detail view
  bloomPass.strength = THREE.MathUtils.lerp(0.28, 0, t);

  // Overlay appears in second half of transition
  detailOverlay.classList.toggle("active", detailProgress > 0.5);
}

// --- Preloader flow: load assets with progress, then start the scene ---
(async function startWithPreloader() {
  // Minimum display time for logo spin animation (2.2s)
  const minWait = new Promise((r) => setTimeout(r, 2200));

  try {
    await buildStack();
  } catch (err) {
    console.error("Failed to build card stack:", err);
  }

  // Ensure logo spin has finished before we transition
  await minWait;

  // Warmup renders — compiles all shaders so the first visible frame is smooth
  composer.render();
  composer.render();
  composer.render();

  // Fade out preloader
  const preloader = document.getElementById("preloader");
  preloader.classList.add("done");
  await new Promise((r) => setTimeout(r, 650));
  preloader.style.display = "none";

  // Start the render loop
  animate();
})();

// --- Wire up detail overlay + click handlers ------------------------------
detailOverlay = document.getElementById("detail-overlay");
detailTitle = document.getElementById("detail-title");
detailClose = document.getElementById("detail-close");
detailClose.addEventListener("click", () => exitDetailMode());

canvas.addEventListener("click", () => {
  if (!introComplete) return;

  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(cardMeshes);

  if (viewMode === "3d") {
    if (hits.length > 0) {
      const idx = cardMeshes.indexOf(hits[0].object);
      if (idx >= 0) enterDetailMode(idx);
    }
  } else if (viewMode === "detail") {
    if (hits.length > 0) {
      const idx = cardMeshes.indexOf(hits[0].object);
      if (idx >= 0 && idx !== activeCardIndex) {
        switchTab(idx);
      }
    } else {
      // Clicked outside all cards — return to 3D view
      exitDetailMode();
    }
  }
});

// --- Resize ---------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
});

// --- Animate --------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  const now = clock.getElapsedTime();
  lastFrameTime = lastFrameTime || now;

  if (introComplete) {
    const dt = now - lastFrameTime;

    if (viewMode === "3d") {
      // --- Mouse-driven subtle orbit (no drag, no scroll — fully manual) ---
      const targetAz = baseAz + mouseNDC.x * MOUSE_AZ_RANGE;
      const targetPolar = basePolar - mouseNDC.y * MOUSE_POLAR_RANGE;
      smoothAz += (targetAz - smoothAz) * MOUSE_SMOOTH;
      smoothPolar += (targetPolar - smoothPolar) * MOUSE_SMOOTH;

      const r = finalCameraPos.length();
      camera.position.set(
        r * Math.sin(smoothPolar) * Math.sin(smoothAz),
        r * Math.cos(smoothPolar),
        r * Math.sin(smoothPolar) * Math.cos(smoothAz)
      );
      camera.lookAt(0, 0, 0);

      // --- Card hover: scale up + brighten whichever card the pointer is over ---
      raycaster.setFromCamera(mouseNDC, camera);
      const hits = raycaster.intersectObjects(cardMeshes);
      const hoveredCard = hits.length > 0 ? hits[0].object : null;
      for (const card of cardMeshes) {
        const isHovered = card === hoveredCard;
        card.scale.lerp(isHovered ? hoverScaleUp : hoverScaleDefault, 0.12);
        card.material.color.lerp(
          isHovered ? hoverColorBright : hoverColorDefault,
          0.12
        );
      }
      canvas.style.cursor = hoveredCard ? "pointer" : "";
    } else {
      // --- Detail / transitioning ---
      updateDetailTransition(dt);

      // Cursor: pointer over cards in detail mode
      raycaster.setFromCamera(mouseNDC, camera);
      const hits = raycaster.intersectObjects(cardMeshes);
      canvas.style.cursor = hits.length > 0 ? "pointer" : "";
    }

    // Subtle idle energy on the background character — ramp amplitude from 0
    // over the first 1.5s after intro so there's no snap when it takes over
    // from the intro's lerped position.
    if (characterMesh) {
      const ramp = THREE.MathUtils.clamp((now - introCompletedAt) / 1.5, 0, 1);
      // Subtle parallax on both axes: shift character opposite to orbit so it
      // feels deeper in the background. X from horizontal orbit, Y from vertical.
      const parallaxX = -Math.sin(smoothAz - baseAz) * 0.9;
      const parallaxY = Math.sin(basePolar - smoothPolar) * 0.9;
      characterMesh.position.x =
        CHAR_X + Math.sin(now * 0.38) * 0.18 * ramp + parallaxX * ramp;
      characterMesh.position.y =
        CHAR_END_Y + Math.cos(now * 0.31) * 0.12 * ramp + parallaxY * ramp;
      characterMesh.position.z = CHAR_Z + Math.sin(now * 0.22) * 0.08 * ramp;
      characterMesh.rotation.z = Math.sin(now * 0.27) * 0.012 * ramp;
    }

    // BG image parallax — moves LESS than the character (further back = less shift).
    // Opposite direction to character for depth contrast.
    if (bgMeshRef) {
      const bgParallaxX = -Math.sin(smoothAz - baseAz) * 0.35;
      const bgParallaxY = Math.sin(basePolar - smoothPolar) * 0.35;
      bgMeshRef.position.x = bgParallaxX;
      bgMeshRef.position.y = -3.5 + bgParallaxY;
    }
  } else {
    updateIntro(now);
    camera.lookAt(controls.target);
  }

  // Drift ember particles upward with gentle horizontal sway
  if (emberGeo) {
    const ePos = emberGeo.attributes.position.array;
    for (let i = 0; i < EMBER_COUNT; i++) {
      ePos[i * 3 + 1] += emberVelocities[i]; // drift up
      ePos[i * 3 + 0] += Math.sin(now * 0.4 + i * 0.7) * 0.0004; // sway
      if (ePos[i * 3 + 1] > 14) ePos[i * 3 + 1] = -12; // wrap
    }
    emberGeo.attributes.position.needsUpdate = true;
  }

  updateSideLineOpacity();
  updateFrontGlow(now);

  // Redraw any video-backed card panels with the current frame.
  const introElapsed = introReady ? now - introStartedAt : 0;
  for (const vc of videoCards) {
    if (vc.swapped) continue; // video replaced with static image — no more redraws
    // Kick off playback once this card has landed in position.
    if (!vc.hasStarted && introReady && introElapsed >= vc.startDelay) {
      vc.source.play().catch(() => {
        /* autoplay may be blocked until first user interaction */
      });
      vc.hasStarted = true;
    }
    if (vc.source.readyState >= 2) {
      drawCardContent(vc.ctx, vc.source, vc.title, vc.imgW, vc.imgH, vc.tabH);
      vc.texture.needsUpdate = true;
    }
    // Cross-dissolve the tab title from "UX Design" → "UI Design"
    // starting ~2s before zoom back so it reads as the next phase.
    if (introReady && !vc.swapped) {
      const xdStart = INTRO_TIMINGS.zoomBack.start - 3.5;
      const xdDuration = 1.5;
      const blend = THREE.MathUtils.clamp(
        (introElapsed - xdStart) / xdDuration,
        0,
        1
      );
      if (blend > 0) {
        crossDissolveTitle(
          vc.ctx,
          "UX Design",
          "UI Design",
          blend,
          vc.imgW,
          vc.tabH
        );
        vc.texture.needsUpdate = true;
      }
    }
  }

  // Keep DoF focused on the stack center (orbit target)
  bokehPass.uniforms.focus.value = camera.position.distanceTo(controls.target);

  composer.render();
  lastFrameTime = now;
  requestAnimationFrame(animate);
}
