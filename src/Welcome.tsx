import { useEffect, useMemo, useRef } from 'react';
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

/** The opening screen: what the Explorer is for, one primary action, a way in for browsing, and real suggested journeys.
 * The space itself is the picture beside it: hovering or focusing a suggestion draws that journey there. */
export function Welcome({ records, categories, onCreate, onSuggest, onExplore, onAbout, onPreview, library = [], onOpenSaved }: {
  records: Recording[]; categories: { id: string; label: string }[];
  onCreate: () => void; onSuggest: (suggestion: Suggestion) => void; onExplore: () => void; onAbout: () => void; onPreview?: (suggestion: Suggestion | null) => void;
  library?: { id: string; name: string; count: number }[]; onOpenSaved?: (id: string) => void;
}) {
  const suggestions = useMemo(() => suggestedJourneys(records, categories), [records, categories]);
  const moods = useMemo(() => categories.map(c => ({ ...c, count: records.filter(r => r.mood.id === c.id).length, color: records.find(r => r.mood.id === c.id) })).filter(m => m.count), [records, categories]);
  useEffect(() => () => onPreview?.(null), [onPreview]);
  // One journey leads: it starts where most of the music is, rises and comes back, so the shape is easy to see and hear.
  const featured = suggestions.find(item => item.id === 'rise-settle') ?? suggestions[0] ?? null;
  const others = suggestions.filter(item => item !== featured);
  const valueOf = (item: typeof suggestions[number]): Suggestion => ({ start: item.start, preset: item.preset, endId: item.endId, length: item.length, name: item.name });
  const previewing = (item: typeof suggestions[number]) => ({ onMouseEnter: () => onPreview?.(valueOf(item)), onMouseLeave: () => onPreview?.(null),
    onFocus: () => onPreview?.(valueOf(item)), onBlur: () => onPreview?.(null) });
  return <section className="welcome" aria-label="Welcome">
    <div className="welcome-copy">
      <span className="eyebrow">BEING GOOD EXPLORER</span>
      <h1>Playlists that follow a shape.</h1>
      <p>Being Good describes each recording by three qualities you can hear: its <strong className="axis-R">Rhythm</strong>, its <strong className="axis-T">Texture</strong> and its <strong className="axis-P">Pitch</strong>. Every recording here has a place in that space.
        Choose where a playlist should start and how it should move, and the Explorer picks real recordings along the way.</p>
      <div className="welcome-actions">
        {featured ? <button className="primary key welcome-featured" onClick={() => { onPreview?.(null); onSuggest(valueOf(featured)); }} {...previewing(featured)}>
          <span>Start with “{featured.name}”</span><small>{featured.description} {featured.length} recordings.</small></button> :
          <button className="primary key" onClick={onCreate}>Create a playlist</button>}
        <div className="welcome-secondary">
          {featured && <button className="key" onClick={onCreate}>Design your own</button>}
          <button className="key" onClick={onExplore}>Explore the music</button>
          <button className="welcome-link" onClick={onAbout}>How it works</button>
        </div>
      </div>
      {others.length > 0 && <div className="welcome-starts">
        <span className="label-caps">Or try another journey</span>
        <div className="suggestion-list">{others.map((item, index) =>
          <button key={item.id} className="suggestion" onClick={() => { onPreview?.(null); onSuggest(valueOf(item)); }} {...previewing(item)}>
            <span className="suggestion-index mono">{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.name}</strong><span>{item.description}</span><span className="mono muted">{item.length} recordings →</span></button>)}</div>
      </div>}
      {library.length > 0 && onOpenSaved && <div className="welcome-saved">
        <span className="label-caps">Your playlists in this browser</span>
        <ul>{library.slice(0, 4).map(item => <li key={item.id}><button className="welcome-link" onClick={() => onOpenSaved(item.id)}>{item.name}</button><span className="mono muted"> · {item.count}</span></li>)}</ul>
      </div>}
      <p className="fine-print">{records.length || '…'} recordings from ccMixter, analyzed by the original Being Good engine. Playlists you make are saved in this browser.</p>
      {moods.length > 0 && <p className="welcome-moods" aria-label="Mood colours"><span className="label-caps muted">Colour is mood</span>{moods.map(m =>
        <span key={m.id}><i style={{ background: m.color ? colorOf(m.color) : '#999' }}/>{m.label}</span>)}</p>}
    </div>
  </section>;
}
