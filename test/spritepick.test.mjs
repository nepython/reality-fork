// Which frame the object's sprite is cut from: one where it is whole, not cut by the frame edge and not hidden behind something.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSpriteFrame} from '../lib/spritepick.mjs';

const W = 400, H = 200;
// A rectangle mask of the given box; `hole` removes a vertical slice (a pole in front of the object).
const box = (left, top, right, bottom, hole = null) => ({left, top, right, bottom, at: (x, y) => !(hole && x + left >= hole[0] && x + left < hole[1]) ? 1 : 0});
const scene = frames => ({pts: frames.map((f, i) => [i, f.cx ?? 100, 100]), masks: new Map(frames.map((f, i) => [i, f.m]))});

test('sprite frame: not the one cut by the picture edge', () => {
  const {pts, masks} = scene([{m: box(0, 60, 80, 140)}, {m: box(100, 60, 180, 140)}, {m: box(320, 60, 400, 140)}]);
  assert.equal(chooseSpriteFrame(pts, masks, {width: W, height: H}), 1);
});

test('sprite frame: not one where something hides part of the object, nor a split mask', () => {
  const {pts, masks} = scene([
    {m: box(100, 60, 200, 140, [140, 170])},        // a pole in front: in two pieces
    {m: box(100, 60, 160, 140)},                    // narrower: the pole covers its front
    {m: box(100, 60, 200, 140)}, {m: box(100, 60, 200, 140)}, {m: box(100, 60, 200, 140)},
  ]);
  assert.ok(chooseSpriteFrame(pts, masks, {width: W, height: H}) >= 2);
});

test('sprite frame: falls back when every frame is cut, and says so when there is no mask', () => {
  const {pts, masks} = scene([{m: box(0, 60, 80, 140)}, {m: box(0, 60, 90, 140)}]);
  assert.ok(chooseSpriteFrame(pts, masks, {width: W, height: H}) >= 0);
  assert.equal(chooseSpriteFrame(pts, new Map(), {width: W, height: H}), -1);
});
