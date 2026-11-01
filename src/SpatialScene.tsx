import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { worldPosition, screenHits, orthographicFit } from './geometry';
import { colorOf, type Recording } from './types';
import { OverlapPicker, pickerPosition } from './OverlapPicker';
import { calloutSize, placeCallout } from './callout';

export type CameraCommand = 'reset' | 'fit' | 'in' | 'out' | 'left' | 'right' | 'top' | 'front' | 'side' | 'center';
export type SceneHandle = { command: (name: CameraCommand) => void };
/** Camera framing kept by the parent so leaving and returning to 3D restores the same view. */
export type CameraState = { position: THREE.Vector3; target: THREE.Vector3; height: number; zoom: number };
type Props = { records: Recording[]; visibleIds?: string[]; selected: string | null; onSelect: (id: string) => void; onUnavailable?: () => void;
  camera?: MutableRefObject<CameraState | null>; playing?: string | null; paused?: boolean; showExcluded?: boolean; path?: string[] };

/** White disc with a grey rim (vertex colors darken the rim per mood), or a thin ring for markers. */
function discTexture(ring = false, dashed = false) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.beginPath(); context.arc(32, 32, ring ? 27 : 25, 0, Math.PI * 2);
  if (ring) { context.strokeStyle = '#fff'; context.lineWidth = 4; if (dashed) context.setLineDash?.([7, 5]); context.stroke(); }
  else { context.fillStyle = '#fff'; context.fill(); context.strokeStyle = '#6f6f6f'; context.lineWidth = 4; context.stroke(); }
  return new THREE.CanvasTexture(canvas);
}

const noPath: string[] = [];

export const SpatialScene = forwardRef<SceneHandle, Props>(function SpatialScene({ records, visibleIds, selected, onSelect, onUnavailable, camera: cameraState, playing = null, paused = false, showExcluded = false, path = noPath }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ select: (id: string | null) => void; command: (name: CameraCommand) => void; visible: (ids?: string[]) => void;
    playing: (id: string | null, paused: boolean) => void; context: (show: boolean) => void; path: (ids: string[]) => void } | null>(null);
  const choose = useRef(onSelect); choose.current = onSelect;
  const fallback = useRef(onUnavailable); fallback.current = onUnavailable;
  const ownView = useRef<CameraState | null>(null), view = cameraState ?? ownView;
  const [unavailable, setUnavailable] = useState(false);
  const [overlap, setOverlap] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  useImperativeHandle(ref, () => ({ command: name => runtime.current?.command(name) }), []);

  // OrbitControls resolves its root during disposal; clean up before React detaches it.
  useLayoutEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setUnavailable(true); fallback.current?.(); return; }
    const canvas = renderer.domElement;
    canvas.setAttribute('aria-label', 'Three-dimensional RTP field. Drag to orbit, Shift-drag or arrow keys to pan. Use the recording list to select by keyboard.');
    canvas.setAttribute('role', 'img'); canvas.tabIndex = 0;
    container.append(canvas);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-5, 5, 4, -4, .01, 200);
    camera.position.set(7, 5, 8);
    const controls = new OrbitControls(camera, canvas);
    if (view.current) { camera.position.copy(view.current.position); controls.target.copy(view.current.target); camera.zoom = view.current.zoom; }
    controls.enableDamping = false; controls.minZoom = .15; controls.maxZoom = 30;
    controls.listenToKeyEvents(canvas);
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    // Wheel zoom is active only once the field has keyboard/pointer focus.
    controls.enableZoom = false;
    const textures = [discTexture(), discTexture(true), discTexture(true, true)];
    // Excluded recordings are optional faint context: drawn first, never selectable.
    const ghostGeometry = new THREE.BufferGeometry();
    ghostGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(records.length * 3), 3));
    const ghostMaterial = new THREE.PointsMaterial({ color: '#A39E92', size: 9, sizeAttenuation: false, map: textures[1],
      transparent: true, opacity: .9, alphaTest: .05, depthTest: false });
    const ghosts = new THREE.Points(ghostGeometry, ghostMaterial); ghosts.visible = false; scene.add(ghosts);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(records.flatMap(r => worldPosition(r.raw_rtp)), 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(records.flatMap(r => new THREE.Color(colorOf(r)).toArray()), 3));
    const material = new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: textures[0],
      vertexColors: true, transparent: true, alphaTest: .1, depthTest: false });
    // Playlist order between whole-recording positions; segments skip entries missing from this catalog.
    const pathMaterial = new THREE.LineBasicMaterial({ color: '#141619', transparent: true, opacity: .55 });
    const pathLine = new THREE.LineSegments(new THREE.BufferGeometry(), pathMaterial); scene.add(pathLine);
    scene.add(new THREE.Points(geometry, material));
    const markerGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
    const markerMaterial = new THREE.PointsMaterial({ color: '#141619', size: 26, sizeAttenuation: false,
      map: textures[1], transparent: true, depthTest: false });
    const marker = new THREE.Points(markerGeometry, markerMaterial); marker.visible = false; scene.add(marker);
    const playGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
    const playMaterial = new THREE.PointsMaterial({ color: '#E2471B', size: 38, sizeAttenuation: false,
      map: textures[1], transparent: true, depthTest: false });
    const playMarker = new THREE.Points(playGeometry, playMaterial); playMarker.visible = false; scene.add(playMarker);
    const guideGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const guideMaterial = new THREE.LineDashedMaterial({ color: '#141619', transparent: true, opacity: .7, dashSize: .06, gapSize: .06 });
    const guide = new THREE.Line(guideGeometry, guideMaterial); guide.visible = false; scene.add(guide);
    const footGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
    const footMaterial = new THREE.LineBasicMaterial({ color: '#141619', transparent: true, opacity: .8 });
    const foot = new THREE.LineSegments(footGeometry, footMaterial); foot.visible = false; scene.add(foot);
    const frameBox = new THREE.BoxGeometry(4, 4, 4);
    const frameGeometry = new THREE.EdgesGeometry(frameBox); frameBox.dispose();
    const frameMaterial = new THREE.LineBasicMaterial({ color: '#B9B3A6', transparent: true, opacity: .95 });
    scene.add(new THREE.LineSegments(frameGeometry, frameMaterial));
    const grid = new THREE.GridHelper(4, 4, '#D8D4CA', '#D8D4CA'); grid.position.y = -2;
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = .9;
    scene.add(grid);
    const rearGrid = grid.clone(); rearGrid.rotation.x = Math.PI / 2; rearGrid.position.set(0, 0, -2);
    rearGrid.material = (grid.material as THREE.LineBasicMaterial).clone(); (rearGrid.material as THREE.Material).opacity = .55; scene.add(rearGrid);
    const sideGrid = grid.clone(); sideGrid.rotation.z = Math.PI / 2; sideGrid.position.set(-2, 0, 0); sideGrid.material = rearGrid.material; scene.add(sideGrid);
    // The selected tag and its leader are DOM overlays placed in screen space on every frame.
    const leaderLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); leaderLayer.setAttribute('class', 'callout-layer'); leaderLayer.setAttribute('aria-hidden', 'true');
    const leaderLine = document.createElementNS('http://www.w3.org/2000/svg', 'line'), leaderDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    leaderLine.setAttribute('class', 'callout-line'); leaderDot.setAttribute('class', 'callout-dot'); leaderDot.setAttribute('r', '2.5');
    leaderLayer.append(leaderLine, leaderDot); container.append(leaderLayer);
    const callout = document.createElement('span'); callout.className = 'field-callout'; callout.dataset.role = 'callout';
    const calloutLed = document.createElement('i'), calloutText = document.createElement('span'); calloutLed.setAttribute('aria-hidden', 'true');
    callout.append(calloutLed, calloutText); container.append(callout);
    const numberOf = new Map(records.map((record, index) => [record.recording_id, String(index + 1).padStart(2, '0')]));
    let playingId: string | null = null, playbackPaused = false, ghostsShown = false;

    const labels: { element: HTMLSpanElement; position: THREE.Vector3; id?: string; path?: boolean }[] = [];
    const label = (text: string, position: number[], className: string, id?: string) => {
      const element = document.createElement('span'); element.className = className; element.textContent = text;
      if (id) { element.dataset.recordingId = id; element.dataset.worldPosition = position.join(','); }
      container.append(element); labels.push({ element, position: new THREE.Vector3(...position), id });
      return element;
    };
    label('R · RHYTHM', [2.45, -2, -2], 'axis-label axis-R');
    label('P · PITCH', [-2, 2.4, -2], 'axis-label axis-P');
    label('T · TEXTURE', [-2, -2, 2.5], 'axis-label axis-T');
    label('1', [-2, -2.15, -2], 'tick-label');
    for (let tick = 2; tick <= 5; tick++) label(String(tick), [tick - 3, -2.15, -2], 'tick-label');
    for (let tick = 2; tick <= 5; tick++) { label(String(tick), [-2.12, tick - 3, -2.12], 'tick-label'); label(String(tick), [-2.15, -2.15, tick - 3], 'tick-label'); }
    records.forEach(record => {
      const element = label('', worldPosition(record.raw_rtp), 'point-label', record.recording_id);
      const title = document.createElement('strong'), detail = document.createElement('span'), mood = document.createElement('span'), cluster = document.createElement('span');
      title.textContent = record.title; detail.className = 'point-detail'; detail.textContent = `R ${record.raw_rtp.R.toFixed(2)}  T ${record.raw_rtp.T.toFixed(2)}  P ${record.raw_rtp.P.toFixed(2)}`;
      mood.className = 'point-mood'; mood.textContent = `${record.mood.label} · historical`; mood.style.setProperty('--mood', colorOf(record)); cluster.className = 'point-cluster';
      element.append(title, detail, mood, cluster);
    });
    let height = view.current?.height ?? 7.2, frame = 0, disposed = false, renderedFrames = 0;
    let visibleRecords = records, selection = selected;
    let visibleIdentities = new Set(records.map(r => r.recording_id));
    const project = (position: THREE.Vector3) => {
      const value = position.clone().project(camera);
      return { x: (value.x + 1) * container.clientWidth / 2, y: (1 - value.y) * container.clientHeight / 2,
        visible: value.z >= -1 && value.z <= 1 && Math.abs(value.x) <= 1 && Math.abs(value.y) <= 1 };
    };
    const render = () => {
      frame = 0; if (disposed || document.hidden) return;
      renderer.render(scene, camera);
      canvas.dataset.renderFrames = String(++renderedFrames);
      canvas.dataset.gpuResources = JSON.stringify(renderer.info.memory);
      canvas.dataset.camera = JSON.stringify([...camera.position.toArray(), ...controls.target.toArray(), camera.zoom, height]);
      const pathSpots: { x: number; y: number }[] = [];
      labels.forEach(({ element, position, path }) => {
        const classes = element.classList;
        // The selected recording is named by the callout; hover and a different playing recording keep their labels.
        const named = !element.dataset.recordingId || classes.contains('is-hover') || (classes.contains('is-playing') && !classes.contains('is-selected'));
        const included = path || !element.dataset.recordingId || visibleIdentities.has(element.dataset.recordingId);
        if (!named || !included) { element.style.visibility = 'hidden'; return; }
        const p = project(position);
        if (path) { p.x += 12; p.y += 14; if (p.visible) pathSpots.push(p); }
        element.style.transform = `translate(${p.x}px, ${p.y}px)`;
        element.style.visibility = p.visible ? 'visible' : 'hidden';
      });
      placeSelection(pathSpots);
    };
    const placeSelection = (pathSpots: { x: number; y: number }[]) => {
      const record = visibleRecords.find(r => r.recording_id === selection);
      const p = record && project(new THREE.Vector3(...worldPosition(record.raw_rtp)));
      if (!record || !p?.visible) { callout.style.visibility = 'hidden'; leaderLayer.style.visibility = 'hidden'; return; }
      const [x, , z] = worldPosition(record.raw_rtp), floor = project(new THREE.Vector3(x, -2, z));
      const obstacles = [...pathSpots, floor];
      visibleRecords.forEach(other => { if (other !== record) { const q = project(new THREE.Vector3(...worldPosition(other.raw_rtp))); if (q.visible) obstacles.push(q); } });
      if (ghostsShown) records.forEach(other => { if (!visibleIdentities.has(other.recording_id)) obstacles.push(project(new THREE.Vector3(...worldPosition(other.raw_rtp)))); });
      const text = `${numberOf.get(record.recording_id)}  ${record.title}`;
      if (calloutText.textContent !== text) calloutText.textContent = text;
      callout.classList.toggle('is-playing', playingId === record.recording_id);
      const place = placeCallout(p, obstacles, { width: container.clientWidth, height: container.clientHeight }, calloutSize(text));
      callout.style.transform = `translate(${place.x}px, ${place.y}px)`; callout.style.visibility = 'visible';
      leaderLine.setAttribute('x1', String(place.startX)); leaderLine.setAttribute('y1', String(place.startY));
      leaderLine.setAttribute('x2', String(place.anchorX)); leaderLine.setAttribute('y2', String(place.anchorY));
      leaderDot.setAttribute('cx', String(place.anchorX)); leaderDot.setAttribute('cy', String(place.anchorY)); leaderLayer.style.visibility = 'visible';
      callout.dataset.calloutFor = record.recording_id;
    };
    const invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(render); };
    const resize = () => {
      const aspect = container.clientWidth / Math.max(1, container.clientHeight);
      camera.left = -height * aspect / 2; camera.right = height * aspect / 2;
      camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight); invalidate();
    };
    const select = (id: string | null) => {
      selection = id;
      const record = visibleRecords.find(r => r.recording_id === id);
      marker.visible = guide.visible = foot.visible = !!record;
      labels.forEach(l => { if (l.id) l.element.classList.toggle('is-selected', l.id === id); });
      if (record) {
        const [x, y, z] = worldPosition(record.raw_rtp);
        marker.position.set(x, y, z); guideGeometry.setFromPoints([new THREE.Vector3(x, -2, z), new THREE.Vector3(x, y, z)]); guide.computeLineDistances();
        footGeometry.setFromPoints([new THREE.Vector3(x - .09, -2, z), new THREE.Vector3(x + .09, -2, z), new THREE.Vector3(x, -2, z - .09), new THREE.Vector3(x, -2, z + .09)]);
      }
      invalidate();
    };
    const command = (name: CameraCommand) => {
      if (name === 'reset') { controls.target.set(0, 0, 0); camera.position.set(7, 5, 8); }
      if ((name === 'fit' || name === 'reset') && visibleRecords.length) {
        controls.update(); camera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const points = visibleRecords.map(r => new THREE.Vector3(...worldPosition(r.raw_rtp)));
        // Keep the historical reference frame and axis context visible with outliers.
        for (const x of [-2, 2]) for (const y of [-2, 2]) for (const z of [-2, 2]) points.push(new THREE.Vector3(x, y, z));
        const fit = orthographicFit(points.map(point => ({ x: point.dot(right), y: point.dot(up) })),
          container.clientWidth / Math.max(container.clientHeight, 1));
        const shift = right.multiplyScalar(fit.x - controls.target.dot(right))
          .add(up.multiplyScalar(fit.y - controls.target.dot(up)));
        camera.position.add(shift); controls.target.add(shift); height = fit.height; camera.zoom = 1;
      }
      if (name === 'center') {
        // Pan only: orientation and zoom stay, so the chosen recording moves to the middle of the view.
        const record = records.find(r => r.recording_id === selection);
        if (record) { const point = new THREE.Vector3(...worldPosition(record.raw_rtp)); camera.position.add(point.clone().sub(controls.target)); controls.target.copy(point); }
      }
      if (name === 'in' || name === 'out') camera.zoom = THREE.MathUtils.clamp(camera.zoom * (name === 'in' ? 1.25 : .8), .15, 30);
      if (name === 'left' || name === 'right') {
        const offset = camera.position.clone().sub(controls.target);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), name === 'left' ? -.2 : .2);
        camera.position.copy(controls.target).add(offset);
      }
      if (name === 'top') camera.position.copy(controls.target).add(new THREE.Vector3(.001, 12, .001));
      if (name === 'front') camera.position.copy(controls.target).add(new THREE.Vector3(0, 0, 12));
      if (name === 'side') camera.position.copy(controls.target).add(new THREE.Vector3(12, 0, 0));
      camera.updateProjectionMatrix(); controls.update(); resize();
    };
    const visible = (ids?: string[]) => {
      const included = ids ? new Set(ids) : null;
      visibleRecords = records.filter(r => !included || included.has(r.recording_id));
      visibleIdentities = new Set(visibleRecords.map(r => r.recording_id));
      const positions = geometry.getAttribute('position'), colors = geometry.getAttribute('color');
      visibleRecords.forEach((record, index) => {
        const p = worldPosition(record.raw_rtp), color = new THREE.Color(colorOf(record));
        positions.setXYZ(index, ...p); colors.setXYZ(index, color.r, color.g, color.b);
      });
      const excluded = records.filter(r => !visibleIdentities.has(r.recording_id)), ghostPositions = ghostGeometry.getAttribute('position');
      excluded.forEach((record, index) => ghostPositions.setXYZ(index, ...worldPosition(record.raw_rtp)));
      positions.needsUpdate = colors.needsUpdate = ghostPositions.needsUpdate = true;
      geometry.setDrawRange(0, visibleRecords.length); ghostGeometry.setDrawRange(0, excluded.length);
      geometry.computeBoundingSphere(); ghostGeometry.computeBoundingSphere();
      markPlaying(playingId);
      setOverlap(null); select(selection);
    };
    function markPlaying(id: string | null, isPaused = playbackPaused) {
      playingId = id; playbackPaused = isPaused; playMaterial.map = textures[isPaused ? 2 : 1]; playMaterial.needsUpdate = true;
      labels.forEach(l => { if (l.id) l.element.classList.toggle('is-playing', l.id === id); });
      const record = visibleRecords.find(r => r.recording_id === id);
      playMarker.visible = !!record; if (record) playMarker.position.set(...worldPosition(record.raw_rtp));
      invalidate();
    }
    const context = (show: boolean) => { ghosts.visible = ghostsShown = show; invalidate(); };
    const drawPath = (ids: string[]) => {
      labels.filter(l => l.path).forEach(l => l.element.remove());
      labels.splice(0, labels.length, ...labels.filter(l => !l.path));
      const byId = new Map(records.map(r => [r.recording_id, r]));
      const points = ids.map(id => byId.get(id)).map(r => r && new THREE.Vector3(...worldPosition(r.raw_rtp)));
      const segments = points.flatMap((point, index) => point && points[index + 1] ? [point, points[index + 1]!] : []);
      pathLine.geometry.dispose(); pathLine.geometry = new THREE.BufferGeometry().setFromPoints(segments);
      // One label per position; repeated occurrences list every playlist number.
      const numbers = new Map<string, { position: THREE.Vector3; text: string[] }>();
      points.forEach((point, index) => { if (!point) return; const key = point.toArray().join(',');
        numbers.set(key, { position: point, text: [...numbers.get(key)?.text ?? [], String(index + 1)] }); });
      numbers.forEach(({ position, text }) => {
        const element = document.createElement('span'); element.className = 'path-label path-number'; element.setAttribute('aria-hidden', 'true'); element.textContent = text.join(' · ');
        container.append(element); labels.push({ element, position, path: true });
      });
      invalidate();
    };
    runtime.current = { select, command, visible, playing: markPlaying, context, path: drawPath };
    controls.addEventListener('change', invalidate);
    const observer = new ResizeObserver(resize); observer.observe(container);
    const focus = () => { controls.enableZoom = true; };
    const blur = () => { controls.enableZoom = false; };
    canvas.addEventListener('focus', focus); canvas.addEventListener('blur', blur);
    let down = { x: 0, y: 0 };
    const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; canvas.focus({ preventScroll: true }); };
    const hitsAt = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const projected = visibleRecords.map(record => ({ id: record.recording_id, ...project(new THREE.Vector3(...worldPosition(record.raw_rtp))) }));
      return { hits: screenHits(projected, event.clientX - bounds.left, event.clientY - bounds.top), x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const pointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const { hits, x, y } = hitsAt(event);
      if (hits.length === 1) { choose.current(hits[0].id); setOverlap(null); }
      else setOverlap(hits.length ? { ids: hits.map(hit => hit.id), ...pickerPosition(x, y, container.clientWidth, container.clientHeight) } : null);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.buttons) return;
      const { hits } = hitsAt(event);
      canvas.style.cursor = hits.length ? 'pointer' : 'grab';
      // The nearest recording is named; a cluster says how many more are within reach.
      labels.forEach(l => {
        if (!l.id) return; const hovered = hits.length > 0 && hits[0].id === l.id;
        l.element.classList.toggle('is-hover', hovered);
        if (hovered) l.element.querySelector('.point-cluster')!.textContent = hits.length > 1 ? `+${hits.length - 1} more here · click to choose` : '';
      });
      invalidate();
    };
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); fallback.current?.(); };
    const leave = () => { labels.forEach(l => l.element.classList.remove('is-hover')); invalidate(); };
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', invalidate);
    // Include out-of-domain points in the initial framing without changing positions.
    if (!view.current) command('fit');
    controls.update(); resize(); visible(visibleIds); select(selected); markPlaying(playing, paused); context(showExcluded); drawPath(path);
    return () => {
      view.current = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom, height };
      disposed = true; cancelAnimationFrame(frame); runtime.current = null; observer.disconnect();
      document.removeEventListener('visibilitychange', invalidate);
      canvas.removeEventListener('focus', focus); canvas.removeEventListener('blur', blur);
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('webglcontextlost', lost); controls.dispose();
      canvas.removeEventListener('pointerleave', leave);
      geometry.dispose(); material.dispose(); markerGeometry.dispose(); markerMaterial.dispose(); playGeometry.dispose(); playMaterial.dispose();
      ghostGeometry.dispose(); ghostMaterial.dispose(); pathLine.geometry.dispose(); pathMaterial.dispose();
      guideGeometry.dispose(); guideMaterial.dispose(); footGeometry.dispose(); footMaterial.dispose(); frameGeometry.dispose(); frameMaterial.dispose();
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose(); (rearGrid.material as THREE.Material).dispose(); textures.forEach(texture => texture.dispose());
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); labels.forEach(l => l.element.remove()); callout.remove(); leaderLayer.remove();
    };
    // Filtering reuses GPU buffers; publication replaces resources and restores the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);
  useEffect(() => runtime.current?.select(selected), [selected]);
  useEffect(() => runtime.current?.visible(visibleIds), [visibleIds]);
  useEffect(() => runtime.current?.playing(playing, paused), [playing, paused]);
  useEffect(() => runtime.current?.context(showExcluded), [showExcluded]);
  useEffect(() => runtime.current?.path(path), [path]);
  const closeChooser = () => { setOverlap(null); host.current?.querySelector('canvas')?.focus(); };
  return <div className="spatial-scene" ref={host}>
    {unavailable && <div className="scene-fallback" role="status">The 3D view is unavailable. Select and listen using the recording list.</div>}
    {overlap && overlap.ids.length > 1 && <OverlapPicker ids={overlap.ids} records={records} at={overlap} onClose={closeChooser}
      onChoose={id => { onSelect(id); closeChooser(); }}/>}
  </div>;
});
