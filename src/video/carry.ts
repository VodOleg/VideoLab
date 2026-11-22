// 3d scenes carried on from an earlier beat's (`with`): the stage as that beat left it, plus or changed by the new
// beat's objects. Done once when the script loads, so everything after sees whole scenes.
import type { Scene, Script, Thing } from '../types.ts';

type Scene3D = Extract<Scene, { type: '3d' }>;

/** An object as it ended its scene: its moves done (where it went, its turn and scale), and only its last slide. */
function settle(o: Thing): Thing {
  let { at, turn, scale } = o;
  for (const m of o.moves ?? []) {
    if (m.to) at = m.to;
    if (m.turn !== undefined) turn = m.turn;
    if (m.scale !== undefined) scale = m.scale;
  }
  const last = o.slides?.at(-1);
  return { ...o, at, turn, scale, moves: undefined, slides: last ? [{ ...last, at: undefined, wait: undefined }] : undefined };
}

/**
 * 3d scenes carried on `with` an earlier beat's: its objects as they ended (moves done) plus or changed by this
 * scene's, and its light, background, floor and spotlight (as its changes left it), unless this scene sets them.
 */
export function carryScenes(script: Script): Script {
  const done = new Map<string, Scene3D>();
  const beats = script.beats.map(beat => {
    const s = beat.scene;
    if (s?.type !== '3d') return beat;
    let scene: Scene3D = s;
    if (s.with) {
      const from = done.get(s.with);
      if (!from) throw new Error(`[${beat.id}] "with": "${s.with}" isn't an earlier beat with a 3d scene`);
      const own = new Map(s.objects.map(o => [o.id, o]));
      const kept = from.objects.map(settle).map(o => (own.has(o.id) ? { ...o, ...own.get(o.id) } : o));
      const all = [...kept, ...s.objects.filter(o => !kept.some(k => k.id === o.id))];
      // Taking an object away takes its parts with it.
      const gone = new Set(all.filter(o => o.gone).map(o => o.id));
      for (let more = true; more;) {
        more = false;
        for (const o of all) if (o.parent && gone.has(o.parent) && !gone.has(o.id)) { gone.add(o.id); more = true; }
      }
      const objects = all.filter(o => !gone.has(o.id));
      const spot = from.spotlight && (() => {
        let { on, angle, dim } = from.spotlight;
        for (const c of from.spotlight.changes ?? []) {
          on = c.on ?? on;
          angle = c.angle ?? angle;
          dim = c.dim ?? dim;
        }
        return { on, angle, dim };
      })();
      scene = { light: from.light, background: from.background, floor: from.floor, spotlight: spot, ...s, objects };
    }
    done.set(beat.id, scene);
    return { ...beat, scene };
  });
  return { ...script, beats };
}
