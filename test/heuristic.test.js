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

const located = (items) => items.map((i) => [i.name, i.quantity, i.location]);

test('location at the end of an item applies to that item', () => {
  assert.deepEqual(located(parseHeuristic('hammer in the red toolbox, two drills, pliers under the workbench, tape next to the fridge')), [
    ['Hammer', 1, 'red toolbox'],
    ['Drills', 2, ''],
    ['Pliers', 1, 'under the workbench'],
    ['Tape', 1, 'next to the fridge'],
  ]);
});

test('location said on its own sticks until the next one', () => {
  const items = parseHeuristic('on the top shelf\ndrill\nsander\nnow in the bottom drawer\ntape\nglue in bin 3\nscissors\nmoving to the garage, ladder');
  assert.deepEqual(located(items), [
    ['Drill', 1, 'top shelf'],
    ['Sander', 1, 'top shelf'],
    ['Tape', 1, 'bottom drawer'],
    ['Glue', 1, 'bin 3'],
    ['Scissors', 1, 'bottom drawer'],
    ['Ladder', 1, 'garage'],
  ]);
});

test('location and items run together without a pause', () => {
  assert.deepEqual(located(parseHeuristic('in drawer 2 three hdmi cables')), [['HDMI cables', 3, 'drawer 2']]);
  assert.deepEqual(located(parseHeuristic('on shelf B hammer')), [['Hammer', 1, 'shelf B']]);
});

test('things that are not locations', () => {
  assert.deepEqual(located(parseHeuristic('usb c to hdmi adapter, plug in adapter, cable in black, box of screws, storage box, bench vise')), [
    ['USB-C to HDMI adapter', 1, ''],
    ['Plug in adapter', 1, ''],
    ['Cable in black', 1, ''],
    ['Box of screws', 1, ''],
    ['Storage box', 1, ''],
    ['Bench vise', 1, ''],
  ]);
});

test('same item in different locations stays separate', () => {
  assert.deepEqual(located(parseHeuristic('hammer in the toolbox, hammer on the bench, hammer in the toolbox')), [
    ['Hammer', 2, 'toolbox'],
    ['Hammer', 1, 'bench'],
  ]);
});
