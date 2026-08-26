'use strict';

const test = require('node:test');
const assert = require('node:assert');

const schema = require('../src/common/schema.js');

test('a fence that does not parse is reported as carrying no ordering claim', () => {
  const report = schema.readSnapshot('{ "betterGhsa": "1.0", ');
  assert.strictEqual(report.parsed, null);
  assert.strictEqual(report.seq, null);
  assert.strictEqual(report.ordered, false);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['the fenced block does not parse as JSON']);
});

test('a snapshot with no seq carries no ordering claim', () => {
  const report = schema.readSnapshot('{"betterGhsa":"1.0","by":"samuelkarp"}');
  assert.strictEqual(report.ordered, false);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['seq is absent or is not a number']);

  const stringSeq = schema.readSnapshot('{"betterGhsa":"1.0","seq":"4"}');
  assert.strictEqual(stringSeq.ordered, false);
  assert.deepStrictEqual(stringSeq.problems, ['seq is absent or is not a number']);
});

test('a readable seq survives a payload that fails validation', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":4,"by":"samuelkarp","owners":"samuelkarp"}'
  );
  assert.strictEqual(report.seq, 4);
  assert.strictEqual(report.by, 'samuelkarp');
  assert.strictEqual(report.ordered, true);
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['owners is not an array of strings']);
});

test('an unrecognized value in a known enum field is named, not rejected', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":1,"triage":"marinating","closure":{"reason":"lost the fork"}}'
  );
  assert.strictEqual(report.valid, true);
  assert.deepStrictEqual(report.problems, []);
  assert.deepStrictEqual(report.unrecognized, ['triage', 'closure.reason']);

  const payload = /** @type {Record<string, unknown>} */ (report.parsed);
  assert.strictEqual(payload['triage'], 'marinating');
  const closure = /** @type {Record<string, unknown>} */ (payload['closure']);
  assert.strictEqual(closure['reason'], 'lost the fork');
});

test('an unknown field passes validation and stays in the payload', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":1,"cutleryPolicy":{"sharpened":true}}'
  );
  assert.strictEqual(report.valid, true);
  assert.deepStrictEqual(report.problems, []);
  assert.deepStrictEqual(report.unrecognized, []);

  const payload = /** @type {Record<string, unknown>} */ (report.parsed);
  const policy = /** @type {Record<string, unknown>} */ (payload['cutleryPolicy']);
  assert.strictEqual(policy['sharpened'], true);
});

test('a schema major this reader does not know is reported as unsupported', () => {
  const report = schema.readSnapshot('{"betterGhsa":"2.0","seq":9}');
  assert.strictEqual(report.major, 2);
  assert.strictEqual(report.schemaSupported, false);
  assert.strictEqual(report.valid, true);

  const known = schema.readSnapshot('{"betterGhsa":"1.4","seq":9}');
  assert.strictEqual(known.major, 1);
  assert.strictEqual(known.schemaSupported, true);
});

test('a confirmation record with a non-string fingerprint fails validation', () => {
  const report = schema.readSnapshot(
    '{"betterGhsa":"1.0","seq":1,"confirmed":{"title":{"by":"dmcgowan","at":"x","fp":12}}}'
  );
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.problems, ['confirmed.title.fp is not a string']);
});

test('normalization settles line endings, trailing space, outer blanks, and NFC', () => {
  /** @type {[string, string, string][]} */
  const cases = [
    ['CRLF becomes LF', 'one\r\ntwo\r\n\r\nthree', 'one\ntwo\n\nthree'],
    ['trailing whitespace goes from every line', 'one   \ntwo\t\nthree ', 'one\ntwo\nthree'],
    ['leading whitespace stays', '  indented  ', '  indented'],
    ['leading and trailing blank lines are trimmed', '\n \n\nbody\n\n  \n', 'body'],
    ['interior blank lines are kept', 'one\n\n\ntwo', 'one\n\n\ntwo'],
    ['a value of nothing but blank lines normalizes to empty', '\n\n \n', ''],
    ['a decomposed accent is composed', 'café', 'café'],
  ];
  for (const [name, raw, normalized] of cases) {
    assert.strictEqual(schema.normalize(raw), normalized, name);
  }
  // The composed form is one code point per letter, which is what makes the
  // row above a Unicode normalization and not an equality of two spellings.
  assert.ok('café'.length === 4, 'the composed expectation is not NFC');
});

test('a fingerprint is twelve hex characters of the SHA-256 of the normalized value', async () => {
  const empty = await schema.fingerprint('');
  /** @type {[string, string | null | undefined, string][]} */
  const cases = [
    ['the value as written', 'hello world', 'b94d27b9934d'],
    ['the same value needing normalization', '\r\nhello world  \r\n\r\n', 'b94d27b9934d'],
    ['a decomposed accent', 'café', '850f7dc43910'],
    ['the same accent composed', 'café', '850f7dc43910'],
    ['a value that is absent', null, empty],
    ['a value that was never set', undefined, empty],
  ];
  for (const [name, raw, fp] of cases) {
    assert.strictEqual(await schema.fingerprint(raw), fp, name);
  }
});

test('the scoring source labels each half and writes an absent half empty', () => {
  assert.strictEqual(
    schema.scoringSource('cvss_v3', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'),
    'severity=cvss_v3\ncvss=CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'
  );
  assert.strictEqual(schema.scoringSource('moderate', null), 'severity=moderate\ncvss=');
  assert.strictEqual(schema.scoringSource(null, null), 'severity=\ncvss=');
});

test('the scoring fingerprint covers severity and vector together', async () => {
  const severityOnly = await schema.scoringFingerprint('moderate', null);
  assert.strictEqual(severityOnly, '1ccabcfdf244');
  assert.strictEqual(
    await schema.scoringFingerprint('cvss_v3', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'),
    '404294f8123c'
  );
  assert.strictEqual(await schema.scoringFingerprint(null, null), '900ae52b2023');

  const changed = await schema.scoringFingerprint('high', null);
  assert.ok(changed !== severityOnly, 'a changed severity kept its fingerprint');
});
