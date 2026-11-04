// SAM's masks for a clip, from the server's cache (never a paid call), decoded in the browser with @meta-sam/parser.
import {parseVideoStream, recordsOfKind, frameIndexOf, decodeMaskToRaster} from '/vendor/sam-parser/index.js';

// {objectId: Map(frame -> {left, top, right, bottom, w, h, raster})}; `ids` are the part of an object key after the colon.
export async function decodeMasks(text, ids) {
  async function* ev() {
    const lane = {item_id: 'sam', output_index: 0, content_index: 0};
    yield {type: 'response.output_text.delta', delta: text, ...lane};
    yield {type: 'response.output_text.done', text, ...lane};
    yield {type: 'response.completed'};
  }
  const res = await parseVideoStream(ev()).finalResult, out = Object.fromEntries(ids.map(id => [id, new Map()]));
  for (const r of recordsOfKind(res.records, 'mask')) if (out[r.objectId])
    out[r.objectId].set(frameIndexOf(r), {...r.bounds, w: r.mask.width, h: r.mask.height, raster: decodeMaskToRaster(r.mask)});
  return out;
}

// Masks by object key ("orange-ball:0") for one prompt of a clip; null when the server has nothing cached for it.
// With a prompt the server needs no saved run, so this works while a live run is still going.
export async function fetchMasks(clipId, prompt, keys) {
  const r = await fetch(`/api/masks?clip=${encodeURIComponent(clipId)}&prompt=${encodeURIComponent(prompt)}`).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json(), ids = keys.map(k => k.split(':').pop()), by = await decodeMasks(j.text, ids);
  return Object.fromEntries(keys.map((k, i) => [k, by[ids[i]]]));
}
