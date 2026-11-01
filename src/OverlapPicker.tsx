import { useEffect, useRef } from 'react';
import { colorOf, type Recording } from './types';

/** Disambiguates recordings whose glyphs share a screen position; positions are never altered. */
export function OverlapPicker({ ids, records, at, onChoose, onClose }: {
  ids: string[]; records: Recording[]; at: { x: number; y: number }; onChoose: (id: string) => void; onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { host.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [ids]);
  const byId = new Map(records.map(record => [record.recording_id, record]));
  return <div ref={host} className="overlap-picker" role="group" aria-label="Overlapping recordings" style={{ left: at.x, top: at.y }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...host.current!.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}><p>{ids.length} recordings at this position</p>{ids.map(id => { const record = byId.get(id); return record &&
    <button key={id} onClick={() => onChoose(id)}><strong>{record.title}</strong>
      <span><i style={{ background: colorOf(record) }}/>{record.mood.label} · R {record.raw_rtp.R.toFixed(2)} · T {record.raw_rtp.T.toFixed(2)} · P {record.raw_rtp.P.toFixed(2)}</span></button>; })}
    <button onClick={onClose}>Close chooser</button></div>;
}

/** Keep a floating chooser inside its container. */
export const pickerPosition = (x: number, y: number, width: number, height: number) =>
  ({ x: Math.max(8, Math.min(x + 12, width - 300)), y: Math.max(8, Math.min(y + 12, height - 260)) });
