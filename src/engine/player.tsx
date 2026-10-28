// The studio's player (npm run studio): a composition picker, its props, the stage scaled to the window, and a
// transport with a scrubber. Its soundtrack comes from the same dry run and mixer as a render (audio.ts via studio.ts).
// Keys: space play/pause, left/right one frame (shift: one second), home/end. The URL hash keeps the place across reloads.
import type React from 'react';
import { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { dryRun, resolve, Stage, type AnyComposition, type Resolved } from './page.tsx';

const UI = { bg: '#14161f', panel: '#1d2030', line: '#30344a', text: '#e8eaf6', muted: '#8f95b2', accent: '#ffb238', error: '#ff6b7a' };
const BAR_H = 56, TRANSPORT_H = 64;

interface Place { c?: string; p?: string; f?: number }
const readHash = (): Place => {
  const h = new URLSearchParams(location.hash.slice(1));
  return { c: h.get('c') ?? undefined, p: h.get('p') ?? undefined, f: h.has('f') ? Number(h.get('f')) : undefined };
};
const writeHash = (place: Place) => {
  history.replaceState(null, '', `#${new URLSearchParams({ c: place.c ?? '', p: place.p ?? '', f: String(place.f ?? 0) })}`);
};

/** Shows a composition's error instead of the stage (the player keeps working). */
class Boundary extends Component<{ children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    return this.state.error ? <ErrorText error={this.state.error} /> : this.props.children;
  }
}

const ErrorText: React.FC<{ error: unknown }> = ({ error }) => (
  <pre style={{ color: UI.error, whiteSpace: 'pre-wrap', padding: 24, margin: 0, fontSize: 13 }}>
    {error instanceof Error ? error.stack ?? error.message : String(error)}
  </pre>
);

function useWindowSize() {
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return size;
}

const button: React.CSSProperties = {
  background: UI.panel, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 6, padding: '6px 12px', font: 'inherit', cursor: 'pointer',
};

const Player: React.FC<{ compositions: AnyComposition[] }> = ({ compositions }) => {
  const start = readHash();
  const find = (id: string) => compositions.find(c => c.id === id) ?? compositions[0];
  const [id, setId] = useState(find(start.c ?? '').id);
  const [propsText, setPropsText] = useState(start.p || JSON.stringify(find(id).defaultProps));
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [frame, setFrame] = useState(start.f ?? 0);
  const [playing, setPlaying] = useState(false);
  const [audio, setAudio] = useState<{ state: 'none' | 'working' | 'ready' | 'error'; url?: string }>({ state: 'none' });
  const audioRef = useRef<HTMLAudioElement>(null);
  const place = useRef<Place>({});
  place.current = { c: id, p: propsText, f: frame };
  const { w, h } = useWindowSize();

  const load = useCallback(async (compId: string, text: string) => {
    setPlaying(false);
    setError(null);
    setResolved(null);
    setAudio({ state: 'none' });
    let r: Resolved;
    try {
      r = await resolve(find(compId), JSON.parse(text || '{}'));
    } catch (e) {
      setError(e);
      return;
    }
    setResolved(r);
    setFrame(f => Math.max(0, Math.min(f, r.config.durationInFrames - 1)));
    setAudio({ state: 'working' });
    try {
      const { tracks } = await dryRun(r, false);
      if (!tracks.length) { setAudio({ state: 'none' }); return; }
      const res = await fetch('/audio', { method: 'POST', body: JSON.stringify({ tracks, fps: r.config.fps, durationInFrames: r.config.durationInFrames }) });
      const { url } = await res.json() as { url: string | null };
      setAudio(url ? { state: 'ready', url } : { state: 'none' });
    } catch (e) {
      console.error(e);
      setAudio({ state: 'error' });
    }
  }, []);

  useEffect(() => { load(id, propsText); }, []);

  // Reload when the code is rebuilt, at the same place.
  useEffect(() => {
    const events = new EventSource('/events');
    events.onmessage = () => { writeHash(place.current); location.reload(); };
    return () => events.close();
  }, []);

  useEffect(() => { if (!playing) writeHash(place.current); }, [playing, frame, id, propsText]);

  // Playback: the audio element is the clock when there is sound.
  useEffect(() => {
    if (!playing || !resolved) return;
    const { fps, durationInFrames } = resolved.config;
    const el = audio.url ? audioRef.current : null;
    const from = place.current.f ?? 0, t0 = performance.now();
    if (el) { el.currentTime = from / fps; el.play().catch(() => {}); }
    let raf = requestAnimationFrame(function tick() {
      const f = el ? Math.floor(el.currentTime * fps) : from + Math.floor(((performance.now() - t0) / 1000) * fps);
      if (f >= durationInFrames) { setFrame(durationInFrames - 1); setPlaying(false); return; }
      setFrame(f);
      raf = requestAnimationFrame(tick);
    });
    return () => { cancelAnimationFrame(raf); el?.pause(); };
  }, [playing, resolved, audio.url]);

  // Keys.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!resolved || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const { fps, durationInFrames } = resolved.config;
      const go = (f: number) => { setPlaying(false); setFrame(Math.max(0, Math.min(durationInFrames - 1, f))); };
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'ArrowLeft') go((place.current.f ?? 0) - (e.shiftKey ? fps : 1));
      else if (e.key === 'ArrowRight') go((place.current.f ?? 0) + (e.shiftKey ? fps : 1));
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(durationInFrames - 1);
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [resolved]);

  const config = resolved?.config;
  const scale = config ? Math.min((w - 32) / config.width, (h - BAR_H - TRANSPORT_H - 32) / config.height) : 1;
  const seconds = (f: number) => (config ? (f / config.fps).toFixed(2) : '0.00');

  return (
    <div style={{ position: 'fixed', inset: 0, background: UI.bg, color: UI.text, font: '14px system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: BAR_H, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: `1px solid ${UI.line}` }}>
        <select
          value={id}
          onChange={e => { const next = e.target.value, text = JSON.stringify(find(next).defaultProps); setId(next); setPropsText(text); setFrame(0); load(next, text); }}
          style={{ ...button, padding: '6px 8px' }}
        >
          {compositions.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
        <input
          value={propsText}
          onChange={e => setPropsText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') load(id, propsText); }}
          spellCheck={false}
          style={{ ...button, flex: 1, fontFamily: 'ui-monospace, monospace', cursor: 'text' }}
        />
        <button style={button} onClick={() => load(id, propsText)}>Load</button>
        <span style={{ color: UI.muted, whiteSpace: 'nowrap' }}>
          {config ? `${config.width}x${config.height} · ${config.fps} fps · ${seconds(config.durationInFrames)}s` : 'loading...'}
          {audio.state === 'working' ? ' · mixing sound...' : audio.state === 'error' ? ' · sound failed (see console)' : ''}
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {error ? <ErrorText error={error} /> : config && resolved && (
          <div style={{ width: config.width * scale, height: config.height * scale, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ width: config.width, height: config.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
              <Boundary key={`${id}|${propsText}|${resolved.config.durationInFrames}`}>
                <Stage resolved={resolved} frame={frame} />
              </Boundary>
            </div>
          </div>
        )}
      </div>

      <div style={{ height: TRANSPORT_H, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderTop: `1px solid ${UI.line}` }}>
        <button style={{ ...button, width: 72 }} disabled={!config} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <input
          type="range" min={0} max={config ? config.durationInFrames - 1 : 0} value={frame}
          onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }}
          style={{ flex: 1, accentColor: UI.accent }}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums', color: UI.muted, whiteSpace: 'nowrap' }}>
          {seconds(frame)}s · frame {frame}{config ? ` / ${config.durationInFrames - 1}` : ''}
        </span>
      </div>
      {audio.url && <audio ref={audioRef} src={audio.url} preload="auto" />}
    </div>
  );
};

export function startPlayer(compositions: AnyComposition[], host: HTMLElement) {
  document.title = 'Studio';
  createRoot(host).render(<Player compositions={compositions} />);
}
