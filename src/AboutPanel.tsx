import { useEffect, useMemo, useState } from 'react';
import { Panel } from './FilterPanel';
import { dataURL } from './staticBackend';
import { colorOf, type Recording } from './types';
import { axisExamples } from './journeyDesign';

const Linked = ({ href, children }: { href: string; children: string }) =>
  href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;

export type DesignItem = { title: string; stage: string; image: string; caption?: string };
const axisNames = { R: 'Rhythm', T: 'Texture', P: 'Pitch' } as const;
const axisMeaning = {
  R: 'how the recording moves: driving or still, regular or loose. It is not simply tempo.',
  T: 'how full the sound is: sparse and airy at one end, dense and layered at the other.',
  P: 'where the sound sits: low and dark through bright and high. It is not the musical key.',
} as const;

/** How it works: what Being Good does, the three qualities with real examples, and the research behind it. Credits live in their own view. */
export function AboutPanel({ open, onClose, records, onListen, onCredits }: { open: boolean; onClose: () => void; records: Recording[]; onListen?: (record: Recording) => void; onCredits: () => void }) {
  const [design, setDesign] = useState<DesignItem[]>([]);
  useEffect(() => {
    if (!open) return;
    // Design-process artifacts are optional; the section stays hidden until items are published.
    fetch(dataURL('design-process.json')).then(r => r.ok ? r.json() : { items: [] }).then(value => setDesign(Array.isArray(value.items) ? value.items : []), () => setDesign([]));
  }, [open]);
  const examples = useMemo(() => axisExamples(records), [records]);
  const Example = ({ record, note }: { record: Recording | null; note: string }) => record ? <span className="axis-example">
    <span className="mono muted">{note}</span><strong>{record.title}</strong>
    {onListen && record.playback_status === 'available' && <button className="key key-small" onClick={() => { onListen(record); onClose(); }} aria-label={`Listen to ${record.title}`}>Listen</button>}
  </span> : null;
  return <Panel open={open} onClose={onClose} title="How it works" className="about-panel">
    <section className="about-section">
      <p className="about-lead"><strong>Being Good</strong> describes music by how it sounds rather than by genre or tags. Each recording gets three scores from 1 to 5, for <strong>Rhythm, Texture and Pitch</strong>,
        which place it in a shared space. Recordings that land near each other share those qualities; a playlist that moves through the space changes gradually from one to the next.</p>
      <p>This Explorer holds {records.length} real recordings that were analyzed by the original Being Good engine. You can listen to them, see where they sit, and shape playlists that travel through the space.</p>
    </section>
    <section className="about-section">
      <h3 className="label-caps">THE THREE QUALITIES</h3>
      <dl className="about-axes">{examples.map(({ axis, low, high }) => <div key={axis} className={`axis-${axis}`}>
        <dt>{axisNames[axis]}</dt><dd>{axisMeaning[axis]}
          <span className="axis-examples"><Example record={low} note={`Low ${axisNames[axis].toLowerCase()} · ${low?.raw_rtp[axis].toFixed(1) ?? ''}`}/><Example record={high} note={`High ${axisNames[axis].toLowerCase()} · ${high?.raw_rtp[axis].toFixed(1) ?? ''}`}/></span></dd></div>)}</dl>
      <p>Moods are read from those positions. Low rhythm and a sparse texture tend to read as <span className="about-mood"><i style={{ background: '#3155ee' }}/>Peaceful</span>; as rhythm and texture rise the same lookup moves through
        <span className="about-mood"><i style={{ background: '#069c72' }}/>Cautious-peaceful</span> toward <span className="about-mood"><i style={{ background: '#b5bc00' }}/>Cautious-excited</span> and <span className="about-mood"><i style={{ background: '#00adbf' }}/>Happy</span>.
        {records.length > 0 && ` In this collection most recordings are calm: ${records.filter(r => ['peaceful', 'cautious-peaceful'].includes(r.mood.id)).length} of ${records.length} are Peaceful or Cautious-peaceful.`}</p>
    </section>
    <section className="about-section">
      <h3 className="label-caps">MAKING A PLAYLIST</h3>
      <p>The Playlist Designer asks where to begin (a mood, a recording, or anywhere) and how the playlist should move. That shape becomes a series of points through the space, and the Explorer picks the recording nearest each point,
        using every recording only once. You can then keep the ones you like, swap the others, change the order, and save the result in this browser.</p>
      <p className="fine-print">Distance in the space is geometric. Two recordings that sit close together share measured qualities; that is a good reason to try them side by side, not proof that they sound alike.</p>
    </section>
    {design.length > 0 && <section className="about-section">
      <h3 className="label-caps">DESIGN PROCESS</h3>
      <ul className="design-items">{design.map(item => <li key={item.image}><figure>
        <img src={new URL(item.image, dataURL('')).href} alt={item.title} loading="lazy"/>
        <figcaption><span className="label-caps muted">{item.stage}</span><strong>{item.title}</strong>{item.caption && <span>{item.caption}</span>}</figcaption>
      </figure></li>)}</ul>
    </section>}
    <section className="about-section">
      <details className="about-research"><summary>The research and the technical details</summary>
        <p>Being Good was a long-running research project (2013–2024) that produced two issued U.S. patents on describing and organizing music by Rhythm, Texture and Pitch. Human listeners rated a reference set of recordings on the three axes;
          fitted predictors then estimate the scores for new recordings from many acoustic measurements taken together.</p>
        <p>Every position in this demonstration was computed offline by the original pipeline: the pinned historical acoustic extractor and the original fitted predictors, run on each original audio file. Nothing is analyzed, invented or simulated in the browser,
          and recordings cannot be added here. The field shows each recording’s continuous (raw) position. Its mood comes from the historical mood map, which assigns a mood to each half-point cell of the space; the mood atlas view shows that map directly.</p>
        <p>Playlist generation interpolates your shape into evenly spaced points by playlist order and assigns distinct playable recordings to minimize the total Euclidean distance in raw RTP. “Intensity” in the filters measures geometry within a mood region, not confidence.
          Playback copies are 96 kbps MP3s decoded from the same originals that were analyzed; the analysis used the originals.</p>
        <p>Playlists you save stay in this browser’s storage and never change the published recordings or results. The source for this demonstration is public; the models, extractor and mood-map bundle are not part of it.</p>
      </details>
    </section>
    <section className="about-section about-credits-link">
      <p>Every recording is a real work from ccMixter, used for this personal, noncommercial demonstration with credit to each artist and source.</p>
      <button className="key" onClick={() => { onClose(); onCredits(); }}>Recordings and credits</button>
    </section>
  </Panel>;
}

/** Full attribution for every published recording, kept out of the way of the explanation but one step from it. */
export function CreditsPanel({ open, onClose, records, onSelect }: { open: boolean; onClose: () => void; records: Recording[]; onSelect?: (id: string) => void }) {
  const credited = useMemo(() => [...records].sort((a, b) => a.title.localeCompare(b.title)), [records]);
  return <Panel open={open} onClose={onClose} title="Recordings and credits" className="about-panel credits-panel">
    <section className="about-section">
      <p className="fine-print">{records.length} recordings, used for a personal, noncommercial demonstration, with credit to each artist and source. Playback copies are re-encoded at a lower bit rate; the analysis used each original file.
        Each recording’s own card in the Explorer links to its source as well.</p>
      <ol className="credits">{credited.map(record => <li key={record.recording_id}>
        <button className="credit-title" onClick={() => { onSelect?.(record.recording_id); onClose(); }} title="Show in the Explorer"><i style={{ background: colorOf(record) }} aria-hidden="true"/><strong>{record.title}</strong></button>
        {record.credit ? <span>{record.credit.artist} · <Linked href={record.credit.source_url}>{record.credit.source}</Linked>
          {record.credit.license_name && <>{' · '}<Linked href={record.credit.license_url}>{record.credit.license_name}</Linked></>}</span> : <span>Credit unavailable</span>}
      </li>)}</ol>
    </section>
  </Panel>;
}
