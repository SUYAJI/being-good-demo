import { useEffect, useMemo, useRef, useState } from 'react';
import { colorOf, type Recording } from './types';
import { suggestedJourneys } from './journeyDesign';
import type { Suggestion } from './PlaylistDesigner';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short start-up mark: the wordmark settles, the dot lands, three meters sweep. Any key or click skips it. */
export function Intro({ onDone, duration = 1700 }: { onDone: () => void; duration?: number }) {
  const done = useRef(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };
  useEffect(() => {
    if (reducedMotion()) { finish(); return; }
    const timer = setTimeout(finish, duration);
    const key = (event: KeyboardEvent) => { if (!event.metaKey && !event.ctrlKey) finish(); };
    addEventListener('keydown', key);
    return () => { clearTimeout(timer); removeEventListener('keydown', key); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="intro" role="presentation" onPointerDown={finish}>
    <div className="intro-mark" aria-hidden="true">
      <span className="intro-word">{'being good'.split('').map((letter, index) => <span key={index} style={{ animationDelay: `${index * 32}ms` }}>{letter === ' ' ? ' ' : letter}</span>)}<span className="intro-dot"/></span>
      <span className="intro-meters"><i className="axis-R"/><i className="axis-T"/><i className="axis-P"/></span>
      <span className="intro-sub mono">EXPLORER</span>
    </div>
    <button className="key key-small intro-skip" onClick={finish}>Skip</button>
  </div>;
}

/** The opening screen: what the Explorer is for, one primary action, a way in for browsing, and real suggested journeys. */
export function Welcome({ records, categories, onCreate, onSuggest, onExplore, onAbout }: {
  records: Recording[]; categories: { id: string; label: string }[];
  onCreate: () => void; onSuggest: (suggestion: Suggestion) => void; onExplore: () => void; onAbout: () => void;
}) {
  const suggestions = useMemo(() => suggestedJourneys(records, categories), [records, categories]);
  const [hover, setHover] = useState<Recording | null>(null);
  // The welcome picture is the real Rhythm–Texture layout of the collection, nothing decorative.
  const dots = useMemo(() => {
    if (!records.length) return [];
    const rs = records.map(r => r.raw_rtp.R), ts = records.map(r => r.raw_rtp.T);
    const [rmin, rmax, tmin, tmax] = [Math.min(...rs) - .2, Math.max(...rs) + .2, Math.min(...ts) - .2, Math.max(...ts) + .2];
    return records.map(record => ({ record, x: 20 + (record.raw_rtp.R - rmin) / (rmax - rmin) * 320, y: 300 - (record.raw_rtp.T - tmin) / (tmax - tmin) * 280 }));
  }, [records]);
  return <section className="welcome" aria-label="Welcome">
    <div className="welcome-copy">
      <span className="eyebrow">BEING GOOD EXPLORER</span>
      <h1>Playlists that follow a shape.</h1>
      <p>Being Good describes each recording by three qualities you can hear: its <strong>Rhythm</strong>, its <strong>Texture</strong> and its <strong>Pitch</strong>. Every recording here has a place in that space.
        Choose where a playlist should start and how it should move, and the Explorer picks real recordings along the way.</p>
      <div className="welcome-actions">
        <button className="primary key" onClick={onCreate}>Create a playlist</button>
        <button className="key" onClick={onExplore}>Explore the music</button>
        <button className="welcome-link" onClick={onAbout}>How it works</button>
      </div>
      <p className="fine-print">{records.length || '…'} recordings from ccMixter, analyzed by the original Being Good engine. Playlists you make are saved in this browser.</p>
      {suggestions.length > 0 && <div className="welcome-starts">
        <span className="label-caps">Or start with one of these</span>
        <div className="suggestion-list">{suggestions.map(item => <button key={item.id} className="suggestion" onClick={() => onSuggest({ start: item.start, preset: item.preset, endId: item.endId, length: item.length, name: item.name })}>
          <strong>{item.name}</strong><span>{item.description}</span><span className="mono muted">{item.length} recordings →</span></button>)}</div>
      </div>}
    </div>
    <div className="welcome-field" aria-hidden="true">
      <svg viewBox="0 0 360 320" role="presentation">
        <text className="welcome-axis axis-T" x="8" y="14">↑ TEXTURE</text><text className="welcome-axis axis-R" x="352" y="314" textAnchor="end">RHYTHM →</text>
        {dots.map(({ record, x, y }) => <circle key={record.recording_id} cx={x} cy={y} r={hover === record ? 7 : 4.5} fill={colorOf(record)}
          onMouseEnter={() => setHover(record)} onMouseLeave={() => setHover(null)}/>)}
      </svg>
      <p className="welcome-readout mono">{hover ? `${hover.title} · ${hover.mood.label}` : 'Each dot is a recording, placed by its Rhythm and Texture. Colour is its mood.'}</p>
    </div>
  </section>;
}
