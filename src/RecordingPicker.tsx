import { useId, useMemo, useState } from 'react';
import { colorOf, type Recording } from './types';

/** Find a recording by title, artist or mood without leaving the designer. Results name their mood; hovering one points to it in the space. */
export function RecordingPicker({ records, label, onPick, onPeek, exclude = [] }: {
  records: Recording[]; label: string; onPick: (id: string) => void; onPeek?: (id: string | null) => void; exclude?: string[];
}) {
  const id = useId(), [query, setQuery] = useState('');
  const text = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => text ? records.filter(r => r.playback_status === 'available' && !exclude.includes(r.recording_id) &&
    `${r.title} ${r.credit?.artist ?? ''} ${r.mood.label}`.toLocaleLowerCase().includes(text)).slice(0, 7) : [], [records, text, exclude]);
  const pick = (value: string) => { onPick(value); onPeek?.(null); setQuery(''); };
  return <div className="recording-picker">
    <label className="sr-only" htmlFor={id}>{label}</label>
    <input id={id} type="search" placeholder={label} value={query} autoComplete="off" onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && matches[0]) { event.preventDefault(); pick(matches[0].recording_id); } }}/>
    {text && <ul className="picker-results" aria-label={`${label}: results`}>
      {matches.map(record => <li key={record.recording_id}><button type="button" onClick={() => pick(record.recording_id)}
        onMouseEnter={() => onPeek?.(record.recording_id)} onMouseLeave={() => onPeek?.(null)} onFocus={() => onPeek?.(record.recording_id)} onBlur={() => onPeek?.(null)}>
        <i style={{ background: colorOf(record) }}/><span><strong>{record.title}</strong><small>{record.mood.label}</small></span></button></li>)}
      {!matches.length && <li className="picker-empty">No recording matches “{query.trim()}”.</li>}
    </ul>}
  </div>;
}
