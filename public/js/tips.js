// One floating tooltip for every element carrying data-tip. It opens on hover and on keyboard focus, and is linked to
// its target with aria-describedby while shown, so a screen reader hears it too. `title` is avoided on purpose: it never
// appears on focus. Elements added later (chat ticks, report rows) need nothing but the attribute.
const tip = document.createElement('div');
tip.id = 'tip'; tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
document.body.append(tip);
let current = null, timer = 0;

function show(el) {
  const text = el.dataset.tip;
  if (!text) return;
  current = el; tip.textContent = text; tip.hidden = false;
  el.setAttribute('aria-describedby', 'tip');
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), pad = 8;
  const side = el.dataset.tipSide || 'top';
  let x = side === 'right' ? r.right + 10 : r.left + r.width / 2 - t.width / 2;
  let y = side === 'right' ? r.top + r.height / 2 - t.height / 2 : r.top - t.height - 8;
  if (side !== 'right' && y < pad) y = r.bottom + 8;
  x = Math.max(pad, Math.min(innerWidth - t.width - pad, x)); y = Math.max(pad, Math.min(innerHeight - t.height - pad, y));
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hide() {
  clearTimeout(timer);
  current?.removeAttribute('aria-describedby'); current = null; tip.hidden = true;
}
const target = e => e.target.closest?.('[data-tip]');
document.addEventListener('pointerover', e => { const el = target(e); if (el && el !== current) { clearTimeout(timer); timer = setTimeout(() => show(el), 250); } });
document.addEventListener('pointerout', e => { if (target(e) && !target(e)?.contains(e.relatedTarget)) hide(); });
document.addEventListener('focusin', e => { const el = target(e); if (el && e.target.matches(':focus-visible')) show(el); });
document.addEventListener('focusout', hide);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
document.addEventListener('pointerdown', hide);
// A control whose tip text changes while it is shown (the mic) refreshes it.
export const refreshTip = el => { if (current === el) show(el); };
