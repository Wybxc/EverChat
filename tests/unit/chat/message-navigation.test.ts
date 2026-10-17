import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerTargets } from '../../../src/features/chat/message-navigation';

const anchors = [
  { id: 'first', top: 100 },
  { id: 'second', top: 600 },
  { id: 'third', top: 700 },
];
test('long answers and question gaps return to the nearest earlier answer start', () => {
  assert.deepEqual(answerTargets(anchors, 350), { previous: 'first', next: 'second' });
  assert.deepEqual(answerTargets(anchors, 650), { previous: 'second', next: 'third' });
  assert.deepEqual(answerTargets(anchors, 600), { previous: 'first', next: 'third' });
});
test('empty, single-answer and end positions never wrap', () => {
  assert.deepEqual(answerTargets([], 0), { previous: undefined, next: undefined });
  assert.deepEqual(answerTargets(anchors, 0), { previous: undefined, next: 'first' });
  assert.deepEqual(answerTargets(anchors, 900), { previous: 'third', next: undefined });
  assert.deepEqual(answerTargets(anchors.slice(0, 1), 100), {
    previous: undefined,
    next: undefined,
  });
});
test('subpixel alignment cannot select the same answer again', () => {
  for (const position of [598.5, 600, 601.5])
    assert.deepEqual(answerTargets(anchors, position), { previous: 'first', next: 'third' });
});
test('a landed answer keeps logical order when multiple short answers clamp at the bottom', () => {
  assert.deepEqual(answerTargets(anchors, 350, 'second'), { previous: 'first', next: 'third' });
  assert.deepEqual(answerTargets(anchors, 350, 'third'), { previous: 'second', next: undefined });
});
test('a deleted or hidden landed ID falls back to the current path geometry', () => {
  assert.deepEqual(answerTargets(anchors, 350, 'unavailable'), {
    previous: 'first',
    next: 'second',
  });
});
