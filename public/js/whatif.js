// "What if…" phrasings, so that a fork reads clearly to someone who has forgotten the first question: one function
// for the fork menu's cards and for the chat's user bubble (app.js), and one for a short chat title from a question.
const WORLD = [['Moon', 1.62], ['Mars', 3.71], ['Jupiter', 24.79], ['Earth', 9.81]];
const worldOf = g => WORLD.find(([, v]) => Math.abs(v - g) < 0.01)?.[0];
const place = w => w === 'Moon' ? 'the Moon' : w;
const tidy = s => String(s || '').trim().replace(/[.!?…]+$/, '');

/** The full question a fork asks: "What if this happened on the Moon?", "What if the car were doing 30 km/h?" */
export function whatIf(it) {
  if (it.real) return 'As filmed';
  const o = it.overrides || {}, v = it.vehicle, g = it.g ?? o.g, e = it.e ?? o.e, none = (it.drag ?? o.drag) === 'none';
  const kmh = v?.speed_kmh ?? o.speed_kmh;
  if (v || o.brake || kmh != null) return kmh != null ? `What if the car were doing ${Math.round(kmh)} km/h?` : 'What if someone stepped out 20 m ahead?';
  const w = g != null && worldOf(g);
  if (it.agent) {
    // The agent's own forks keep their label (it may say more than the numbers do, as "Steeper ramp" does); it is only
    // turned into a plain world or no-air question when the label says exactly that.
    const label = tidy(it.label), named = w && new RegExp(w + '|lunar|martian|jovian', 'i').test(label);
    if (named) return `What if this happened on ${place(w)}${none ? ', with no air' : ''}?`;
    if (none && g == null && e == null && /\b(air|vacuum)\b/i.test(label)) return 'What if there were no air?';
    return `What if: ${label}`;
  }
  const parts = [];
  if (g != null) parts.push(w ? `this happened on ${place(w)}` : `gravity were ${+(+g).toFixed(2)} m/s²`);
  if (none) parts.push('there were no air');
  if (e != null && e >= 0) parts.push(e >= 0.9 ? 'the ball were much bouncier' : e <= 0.05 ? 'it landed without a bounce' : `it bounced with restitution ${e}`);
  return parts.length ? `What if ${parts.join(' and ')}?` : `What if: ${tidy(it.label)}`;
}

/** A short chat title for a question: as it is when short, else its first clause trimmed at a word. */
export function shortTitle(q, max = 40) {
  q = String(q || '').replace(/\s+/g, ' ').trim();
  if (q.length <= 48) return q;
  // A leading sentence that is only context ("John Young jumps and salutes.") is skipped for the question that follows.
  const sentences = q.split(/(?<=[.!?])\s+/), ask = sentences.find(s => /\?$/.test(s)) || sentences[0];
  let t = ask.split(/[,;:—–]|\s-\s/)[0].trim();
  if (t.length < 14) t = ask.trim();
  if (t.length <= max) return t.replace(/[.,;:]+$/, '');
  const cut = t.slice(0, max - 1), sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '') + '…';
}
