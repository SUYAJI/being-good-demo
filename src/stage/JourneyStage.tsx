import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Recording, RTP } from '../types';
import { StageRenderer, type StageClock, type StageCommand, type StageJourney, type StagePlayback } from './StageRenderer';

export type StageHandle = { command: (name: StageCommand) => void; finishReveal: () => void };
type Props = {
  records: Recording[]; selected: string | null; onSelect: (id: string) => void; onHover?: (id: string | null) => void; peek?: string | null;
  emphasis: number[] | null; intended: RTP[] | null; marker: RTP | null;
  journey: StageJourney | null;
  /** Bumped when a playlist is created; the next new journey plays its reveal. */
  revealKey: number;
  playback: StagePlayback; clock: StageClock;
  insets: { left: number; right: number };
  label: string; reduced: boolean;
  onReveal?: (phase: 'searching' | 'done') => void;
  /** Shown when WebGL is unavailable or the context is lost: the same data in the 2D field. */
  fallback: ReactNode; children?: ReactNode;
};

export const JourneyStage = forwardRef<StageHandle, Props>(function JourneyStage(props, ref) {
  const host = useRef<HTMLDivElement>(null), runtime = useRef<StageRenderer | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(props); latest.current = props;
  const pendingReveal = useRef<{ key: number; at: number } | null>(null), seenReveal = useRef(props.revealKey);
  useImperativeHandle(ref, () => ({ command: name => runtime.current?.command(name), finishReveal: () => runtime.current?.finishReveal() }), []);

  useLayoutEffect(() => {
    if (unavailable || !host.current) return;
    let stage: StageRenderer;
    try {
      stage = new StageRenderer(host.current, props.records, {
        onSelect: id => latest.current.onSelect(id), onHover: id => latest.current.onHover?.(id),
        onUnavailable: () => setUnavailable(true), onReveal: phase => latest.current.onReveal?.(phase),
      }, props.reduced);
    } catch { setUnavailable(true); return; }
    runtime.current = stage;
    const p = latest.current;
    stage.setInsets(p.insets.left, p.insets.right); stage.setEmphasis(p.emphasis); stage.setIntended(p.intended); stage.setMarker(p.marker);
    stage.setSelected(p.selected); stage.setPeek(p.peek ?? null); stage.setPlayback(p.playback, p.clock); stage.setJourney(p.journey, false);
    return () => { runtime.current = null; stage.dispose(); };
    // A new catalogue makes a new stage; everything else streams into the running one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.records, unavailable]);

  const canvasLabel = props.label;
  useEffect(() => { runtime.current?.canvas.setAttribute('aria-label', canvasLabel); }, [canvasLabel, unavailable]);
  useEffect(() => { runtime.current?.setInsets(props.insets.left, props.insets.right); }, [props.insets.left, props.insets.right]);
  useEffect(() => { runtime.current?.setEmphasis(props.emphasis); }, [props.emphasis]);
  useEffect(() => { runtime.current?.setIntended(props.intended); }, [props.intended]);
  useEffect(() => { runtime.current?.setMarker(props.marker); }, [props.marker]);
  useEffect(() => { runtime.current?.setSelected(props.selected); }, [props.selected]);
  useEffect(() => { runtime.current?.setPeek(props.peek ?? null); }, [props.peek]);
  useEffect(() => { runtime.current?.setPlayback(props.playback, props.clock); }, [props.playback, props.clock]);
  useEffect(() => {
    if (props.revealKey !== seenReveal.current) { seenReveal.current = props.revealKey; pendingReveal.current = { key: props.revealKey, at: performance.now() }; }
  }, [props.revealKey]);
  const journeyKey = props.journey ? `${props.journey.style}:${props.journey.key}` : '';
  useEffect(() => {
    // A reveal belongs to the journey that arrives just after Create; a stale request never animates a later edit.
    const pending = pendingReveal.current, reveal = !!pending && !!props.journey && performance.now() - pending.at < 2000;
    if (props.journey) pendingReveal.current = null;
    runtime.current?.setJourney(props.journey, reveal);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyKey]);

  return <div className={`journey-stage${unavailable ? ' is-fallback' : ''}`} ref={host}>
    {unavailable && <div className="stage-fallback">{props.fallback}</div>}
    {props.children}
  </div>;
});
