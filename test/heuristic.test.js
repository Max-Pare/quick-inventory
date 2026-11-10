import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeuristic } from '../server/parse/heuristic.js';
import { normalize, displayName, similarity } from '../server/text.js';

const brief = (items) => items.map((i) => [i.name, i.quantity, i.details]);

test('the example utterance', () => {
  const items = parseHeuristic('usb C cable, uuuuh usb C cable, raspberry pi 4b, duct tape, black, lightning phone charger');
  assert.deepEqual(brief(items), [
    ['USB-C cable', 2, []],
    ['Raspberry pi 4B', 1, []],
    ['Duct tape', 1, ['black']],
    ['Lightning phone charger', 1, []],
  ]);
  assert.equal(items[0].confidence, 'low');
  assert.match(items[0].notes[0], /hesitation/);
  assert.equal(items[1].confidence, 'high');
});

test('pauses arrive as line breaks, without punctuation', () => {
  const items = parseHeuristic('hdmi cable\num\nthree ethernet cables\nwhite and grey\nscrewdriver set');
  assert.deepEqual(brief(items), [
    ['HDMI cable', 1, []],
    ['Ethernet cables', 3, ['white and grey']],
    ['Screwdriver set', 1, []],
  ]);
});

test('quantities', () => {
  assert.deepEqual(brief(parseHeuristic('two monitors, 4x AA batteries, power strip x3, a hammer, wrench times two')), [
    ['Monitors', 2, []],
    ['AA batteries', 4, []],
    ['Power strip', 3, []],
    ['Hammer', 1, []],
    ['Wrench', 2, []],
  ]);
});

test('measurements and model numbers are not quantities', () => {
  assert.deepEqual(brief(parseHeuristic('3 meter hdmi cable, raspberry pi 4, 2.5 inch ssd')), [
    ['3 meter HDMI cable', 1, []],
    ['Raspberry pi 4', 1, []],
    ['2.5 inch SSD', 1, []],
  ]);
});

test('"and" separates items but not attributes', () => {
  assert.deepEqual(brief(parseHeuristic('keyboard and mouse')), [['Keyboard', 1, []], ['Mouse', 1, []]]);
});

test('plain repetition sums and is flagged', () => {
  const [it] = parseHeuristic('stapler, stapler, stapler');
  assert.equal(it.quantity, 3);
  assert.match(it.notes[0], /Said 3 times/);
});

test('empty and filler-only input', () => {
  assert.deepEqual(parseHeuristic(''), []);
  assert.deepEqual(parseHeuristic('uh, um, hmm'), []);
});

test('text helpers', () => {
  assert.equal(normalize('USB-C Cables'), normalize('usb c cable'));
  assert.equal(normalize('Batteries'), 'battery');
  assert.equal(displayName('usb c to hdmi adapter'), 'USB-C to HDMI adapter');
  assert.ok(similarity('lightning phone charger', 'lightning charger') > 0.6);
  assert.ok(similarity('duct tape', 'raspberry pi') < 0.3);
});
