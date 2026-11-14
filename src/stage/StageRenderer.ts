/** The journey stage: a perspective rendering of the real RTP positions on a paper plate.
 *
 * Recordings are shaded impostor spheres (one instanced draw), with their floor shadow and a hairline stem so
 * height (Pitch) reads at a glance. A designed shape is an ink dashed line; a generated playlist is a signal-orange
 * ribbon through the chosen recordings, with ink tethers from each evenly spaced point on the shape to the
 * recording that fills it. Positions are never altered: stage coordinates are the raw values on one equal scale.
 *
 * Rendering is on demand. The loop runs only while something moves (camera damping, easing, the generation
 * reveal or playback), and every GPU resource is released by dispose().
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { colorOf, type Recording, type RTP } from '../types';
import { frameCenter, nearestTo, stageFrame, stagePosition, type StageFrame } from './frame';

export type StageJourney = { key: string; ids: (string | null)[]; targets: RTP[] | null; waypoints: RTP[] | null; style: 'journey' | 'preview' };
export type StagePlayback = { id: string; index: number | null; playing: boolean } | null;
export type StageClock = () => { time: number; duration: number; peaks: number[] | null } | null;
export type StageCallbacks = { onSelect: (id: string) => void; onHover: (id: string | null) => void; onUnavailable: () => void; onReveal?: (phase: 'searching' | 'done') => void };
export type StageCommand = 'reset' | 'frame' | 'top' | 'in' | 'out' | 'left' | 'right';

const INK = '#141619', SIGNAL = '#E2471B', PAPER = '#F3F1EB', PLATE = '#FAF9F5';
const AXIS = { R: '#1C68A8', T: '#97571F', P: '#6744C7' };
/** sRGB floats for custom shaders, which write their output without colour-space conversion. */
const srgb = (hex: string) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255] as [number, number, number]; };
const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const RIBBON_SAMPLES = 20;

const orbVertex = /* glsl */`
attribute vec3 iPos; attribute vec3 iColor; attribute vec4 iState;
uniform float uSize;
varying vec2 vUv; varying vec3 vColor; varying vec4 vState;
void main() {
  vUv = position.xy * 2.0; vColor = iColor; vState = iState;
  float s = uSize * (0.55 + 0.45 * iState.x) * (1.0 + 0.30 * iState.z + 0.55 * iState.w + 0.45 * iState.y);
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;
const orbFragment = /* glsl */`
uniform vec3 uPaper; uniform vec3 uInk;
varying vec2 vUv; varying vec3 vColor; varying vec4 vState;
void main() {
  float r = length(vUv);
  float aa = max(fwidth(r) * 1.25, 1e-4);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  if (alpha <= 0.01) discard;
  vec3 n = vec3(vUv, sqrt(max(0.0, 1.0 - r * r)));
  vec3 L = normalize(vec3(-0.48, 0.64, 0.6));
  float diffuse = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
  vec3 lit = vColor * (0.6 + 0.5 * diffuse) + spec * 0.2;
  float e = vState.x, member = vState.z;
  vec3 wash = mix(uPaper, vColor, 0.16);
  vec3 color = mix(wash, lit, e);
  float rimWidth = mix(0.12, 0.22, member);
  float rim = smoothstep(1.0 - rimWidth - aa, 1.0 - rimWidth + aa * 0.5, r);
  vec3 rimColor = mix(color * 0.5, uInk, member * 0.75);
  color = mix(color, rimColor, rim * mix(0.4, 0.95, max(e, member)));
  color = mix(color, vec3(1.0), vState.y * 0.28 * (1.0 - r));
  gl_FragColor = vec4(color, alpha);
}`;
const shadowVertex = /* glsl */`
attribute vec3 iPos; attribute vec4 iState;
uniform float uSize; uniform float uFloor;
varying vec2 vUv; varying float vAlpha;
void main() {
  float h = max(0.0, iPos.y - uFloor);
  float s = uSize * (2.2 + 0.9 * h) * (1.0 + 0.3 * iState.z);
  vUv = position.xy * 2.0;
  vAlpha = iState.x * mix(0.15, 0.34, iState.z) / (1.0 + 0.55 * h);
  vec3 p = vec3(iPos.x + position.x * s, uFloor + 0.002, iPos.z + position.y * s);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const shadowFragment = /* glsl */`
uniform vec3 uInk; varying vec2 vUv; varying float vAlpha;
void main() { float r = length(vUv); if (r > 1.0) discard; float a = (1.0 - r * r); gl_FragColor = vec4(uInk, vAlpha * a * a); }`;
const stemVertex = /* glsl */`
attribute vec3 iPos; attribute vec4 iState;
uniform float uFloor; uniform float uWidth;
varying float vAlpha; varying float vY;
void main() {
  vY = position.y + 0.5;
  vec3 p = mix(vec3(iPos.x, uFloor, iPos.z), iPos, vY);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  p += right * position.x * uWidth;
  vAlpha = iState.x * iState.x * mix(0.09, 0.32, iState.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const stemFragment = /* glsl */`
uniform vec3 uInk; varying float vAlpha; varying float vY;
void main() { gl_FragColor = vec4(uInk, vAlpha * (0.3 + 0.7 * vY)); }`;
const ringVertex = /* glsl */`
attribute vec3 iPos; attribute vec3 iColor; attribute vec4 iRing;
uniform float uSize;
varying vec2 vUv; varying vec3 vColor; varying vec4 vRing;
void main() {
  vUv = position.xy * 2.0; vColor = iColor; vRing = iRing;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * uSize * iRing.x;
  gl_Position = projectionMatrix * mv;
}`;
const ringFragment = /* glsl */`
varying vec2 vUv; varying vec3 vColor; varying vec4 vRing;
void main() {
  float r = length(vUv);
  float aa = max(fwidth(r), 1e-4);
  float outer = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float inner = vRing.w > 0.5 ? 1.0 : smoothstep(1.0 - vRing.z * aa - aa, 1.0 - vRing.z * aa, r);
  float a = outer * inner * vRing.y;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

type Ring = { at: THREE.Vector3; color: [number, number, number]; scale: number; alpha: number; thickness: number; fill?: boolean };
type Label = { element: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number };
type Reveal = { start: number; step: number; slotStart: number; ribbonStart: number; ribbonDuration: number; end: number; candidates: number[][] };

export class StageRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private frame: StageFrame;
  private floor: number;
  private positions: THREE.Vector3[];
  private index = new Map<string, number>();
  private state: Float32Array;
  private stateAttribute: THREE.InstancedBufferAttribute;
  private uniforms = { uSize: { value: .08 }, uFloor: { value: 0 }, uWidth: { value: .005 }, uPaper: { value: new THREE.Vector3(...srgb(PAPER)) }, uInk: { value: new THREE.Vector3(...srgb(INK)) } };
  private disposables: { dispose: () => void }[] = [];
  private emphasis: Float32Array; private bump: Float32Array; private memberTarget: Float32Array; private slotOf: Int32Array;
  private selected = -1; private hover = -1; private marker: THREE.Vector3 | null = null;
  private playback: StagePlayback = null; private clock: StageClock = () => null; private level = 0;
  private intended: THREE.Vector3[] | null = null; private intendedLine: Line2 | null = null; private intendedSegments = 0;
  private journey: StageJourney | null = null; private slots: number[] = []; private targets: THREE.Vector3[] = []; private waypoints: THREE.Vector3[] = [];
  private curve: THREE.CatmullRomCurve3 | null = null; private memberOrder: number[] = [];
  private ribbon: Line2 | null = null; private trace: Line2 | null = null; private tethers: LineSegments2 | null = null; private ribbonSegments = 0;
  private reveal: Reveal | null = null;
  private ringMesh: THREE.Mesh; private ringAttributes: { pos: THREE.InstancedBufferAttribute; color: THREE.InstancedBufferAttribute; ring: THREE.InstancedBufferAttribute };
  private walls: { group: THREE.LineSegments; side: 'x0' | 'x1' | 'z0' | 'z1' }[] = [];
  private layer: HTMLDivElement; private labels: Label[] = []; private numbers: HTMLSpanElement[] = []; private wayLabels: HTMLSpanElement[] = [];
  private tag: HTMLDivElement; private edgeLabels: { element: HTMLElement; place: (near: { x: number; z: number }) => THREE.Vector3 }[] = [];
  private lineMaterials: LineMaterial[] = [];
  private raf = 0; private last = 0; private disposed = false; private frames = 0;
  private shift = { current: 0, target: 0, usable: 1 };
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number; duration: number } | null = null;
  private fitDistance = 8; private observer: ResizeObserver; private down = { x: 0, y: 0, moved: false };
  private cleanup: (() => void)[] = [];
  private touched = false; private peek = -1;

  constructor(private container: HTMLElement, private records: Recording[], private callbacks: StageCallbacks, private reduced = false) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement;
    this.renderer.setClearColor(new THREE.Color(PAPER), 1);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.canvas.className = 'stage-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    container.append(this.canvas);
    this.layer = document.createElement('div'); this.layer.className = 'stage-layer'; this.layer.setAttribute('aria-hidden', 'true'); container.append(this.layer);
    this.tag = document.createElement('div'); this.tag.className = 'stage-tag'; this.layer.append(this.tag);

    this.frame = stageFrame(records);
    const center = frameCenter(this.frame);
    this.floor = this.frame.P[0] - center.P; this.uniforms.uFloor.value = this.floor;
    const n = records.length;
    this.positions = records.map(r => new THREE.Vector3(...stagePosition(r.raw_rtp, this.frame)));
    records.forEach((r, i) => this.index.set(r.recording_id, i));
    this.emphasis = new Float32Array(n).fill(1); this.bump = new Float32Array(n); this.memberTarget = new Float32Array(n); this.slotOf = new Int32Array(n).fill(-1);
    this.state = new Float32Array(n * 4); for (let i = 0; i < n; i++) this.state[i * 4] = 1;

    this.camera = new THREE.PerspectiveCamera(30, 1, .05, 200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = .09; this.controls.rotateSpeed = .55; this.controls.zoomSpeed = .8;
    this.controls.screenSpacePanning = true; this.controls.maxPolarAngle = Math.PI / 2 - .03; this.controls.minPolarAngle = .02;
    this.controls.addEventListener('change', () => this.request());
    this.controls.addEventListener('start', () => { this.tween = null; this.touched = true; this.finishReveal(); });

    this.buildPlate();
    // Shared instance attributes: orbs, their shadows and stems read the same positions and states.
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(this.positions.flatMap(p => p.toArray())), 3);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(records.flatMap(r => srgb(colorOf(r)))), 3);
    this.stateAttribute = new THREE.InstancedBufferAttribute(this.state, 4); this.stateAttribute.setUsage(THREE.DynamicDrawUsage);
    const quad = new THREE.PlaneGeometry(1, 1), stemQuad = new THREE.PlaneGeometry(1, 1);
    const instanced = (base: THREE.BufferGeometry, color: boolean) => {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = base.index; geometry.setAttribute('position', base.getAttribute('position'));
      geometry.setAttribute('iPos', iPos); geometry.setAttribute('iState', this.stateAttribute); if (color) geometry.setAttribute('iColor', iColor);
      geometry.instanceCount = n; this.disposables.push(geometry); return geometry;
    };
    this.disposables.push(quad, stemQuad);
    const shadows = new THREE.Mesh(instanced(quad, false), this.material(shadowVertex, shadowFragment, { transparent: true, depthWrite: false }));
    const stems = new THREE.Mesh(instanced(stemQuad, false), this.material(stemVertex, stemFragment, { transparent: true, depthWrite: false }));
    const orbs = new THREE.Mesh(instanced(quad, true), this.material(orbVertex, orbFragment, { transparent: false, alphaToCoverage: true }));
    for (const [mesh, order] of [[shadows, 2], [stems, 3], [orbs, 5]] as const) { mesh.frustumCulled = false; mesh.renderOrder = order; this.scene.add(mesh); }

    const ringGeometry = new THREE.InstancedBufferGeometry(), capacity = 96;
    ringGeometry.index = quad.index; ringGeometry.setAttribute('position', quad.getAttribute('position'));
    this.ringAttributes = { pos: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3), color: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
      ring: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4) };
    ringGeometry.setAttribute('iPos', this.ringAttributes.pos); ringGeometry.setAttribute('iColor', this.ringAttributes.color); ringGeometry.setAttribute('iRing', this.ringAttributes.ring);
    ringGeometry.instanceCount = 0; this.disposables.push(ringGeometry);
    this.ringMesh = new THREE.Mesh(ringGeometry, this.material(ringVertex, ringFragment, { transparent: true, depthWrite: false, depthTest: false }));
    this.ringMesh.frustumCulled = false; this.ringMesh.renderOrder = 8; this.scene.add(this.ringMesh);

    this.shift.usable = container.clientWidth || 1;
    this.camera.aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    this.camera.position.copy(this.home());
    this.controls.target.set(0, 0, 0);

    const resize = () => this.resize();
    this.observer = new ResizeObserver(resize); this.observer.observe(container);
    this.listen();
    this.resize(); this.controls.update(); this.writeState(); this.request();
  }

  private material(vertexShader: string, fragmentShader: string, options: Partial<THREE.ShaderMaterialParameters>) {
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms, ...options });
    this.disposables.push(material); return material;
  }

  private lineMaterial(color: string, width: number, options: { dashed?: boolean; opacity?: number; dash?: number; gap?: number; depthTest?: boolean } = {}) {
    const material = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, dashed: !!options.dashed, dashSize: options.dash ?? .07, gapSize: options.gap ?? .05,
      transparent: (options.opacity ?? 1) < 1 || options.depthTest === false, opacity: options.opacity ?? 1, depthTest: options.depthTest ?? true, worldUnits: false });
    material.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMaterials.push(material); this.disposables.push(material); return material;
  }

  /** The floor plate at the lowest Pitch in the frame, its half-point grid, axis edges and the back walls for height. */
  private buildPlate() {
    const f = this.frame, c = frameCenter(f), x0 = f.R[0] - c.R, x1 = f.R[1] - c.R, z0 = f.T[0] - c.T, z1 = f.T[1] - c.T, y0 = this.floor, y1 = f.P[1] - c.P;
    const plateGeometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0); plateGeometry.rotateX(-Math.PI / 2);
    const plateMaterial = new THREE.MeshBasicMaterial({ color: PLATE }); this.disposables.push(plateGeometry, plateMaterial);
    const plate = new THREE.Mesh(plateGeometry, plateMaterial); plate.position.set((x0 + x1) / 2, y0, (z0 + z1) / 2); plate.renderOrder = 0; this.scene.add(plate);
    const lines = (points: number[], color: string, opacity: number, order = 1) => {
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      this.disposables.push(geometry, material); const object = new THREE.LineSegments(geometry, material); object.renderOrder = order; this.scene.add(object); return object;
    };
    const minor: number[] = [], major: number[] = [];
    for (let v = f.R[0]; v <= f.R[1] + 1e-6; v += .5) (Number.isInteger(v) ? major : minor).push(v - c.R, y0, z0, v - c.R, y0, z1);
    for (let v = f.T[0]; v <= f.T[1] + 1e-6; v += .5) (Number.isInteger(v) ? major : minor).push(x0, y0, v - c.T, x1, y0, v - c.T);
    lines(minor, '#E2DED3', 1); lines(major, '#CFCABD', 1);
    // Back walls: Pitch levels on the two walls away from the camera, so height can be read against them.
    const wall = (side: 'x0' | 'x1' | 'z0' | 'z1') => {
      const points: number[] = [];
      for (let v = Math.ceil(f.P[0] * 2) / 2; v <= f.P[1] + 1e-6; v += .5) {
        const y = v - c.P; if (Math.abs(y - y0) < 1e-6) continue;
        if (side[0] === 'x') { const x = side === 'x0' ? x0 : x1; points.push(x, y, z0, x, y, z1); } else { const z = side === 'z0' ? z0 : z1; points.push(x0, y, z, x1, y, z); }
      }
      if (side === 'x0' || side === 'x1') { const x = side === 'x0' ? x0 : x1; points.push(x, y0, z0, x, y1, z0, x, y0, z1, x, y1, z1); }
      else { const z = side === 'z0' ? z0 : z1; points.push(x0, y0, z, x0, y1, z, x1, y0, z, x1, y1, z); }
      this.walls.push({ group: lines(points, '#D9D5CA', .85), side });
    };
    (['x0', 'x1', 'z0', 'z1'] as const).forEach(wall);
    // Axis edges in the measurement colours: Rhythm and Texture along the floor's near edges, Pitch up the far corner.
    const edge = (color: string) => { const geometry = new LineGeometry(); geometry.setPositions([0, 0, 0, 1, 0, 0]); this.disposables.push(geometry);
      const line = new Line2(geometry, this.lineMaterial(color, 2)); line.renderOrder = 1; this.scene.add(line); return line; };
    const rEdge = edge(AXIS.R), tEdge = edge(AXIS.T), pEdge = edge(AXIS.P);
    const place = () => {
      const near = this.nearCorner();
      const zn = near.z > 0 ? z1 : z0, xn = near.x > 0 ? x1 : x0;
      (rEdge.geometry as LineGeometry).setPositions([x0, y0, zn, x1, y0, zn]);
      (tEdge.geometry as LineGeometry).setPositions([xn, y0, z0, xn, y0, z1]);
      const post = this.postCorner(); (pEdge.geometry as LineGeometry).setPositions([post.x, y0, post.z, post.x, y1, post.z]);
      for (const w of this.walls) w.group.visible = w.side === (near.x > 0 ? 'x0' : 'x1') || w.side === (near.z > 0 ? 'z0' : 'z1');
    };
    this.placeEdges = place;
    const label = (text: string, className: string, at: (near: { x: number; z: number }) => THREE.Vector3) => {
      const element = document.createElement('span'); element.className = className; element.textContent = text; this.layer.append(element);
      this.edgeLabels.push({ element, place: at });
    };
    label('RHYTHM', 'stage-axis axis-R', near => new THREE.Vector3((x0 + x1) / 2, y0, (near.z > 0 ? z1 : z0) + (near.z > 0 ? .34 : -.34)));
    label('TEXTURE', 'stage-axis axis-T', near => new THREE.Vector3((near.x > 0 ? x1 : x0) + (near.x > 0 ? .34 : -.34), y0, (z0 + z1) / 2));
    label('PITCH', 'stage-axis axis-P', () => { const post = this.postCorner(); return new THREE.Vector3(post.x, y1 + .16, post.z); });
    for (let v = Math.ceil(f.R[0]); v <= f.R[1]; v++) label(String(v), 'stage-tick', near => new THREE.Vector3(v - c.R, y0, (near.z > 0 ? z1 : z0) + (near.z > 0 ? .12 : -.12)));
    for (let v = Math.ceil(f.T[0]); v <= f.T[1]; v++) label(String(v), 'stage-tick', near => new THREE.Vector3((near.x > 0 ? x1 : x0) + (near.x > 0 ? .12 : -.12), y0, v - c.T));
    for (let v = Math.ceil(f.P[0]); v <= f.P[1]; v++) label(String(v), 'stage-tick tick-P', () => { const post = this.postCorner(); return new THREE.Vector3(post.x + post.dx * .12, v - c.P, post.z + post.dz * .12); });
    this.postCorner = () => {
      // Pitch stands at the floor corner furthest to the left on screen among the two side corners, so it never cuts through the music.
      const near = this.nearCorner(), corners = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]].filter(([x, z]) => Math.sign(x) !== near.x || Math.sign(z) !== near.z)
        .filter(([x, z]) => Math.sign(x) === near.x || Math.sign(z) === near.z);
      const best = corners.map(([x, z]) => ({ x, z, s: this.screen(new THREE.Vector3(x, y0, z)).x })).sort((a, b) => a.s - b.s)[0];
      return { x: best.x, z: best.z, dx: best.x === x0 ? -1 : 1, dz: best.z === z0 ? -1 : 1 };
    };
  }
  private postCorner: () => { x: number; z: number; dx: number; dz: number } = () => ({ x: 0, z: 0, dx: 0, dz: 0 });
  private placeEdges = () => {};

  /** Which floor corner faces the camera, in stage coordinates. */
  private nearCorner() { const v = this.camera.position; return { x: Math.sign(v.x) || 1, z: Math.sign(v.z) || 1 }; }

  private home() {
    const radius = this.musicRadius(), d = radius / Math.sin(THREE.MathUtils.degToRad(this.fov() / 2)) * 1.16;
    this.fitDistance = d;
    this.controls.minDistance = d * .3; this.controls.maxDistance = d * 2.4;
    return new THREE.Vector3().setFromSphericalCoords(d, 1.12, -.8);
  }
  /** Radius of the sphere around the recordings themselves (the plate around them may be larger). */
  private musicRadius() { return this.positions.length ? new THREE.Box3().setFromPoints(this.positions).getBoundingSphere(new THREE.Sphere()).radius * 1.08 : this.boxRadius(); }
  private boxRadius() { const f = this.frame; return Math.hypot(f.R[1] - f.R[0], f.T[1] - f.T[0], f.P[1] - f.P[0]) / 2; }
  /** The smaller of the vertical and horizontal fields of view across the unobstructed part of the stage. */
  private fov() {
    const h = this.container.clientHeight || 1, aspect = this.shift.usable / h;
    const horizontal = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect));
    return Math.min(this.camera.fov, horizontal);
  }

  private listen() {
    const canvas = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Document, name: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(name, handler as EventListener, options); this.cleanup.push(() => target.removeEventListener(name, handler as EventListener, options));
    };
    // Wheel zoom only once the stage has focus, so scrolling the page never gets captured on the way past.
    on(canvas, 'wheel', event => { if (document.activeElement !== canvas) event.stopImmediatePropagation(); }, { capture: true });
    on(canvas, 'pointerdown', event => { this.down = { x: event.clientX, y: event.clientY, moved: false }; canvas.focus({ preventScroll: true }); });
    on(canvas, 'pointerup', event => {
      if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) return;
      const hit = this.pick(event);
      if (hit >= 0) { this.finishReveal(); this.callbacks.onSelect(this.records[hit].recording_id); }
    });
    on(canvas, 'pointermove', event => {
      if (event.buttons) return;
      const hit = this.pick(event);
      canvas.style.cursor = hit >= 0 ? 'pointer' : 'grab';
      if (hit !== this.hover) { this.hover = hit; this.callbacks.onHover(hit >= 0 ? this.records[hit].recording_id : null); this.refreshBumps(); }
    });
    on(canvas, 'pointerleave', () => { if (this.hover >= 0) { this.hover = -1; this.callbacks.onHover(null); this.refreshBumps(); } });
    on(canvas, 'keydown', event => {
      const map: Record<string, StageCommand> = { ArrowLeft: 'left', ArrowRight: 'right', '+': 'in', '=': 'in', '-': 'out', f: 'frame', F: 'frame', '0': 'reset' };
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); this.orbit(0, event.key === 'ArrowUp' ? -.12 : .12); return; }
      const command = map[event.key]; if (!command) return; event.preventDefault(); this.command(command);
    });
    on(canvas, 'webglcontextlost' as keyof HTMLElementEventMap, event => { event.preventDefault(); this.callbacks.onUnavailable(); });
    const visible = () => this.request(); document.addEventListener('visibilitychange', visible); this.cleanup.push(() => document.removeEventListener('visibilitychange', visible));
  }

  private screen(point: THREE.Vector3) {
    const v = point.clone().project(this.camera), w = this.container.clientWidth, h = this.container.clientHeight;
    return { x: (v.x + 1) * w / 2, y: (1 - v.y) * h / 2, visible: v.z > -1 && v.z < 1 };
  }
  private pick(event: PointerEvent) {
    const bounds = this.canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    let best = -1, bestScore = Infinity;
    const radius = Math.max(9, this.pixelSize() * .75 + 4);
    this.positions.forEach((position, i) => {
      const p = this.screen(position); if (!p.visible) return;
      const d = Math.hypot(p.x - x, p.y - y), weight = .55 + .45 * this.state[i * 4];
      if (d <= radius * (1 + this.state[i * 4 + 2] * .3) && d / weight < bestScore) { bestScore = d / weight; best = i; }
    });
    return best;
  }
  /** Approximate on-screen diameter of an orb at the orbit target, in CSS pixels. */
  private pixelSize() {
    const d = this.camera.position.distanceTo(this.controls.target), h = this.container.clientHeight || 1;
    return this.uniforms.uSize.value / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * h * this.camera.zoom;
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.shift.usable = Math.max(120, w - Math.abs(this.shift.target) * 2);
    this.applyShift();
    for (const material of this.lineMaterials) material.resolution.set(w, h);
    // Orbs keep a readable size: about 15 CSS pixels at the default framing, whatever the stage size.
    const distance = this.fitDistance, worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / h;
    this.uniforms.uSize.value = THREE.MathUtils.clamp(worldPerPixel * (h < 480 ? 13 : 16), .045, .14);
    this.uniforms.uWidth.value = worldPerPixel * 1.1;
    this.request();
  }
  private applyShift() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    if (Math.abs(this.shift.current) < .5) this.camera.clearViewOffset(); else this.camera.setViewOffset(w, h, -this.shift.current, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** Keep the scene centred in the part of the stage that panels leave visible; changes glide. */
  setInsets(left: number, right: number) {
    const target = (left - right) / 2, w = this.container.clientWidth || 1;
    const changed = Math.abs(target - this.shift.target) > .5;
    this.shift.target = target; this.shift.usable = Math.max(120, w - left - right);
    if (this.reduced || !this.frames) { this.shift.current = target; this.applyShift(); }
    if (changed) {
      const home = this.home();
      this.resize();
      // An untouched camera follows the layout; one the listener has moved stays where they put it.
      if (!this.touched) { if (this.slots.some(i => i >= 0) && this.journey?.style === 'journey') this.frameJourney(this.frames ? 700 : 0); else this.moveTo(new THREE.Vector3(), home, this.frames ? 700 : 0); }
    }
    this.request();
  }

  setEmphasis(values: number[] | null) {
    this.emphasis.set(values ?? new Array(this.records.length).fill(1)); this.request();
  }
  setSelected(id: string | null) { this.selected = id ? this.index.get(id) ?? -1 : -1; this.refreshBumps(); }
  /** A recording pointed at outside the stage (a playlist row, a list): ringed and named like a hover. */
  setPeek(id: string | null) { this.peek = id ? this.index.get(id) ?? -1 : -1; this.refreshBumps(); }
  setMarker(point: RTP | null) { this.marker = point ? new THREE.Vector3(...stagePosition(point, this.frame)) : null; this.request(); }
  setPlayback(value: StagePlayback, clock?: StageClock) { this.playback = value; if (clock) this.clock = clock; this.refreshBumps(); }

  private refreshBumps() {
    this.bump.fill(0);
    const playing = this.playback ? this.index.get(this.playback.id) ?? -1 : -1;
    if (playing >= 0) this.bump[playing] = .45;
    if (this.selected >= 0) this.bump[this.selected] = Math.max(this.bump[this.selected], .5);
    const pointed = this.hover >= 0 ? this.hover : this.peek;
    if (pointed >= 0) this.bump[pointed] = Math.max(this.bump[pointed], .4);
    this.request();
  }

  /** The shape being designed: straight segments between waypoints, exactly as the generator interpolates them. */
  setIntended(points: RTP[] | null) {
    const key = points ? JSON.stringify(points) : '';
    if (key === (this.intended ? JSON.stringify(this.intendedKey) : '')) return;
    this.intendedKey = points; this.intended = points ? points.map(p => new THREE.Vector3(...stagePosition(p, this.frame))) : null;
    this.disposeObject(this.intendedLine); this.intendedLine = null;
    if (this.intended && this.intended.length > 1) {
      const sampled: number[] = [];
      this.intended.slice(1).forEach((point, i) => { const from = this.intended![i]; for (let s = i ? 1 : 0; s <= 16; s++) sampled.push(...from.clone().lerp(point, s / 16).toArray()); });
      const geometry = new LineGeometry(); geometry.setPositions(sampled);
      this.intendedLine = new Line2(geometry, this.lineMaterial(INK, 1.6, { dashed: true, opacity: .85, dash: .06, gap: .045 }));
      this.intendedLine.computeLineDistances(); this.intendedLine.renderOrder = 6; this.scene.add(this.intendedLine);
      this.intendedSegments = sampled.length / 3 - 1;
    }
    this.syncWayLabels(); this.request();
  }
  private intendedKey: RTP[] | null = null;

  /** A playlist placed in the space. With reveal, the search plays out: the shape draws, each point finds its recording, the ribbon follows. */
  setJourney(journey: StageJourney | null, reveal = false) {
    const same = journey && this.journey && journey.key === this.journey.key && journey.style === this.journey.style;
    const fresh = !this.journey || this.journey.style !== journey?.style;
    this.journey = journey;
    if (!same) this.rebuildJourney(reveal && !this.reduced && journey?.style === 'journey', reveal || fresh);
    // Without motion the result is still announced, just without the search playing out.
    if (!same && reveal && this.reduced && journey?.style === 'journey') this.callbacks.onReveal?.('done');
    else this.request();
  }

  private rebuildJourney(reveal: boolean, frame: boolean) {
    const journey = this.journey;
    for (const object of [this.ribbon, this.trace, this.tethers]) this.disposeObject(object);
    this.ribbon = this.trace = this.tethers = null; this.curve = null; this.memberOrder = [];
    this.memberTarget.fill(0); this.slotOf.fill(-1);
    this.slots = journey ? journey.ids.map(id => id ? this.index.get(id) ?? -1 : -1) : [];
    this.targets = journey?.targets?.map(t => new THREE.Vector3(...stagePosition(t, this.frame))) ?? [];
    this.waypoints = journey?.waypoints?.map(t => new THREE.Vector3(...stagePosition(t, this.frame))) ?? [];
    this.slots.forEach((record, slot) => { if (record >= 0) { this.memberTarget[record] = journey!.style === 'journey' ? 1 : .7; if (this.slotOf[record] < 0) this.slotOf[record] = slot; } });
    const points: THREE.Vector3[] = [];
    this.slots.forEach((record, slot) => { if (record >= 0) { points.push(this.positions[record]); this.memberOrder[slot] = points.length - 1; } else this.memberOrder[slot] = -1; });
    if (journey && points.length > 1) {
      this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      const samples = this.curve.getPoints((points.length - 1) * RIBBON_SAMPLES);
      const positions = samples.flatMap(p => p.toArray());
      const geometry = new LineGeometry(); geometry.setPositions(positions);
      const preview = journey.style === 'preview';
      this.ribbon = new Line2(geometry, this.lineMaterial(SIGNAL, preview ? 2.4 : 3.6, preview ? { dashed: true, opacity: .9, dash: .05, gap: .04 } : {}));
      if (preview) this.ribbon.computeLineDistances();
      this.ribbon.renderOrder = 7; this.scene.add(this.ribbon); this.ribbonSegments = samples.length - 1;
      if (!preview) {
        const traceGeometry = new LineGeometry(); traceGeometry.setPositions(positions);
        this.trace = new Line2(traceGeometry, this.lineMaterial(INK, 1.4, { depthTest: false })); this.trace.renderOrder = 9; this.trace.visible = false; this.scene.add(this.trace);
      }
    }
    if (journey?.style === 'journey' && this.targets.length === this.slots.length) {
      const pairs = this.slots.flatMap((record, slot) => record >= 0 ? [...this.targets[slot].toArray(), ...this.positions[record].toArray()] : []);
      if (pairs.length) {
        const geometry = new LineSegmentsGeometry(); geometry.setPositions(pairs);
        this.tethers = new LineSegments2(geometry, this.lineMaterial(INK, 1, { opacity: .55 })); this.tethers.renderOrder = 6; this.scene.add(this.tethers);
      }
    }
    this.syncNumbers(); this.syncWayLabels();
    if (reveal && journey) this.startReveal(); else { this.reveal = null; if (this.ribbon) this.ribbon.geometry.instanceCount = Infinity; }
    if (journey?.style === 'journey' && frame && (reveal || !this.touched)) this.frameJourney(reveal ? 1900 : 700);
    this.request();
  }

  private startReveal() {
    const n = this.slots.length, step = THREE.MathUtils.clamp(1500 / Math.max(1, n), 110, 230), slotStart = 650;
    const ribbonStart = slotStart + n * step + 250, ribbonDuration = 900;
    // The comparison each point makes: the five playable recordings nearest to it, measured as the generator measures.
    const candidates = this.targets.map(target => nearestTo(this.records, { R: target.x + frameCenter(this.frame).R, P: target.y + frameCenter(this.frame).P, T: target.z + frameCenter(this.frame).T }, 5));
    this.reveal = { start: performance.now(), step, slotStart, ribbonStart, ribbonDuration, end: ribbonStart + ribbonDuration, candidates };
    this.callbacks.onReveal?.('searching');
  }
  /** Jump the reveal to its finished state. */
  finishReveal() { if (!this.reveal) return; this.reveal = null; if (this.ribbon) this.ribbon.geometry.instanceCount = Infinity; this.callbacks.onReveal?.('done'); this.request(); }
  get revealing() { return !!this.reveal; }

  private gate(slot: number, now: number) {
    if (!this.reveal) return 1;
    const t = now - this.reveal.start - this.reveal.slotStart - slot * this.reveal.step - 200;
    return ease(clamp01(t / 260));
  }

  private syncNumbers() {
    this.numbers.forEach(element => element.remove()); this.numbers = [];
    if (this.journey?.style !== 'journey') return;
    // One label per recording; a recording that appears twice lists both positions.
    const at = new Map<number, number[]>();
    this.slots.forEach((record, slot) => { if (record >= 0) at.set(record, [...at.get(record) ?? [], slot]); });
    at.forEach((slots, record) => {
      const element = document.createElement('span'); element.className = 'stage-number'; element.textContent = slots.map(s => String(s + 1).padStart(2, '0')).join(' · ');
      element.dataset.record = String(record); element.dataset.slot = String(slots[0]); this.layer.append(element); this.numbers.push(element);
    });
  }
  private syncWayLabels() {
    this.wayLabels.forEach(element => element.remove()); this.wayLabels = [];
    const points = this.journey?.style === 'journey' && this.waypoints.length > 1 ? this.waypoints : this.intended;
    if (!points || points.length < 2) return;
    points.forEach((point, i) => {
      if (i !== 0 && i !== points.length - 1) return;
      const element = document.createElement('span'); element.className = 'stage-way'; element.textContent = i === 0 ? 'START' : 'END';
      element.dataset.x = String(point.x); element.dataset.y = String(point.y); element.dataset.z = String(point.z); this.layer.append(element); this.wayLabels.push(element);
    });
  }

  /** Ease the camera so the journey (or, without one, the whole frame) fills the visible stage. */
  frameJourney(duration = 700) {
    const points = [...this.slots.filter(i => i >= 0).map(i => this.positions[i]), ...this.targets, ...this.waypoints];
    if (points.length < 2) { this.command('reset'); return; }
    const box = new THREE.Box3().setFromPoints(points), sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius * 1.3, this.boxRadius() * .5);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.fov() / 2)) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.moveTo(sphere.center.clone().lerp(new THREE.Vector3(0, 0, 0), .12), direction.multiplyScalar(Math.min(distance, this.fitDistance * 1.05)), duration);
  }

  private moveTo(target: THREE.Vector3, offset: THREE.Vector3, duration: number) {
    const to: [THREE.Vector3, THREE.Vector3] = [target.clone().add(offset), target.clone()];
    if (this.reduced || duration <= 0) { this.camera.position.copy(to[0]); this.controls.target.copy(to[1]); this.tween = null; this.controls.update(); this.request(); return; }
    this.tween = { from: [this.camera.position.clone(), this.controls.target.clone()], to, start: performance.now(), duration };
    this.request();
  }

  private orbit(azimuth: number, polar: number) {
    const offset = this.camera.position.clone().sub(this.controls.target), spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += azimuth; spherical.phi = THREE.MathUtils.clamp(spherical.phi + polar, this.controls.minPolarAngle, this.controls.maxPolarAngle);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); this.controls.update(); this.request();
  }

  command(name: StageCommand) {
    this.tween = null;
    if (name === 'reset') this.moveTo(new THREE.Vector3(), this.home(), 600);
    if (name === 'frame') { if (this.slots.some(i => i >= 0)) this.frameJourney(); else this.moveTo(new THREE.Vector3(), this.home(), 600); }
    if (name === 'top') this.moveTo(new THREE.Vector3(), new THREE.Vector3(0, this.home().length(), .001), 600);
    if (name === 'left' || name === 'right') this.orbit(name === 'left' ? -.2 : .2, 0);
    if (name === 'in' || name === 'out') {
      const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(name === 'in' ? .8 : 1.25);
      offset.setLength(THREE.MathUtils.clamp(offset.length(), this.controls.minDistance, this.controls.maxDistance));
      this.moveTo(this.controls.target.clone(), offset, 300);
    }
  }

  private request() { if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.tick); }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    if (document.hidden) return;
    const dt = Math.min(.05, this.last ? (now - this.last) / 1000 : .016); this.last = now;
    let active = false;
    if (this.tween) {
      const t = clamp01((now - this.tween.start) / this.tween.duration), k = ease(t);
      this.camera.position.lerpVectors(this.tween.from[0], this.tween.to[0], k); this.controls.target.lerpVectors(this.tween.from[1], this.tween.to[1], k);
      if (t >= 1) this.tween = null; active = true;
    }
    if (this.controls.update()) active = true;
    if (Math.abs(this.shift.target - this.shift.current) > .5) {
      this.shift.current += (this.shift.target - this.shift.current) * (1 - Math.exp(-dt * 7)); this.applyShift(); active = true;
    } else if (this.shift.current !== this.shift.target) { this.shift.current = this.shift.target; this.applyShift(); }
    if (this.reveal && now - this.reveal.start > this.reveal.end) { this.reveal = null; this.callbacks.onReveal?.('done'); }
    if (this.reveal) active = true;
    if (this.step(dt, now)) active = true;
    if (this.playback?.playing) active = true;
    this.render(now);
    if (active) this.request(); else this.last = 0;
  };

  /** Ease every per-recording value toward its target; returns whether anything is still moving. */
  private step(dt: number, now: number) {
    const n = this.records.length, slow = this.reveal ? 2.2 : 9, k = this.reduced ? 1 : 1 - Math.exp(-dt * slow), kFast = this.reduced ? 1 : 1 - Math.exp(-dt * 14);
    const flash = new Float32Array(n);
    if (this.reveal) {
      const elapsed = now - this.reveal.start;
      this.reveal.candidates.forEach((list, slot) => {
        const t = (elapsed - this.reveal!.slotStart - slot * this.reveal!.step) / 420;
        if (t <= 0 || t >= 1) return; const value = Math.sin(t * Math.PI);
        list.forEach((index, rank) => { flash[index] = Math.max(flash[index], value * (1 - rank * .12)); });
      });
    }
    let moving = false;
    for (let i = 0; i < n; i++) {
      const o = i * 4, slot = this.slotOf[i];
      const member = this.memberTarget[i] * (slot >= 0 ? this.gate(slot, now) : 1);
      const values = [this.emphasis[i], flash[i], member, this.bump[i]];
      for (let c = 0; c < 4; c++) {
        const target = values[c], current = this.state[o + c];
        if (Math.abs(target - current) < .002) { if (current !== target) { this.state[o + c] = target; moving = true; } continue; }
        this.state[o + c] = c === 1 ? target : current + (target - current) * (c === 0 ? k : kFast);
        moving = true;
      }
    }
    if (moving) this.writeState();
    return moving;
  }
  private writeState() { this.stateAttribute.needsUpdate = true; }

  private render(now: number) {
    this.placeEdges();
    const playing = this.playback ? this.index.get(this.playback.id) ?? -1 : -1;
    // Playback progress along the ribbon, and the loudness of the actual decoded audio at the playhead.
    let travelled = -1, level = 0;
    const clock = this.playback ? this.clock() : null;
    if (clock && clock.duration > 0 && clock.peaks?.length) {
      const fraction = clock.time / clock.duration;
      level = clock.peaks[Math.min(clock.peaks.length - 1, Math.max(0, Math.floor(fraction * clock.peaks.length)))] ?? 0;
    }
    this.level += ((this.playback?.playing ? level : 0) - this.level) * .35;
    if (this.playback?.index != null && this.curve && clock && clock.duration > 0) {
      const order = this.memberOrder[this.playback.index] ?? -1;
      if (order >= 0) travelled = Math.min(this.memberOrder.filter(v => v >= 0).length - 1, order + clock.time / clock.duration);
    }
    if (this.ribbon) {
      if (this.reveal) {
        const t = clamp01((now - this.reveal.start - this.reveal.ribbonStart) / this.reveal.ribbonDuration);
        this.ribbon.geometry.instanceCount = Math.round(ease(t) * this.ribbonSegments);
      } else this.ribbon.geometry.instanceCount = Infinity;
    }
    if (this.trace) {
      this.trace.visible = travelled >= 0;
      if (travelled >= 0) this.trace.geometry.instanceCount = Math.max(1, Math.round(travelled * RIBBON_SAMPLES));
    }
    if (this.intendedLine) {
      const t = this.reveal ? clamp01((now - this.reveal.start) / 700) : 1;
      this.intendedLine.geometry.instanceCount = this.reveal ? Math.max(1, Math.round(ease(t) * this.intendedSegments)) : Infinity;
    }
    if (this.tethers) this.tethers.geometry.instanceCount = this.reveal ? this.slots.filter((record, slot) => record >= 0 && this.gate(slot, now) > .05).length : Infinity;

    const ink = srgb(INK), signal = srgb(SIGNAL), rings: Ring[] = [];
    const wayPoints = this.journey?.style === 'journey' && this.waypoints.length > 1 ? this.waypoints : this.intended ?? [];
    const intendedProgress = this.reveal ? clamp01((now - this.reveal.start) / 700) : 1;
    wayPoints.forEach((point, i) => { const appear = clamp01(intendedProgress * wayPoints.length - i); if (appear > 0) rings.push({ at: point, color: ink, scale: 1.25 * ease(appear), alpha: .9, thickness: 1.6 }); });
    if (this.journey?.style === 'journey') this.targets.forEach((target, slot) => {
      const g = this.reveal ? clamp01((now - this.reveal.start - this.reveal.slotStart - slot * this.reveal.step) / 180) : 1;
      if (g > 0) rings.push({ at: target, color: ink, scale: .62 * ease(g), alpha: .8, thickness: 1.3, fill: false });
    });
    if (this.marker) rings.push({ at: this.marker, color: ink, scale: 2.4, alpha: .9, thickness: 1.5 }, { at: this.marker, color: ink, scale: .38, alpha: .9, thickness: 1, fill: true });
    if (this.selected >= 0) rings.push({ at: this.positions[this.selected], color: ink, scale: 1.95, alpha: 1, thickness: 1.5 });
    const pointed = this.hover >= 0 ? this.hover : this.peek;
    if (pointed >= 0 && pointed !== this.selected) rings.push({ at: this.positions[pointed], color: ink, scale: 1.85, alpha: .6, thickness: 1.2 });
    if (playing >= 0) {
      const pulse = this.reduced ? 0 : this.level;
      rings.push({ at: this.positions[playing], color: signal, scale: 2.5 + pulse * 1.6, alpha: this.playback?.playing ? .95 : .6, thickness: 2 });
    }
    if (travelled >= 0 && this.curve) {
      const point = this.curve.getPoint(travelled / Math.max(1, this.memberOrder.filter(v => v >= 0).length - 1));
      rings.push({ at: point, color: signal, scale: .8, alpha: 1, thickness: 1, fill: true }, { at: point, color: ink, scale: .95, alpha: 1, thickness: 1.4 });
    }
    this.writeRings(rings);
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.canvas.dataset.renderFrames = String(this.frames);
    this.canvas.dataset.gpu = JSON.stringify(this.renderer.info.memory);
    this.canvas.dataset.revealing = String(!!this.reveal);
    this.placeLabels(now);
  }

  private writeRings(rings: Ring[]) {
    const { pos, color, ring } = this.ringAttributes, count = Math.min(rings.length, pos.count);
    for (let i = 0; i < count; i++) {
      const r = rings[i]; pos.setXYZ(i, r.at.x, r.at.y, r.at.z); color.setXYZ(i, ...r.color); ring.setXYZW(i, r.scale, r.alpha, r.thickness, r.fill ? 1 : 0);
    }
    pos.needsUpdate = color.needsUpdate = ring.needsUpdate = true;
    (this.ringMesh.geometry as THREE.InstancedBufferGeometry).instanceCount = count;
  }

  private placeLabels(now: number) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const near = this.nearCorner();
    const put = (element: HTMLElement, point: THREE.Vector3, dx = 0, dy = 0) => {
      const p = this.screen(point);
      const shown = p.visible && p.x > -40 && p.x < w + 40 && p.y > -20 && p.y < h + 20;
      element.style.visibility = shown ? 'visible' : 'hidden';
      if (shown) element.style.transform = `translate(${Math.round(p.x + dx)}px, ${Math.round(p.y + dy)}px)`;
      return p;
    };
    // Controls drawn over the stage (camera keys, path legend), in stage pixels.
    const origin = this.container.getBoundingClientRect();
    const obstacles = [...(this.container.parentElement?.querySelectorAll<HTMLElement>('.stage-keys, .stage-legend') ?? [])]
      .map(e => e.getBoundingClientRect()).filter(r => r.width && r.height)
      .map(r => ({ left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }));
    for (const label of this.edgeLabels) {
      if (!label.element.classList.contains('stage-axis')) { put(label.element, label.place(near)); continue; }
      // On a narrow stage the axes run past its edges and under the controls: axis titles stay readable;
      // tick numbers keep their true place.
      const p = this.screen(label.place(near)), half = label.element.offsetWidth / 2 + 6, tall = label.element.offsetHeight / 2 + 4;
      label.element.style.visibility = p.visible ? 'visible' : 'hidden';
      if (!p.visible) continue;
      const x = Math.min(w - half, Math.max(half, p.x));
      let y = Math.min(h - 12, Math.max(12, p.y));
      for (let pass = 0; pass < 3; pass++) {
        const blocking = obstacles.find(o => x + half > o.left && x - half < o.right && y + tall > o.top && y - tall < o.bottom);
        if (!blocking) break;
        y = blocking.top - tall;
      }
      label.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    const size = this.pixelSize();
    for (const element of this.numbers) {
      const record = Number(element.dataset.record), slot = Number(element.dataset.slot);
      const g = this.gate(slot, now);
      element.style.opacity = String(g);
      put(element, this.positions[record], size * .6 + 5, -size * .6 - 4);
      element.classList.toggle('is-playing', this.playback?.id === this.records[record].recording_id);
    }
    // START and END hang below their points: position numbers sit up-right of the same recordings.
    for (const element of this.wayLabels) put(element, new THREE.Vector3(Number(element.dataset.x), Number(element.dataset.y), Number(element.dataset.z)), 0, size * .6 + 8);
    const shown = this.hover >= 0 ? this.hover : this.peek;
    if (shown >= 0) {
      const record = this.records[shown], key = `${record.recording_id}:${this.slotOf[shown]}`;
      if (this.tag.dataset.key !== key) {
        this.tag.dataset.key = key; this.tag.replaceChildren();
        const title = document.createElement('strong'), meta = document.createElement('span'), dot = document.createElement('i');
        const slots = this.slots.flatMap((r, s) => r === shown ? [String(s + 1).padStart(2, '0')] : []);
        title.textContent = `${slots.length && this.journey?.style === 'journey' ? `${slots.join(' · ')}  ` : ''}${record.title}`;
        dot.style.background = colorOf(record);
        meta.append(dot, `${record.mood.label} · R ${record.raw_rtp.R.toFixed(2)} T ${record.raw_rtp.T.toFixed(2)} P ${record.raw_rtp.P.toFixed(2)}`);
        this.tag.append(title, meta);
      }
      const p = this.screen(this.positions[shown]);
      const tw = this.tag.offsetWidth || 220, th = this.tag.offsetHeight || 44, gap = size * .9 + 10;
      let x = p.x + gap, y = p.y - th - gap * .4;
      if (x + tw > w - 8) x = p.x - gap - tw;
      if (y < 8) y = p.y + gap * .4;
      this.tag.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.min(h - th - 8, y))}px)`;
      this.tag.style.visibility = p.visible ? 'visible' : 'hidden';
      this.tag.classList.toggle('is-hover', this.hover >= 0 || this.peek >= 0);
    } else { this.tag.style.visibility = 'hidden'; this.tag.dataset.key = ''; }
  }

  private disposeObject(object: Line2 | LineSegments2 | null) {
    if (!object) return;
    this.scene.remove(object); object.geometry.dispose(); (object.material as LineMaterial).dispose();
    this.lineMaterials = this.lineMaterials.filter(m => m !== object.material);
    this.disposables = this.disposables.filter(d => d !== object.material);
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); this.observer.disconnect();
    this.cleanup.forEach(run => run()); this.controls.dispose();
    for (const object of [this.ribbon, this.trace, this.tethers, this.intendedLine]) this.disposeObject(object);
    this.scene.traverse(object => { if (object instanceof Line2) object.geometry.dispose(); });
    this.disposables.forEach(item => item.dispose());
    this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.remove(); this.layer.remove();
  }
}
