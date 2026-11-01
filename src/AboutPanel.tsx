import { useEffect, useState } from 'react';
import { Panel } from './FilterPanel';
import { dataURL } from './staticBackend';
import type { Recording } from './types';

const Linked = ({ href, children }: { href: string; children: string }) =>
  href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;

export type DesignItem = { title: string; stage: string; image: string; caption?: string };

/** Read-only notice, a short RTP explanation and full credits for the published recordings. */
export function AboutPanel({ open, onClose, records }: { open: boolean; onClose: () => void; records: Recording[] }) {
  const [design, setDesign] = useState<DesignItem[]>([]);
  useEffect(() => {
    if (!open) return;
    // Design-process artifacts are optional; the section stays hidden until items are published.
    fetch(dataURL('design-process.json')).then(r => r.ok ? r.json() : { items: [] }).then(value => setDesign(Array.isArray(value.items) ? value.items : []), () => setDesign([]));
  }, [open]);
  const credited = [...records].sort((a, b) => a.title.localeCompare(b.title));
  return <Panel open={open} onClose={onClose} title="About this demonstration" className="about-panel">
    <section className="about-section">
      <p><strong>Being Good</strong> places music in a shared space of three perceptual scores: <strong>Rhythm, Texture and Pitch</strong> (RTP).
        This is a read-only demonstration of the Explorer with {records.length} real recordings.</p>
      <p>Every position shown here was computed offline by the original Being Good RTP pipeline: the pinned historical acoustic extractor and the
        original fitted predictors. Nothing is analyzed, invented or simulated in your browser. Recordings cannot be added here.</p>
      <p>Playlists and journey targets you create are saved only in this browser. They never change the published recordings or results.</p>
    </section>
    <section className="about-section">
      <h3 className="label-caps">RHYTHM · TEXTURE · PITCH</h3>
      <dl className="about-axes">
        <div className="axis-R"><dt>R · Rhythm</dt><dd>The recording’s perceived rhythmic character. It is not simply tempo.</dd></div>
        <div className="axis-T"><dt>T · Texture</dt><dd>The perceived character of the recording’s sound as a whole.</dd></div>
        <div className="axis-P"><dt>P · Pitch</dt><dd>The recording’s perceived tonal character. It is not simply musical key.</dd></div>
      </dl>
      <p>Each axis runs from 1 to 5. Human listeners originally rated a sample of tracks on these axes; the predictors estimate the scores for
        new recordings from many acoustic measurements together. The field shows each recording’s continuous (raw) position. Its color comes from
        the historical mood map, which assigns a mood to each half-point position.</p>
      <p className="fine-print">Distance in the field is geometric. Two nearby recordings are not proven to sound alike.</p>
    </section>
    {design.length > 0 && <section className="about-section">
      <h3 className="label-caps">DESIGN PROCESS</h3>
      <ul className="design-items">{design.map(item => <li key={item.image}><figure>
        <img src={new URL(item.image, dataURL('')).href} alt={item.title} loading="lazy"/>
        <figcaption><span className="label-caps muted">{item.stage}</span><strong>{item.title}</strong>{item.caption && <span>{item.caption}</span>}</figcaption>
      </figure></li>)}</ul>
    </section>}
    <section className="about-section">
      <h3 className="label-caps">RECORDINGS AND CREDITS</h3>
      <p className="fine-print">Recordings are used for a personal, noncommercial demonstration, with credit to each artist and source. Playback copies are re-encoded
        at a lower bit rate; the analysis used each original file.</p>
      <ol className="credits">{credited.map(record => <li key={record.recording_id}>
        <strong>{record.title}</strong>
        {record.credit ? <span>{record.credit.artist} · <Linked href={record.credit.source_url}>{record.credit.source}</Linked>
          {record.credit.license_name && <>{' · '}<Linked href={record.credit.license_url}>{record.credit.license_name}</Linked></>}</span> : <span>Credit unavailable</span>}
      </li>)}</ol>
    </section>
  </Panel>;
}
