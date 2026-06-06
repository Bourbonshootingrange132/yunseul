import { describe, expect, it } from 'vitest';
import { redactSecrets, redactWithLiteralKey } from '../src/util/redact';

describe('redactSecrets', () => {
	it('redacts Authorization header values', () => {
		const out = redactSecrets('Authorization: Bearer xyz123');
		expect(out).toContain('Authorization: [REDACTED]');
		expect(out).not.toContain('xyz123');
	});

	it('redacts bare Bearer tokens outside header form', () => {
		const out = redactSecrets('Token used: Bearer aabbccddeeff');
		expect(out).toContain('Bearer [REDACTED]');
		expect(out).not.toContain('aabbccddeeff');
	});

	it('redacts x-api-key header form', () => {
		const out = redactSecrets('x-api-key: sk-foo-1234567890abcdef');
		expect(out).toContain('x-api-key: [REDACTED]');
		expect(out).not.toContain('sk-foo-1234567890abcdef');
	});

	it('redacts Cookie and Set-Cookie headers', () => {
		const a = redactSecrets('Cookie: session=abcdef');
		const b = redactSecrets('Set-Cookie: token=xyz; path=/');
		expect(a).toContain('Cookie: [REDACTED]');
		expect(b).toContain('Set-Cookie: [REDACTED]');
		expect(a).not.toContain('abcdef');
		expect(b).not.toContain('xyz');
	});

	it('redacts sk-ant-* Anthropic console keys', () => {
		const out = redactSecrets('error using sk-ant-api03-abcdef1234567890');
		expect(out).toContain('sk-ant-[REDACTED]');
		expect(out).not.toContain('sk-ant-api03-abcdef1234567890');
	});

	it('redacts OpenAI-style sk- keys (20+ char body)', () => {
		const out = redactSecrets('key: sk-aBcDeF1234567890aBcDeF12');
		expect(out).toContain('sk-[REDACTED]');
		expect(out).not.toContain('sk-aBcDeF1234567890aBcDeF12');
	});

	it('does NOT false-positive on short sk- prefixes', () => {
		// "sk-1234" is below the 20-char body threshold and may appear
		// in unrelated error messages.
		const out = redactSecrets('reference sk-1234');
		expect(out).toContain('sk-1234');
	});

	it('redacts three-part JWT (eyJ.eyJ.sig) tokens', () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const out = redactSecrets(`token=${jwt}`);
		expect(out).toContain('[JWT-REDACTED]');
		expect(out).not.toContain(jwt);
	});

	it('redacts custom-named apiKey= and api_key= forms', () => {
		const out1 = redactSecrets('apiKey=abc123XYZ_xyz');
		const out2 = redactSecrets('api_key="abc123XYZ_xyz"');
		expect(out1).toContain('api_key=[REDACTED]');
		expect(out2).toContain('api_key=[REDACTED]');
		expect(out1).not.toContain('abc123XYZ_xyz');
		expect(out2).not.toContain('abc123XYZ_xyz');
	});

	it('truncates inputs larger than 8KB before regex evaluation', () => {
		// Pathological-input defense: build a 16KB string containing a
		// secret near the start (which should still get redacted) and
		// verify the output is bounded. The newline after the
		// Authorization header is critical so the header regex doesn't
		// swallow the entire input (and the truncation marker with it).
		const head = 'Authorization: Bearer secret-token\n';
		const padding = 'x'.repeat(16 * 1024);
		const out = redactSecrets(`${head}${padding}`);
		expect(out.length).toBeLessThanOrEqual(8 * 1024 + 100);
		expect(out).toContain('Authorization: [REDACTED]');
		expect(out).toContain('[truncated for redaction]');
	});

	it('handles an empty string without throwing', () => {
		expect(redactSecrets('')).toBe('');
	});

	it('passes through innocuous text untouched', () => {
		const msg = 'Connection refused: ECONNREFUSED 127.0.0.1:1234';
		expect(redactSecrets(msg)).toBe(msg);
	});
});

describe('redactWithLiteralKey', () => {
	it('redacts a literal user-supplied key on top of the generic patterns', () => {
		const out = redactWithLiteralKey('my key is hunter2-secret-abc and also Bearer xyz', 'hunter2-secret-abc');
		expect(out).toContain('[REDACTED]');
		expect(out).not.toContain('hunter2-secret-abc');
		expect(out).toContain('Bearer [REDACTED]');
	});

	it('escapes regex metacharacters in the literal key', () => {
		const key = 'a.b*c+d?';
		const out = redactWithLiteralKey('key=a.b*c+d?', key);
		expect(out).not.toContain('a.b*c+d?');
		expect(out).toContain('[REDACTED]');
	});

	it('with an empty key, behaves the same as redactSecrets', () => {
		const sample = 'Authorization: Bearer xyz';
		expect(redactWithLiteralKey(sample, '')).toBe(redactSecrets(sample));
	});

	it('caps literal-key length used in the dynamic regex (pathological input defense)', () => {
		// A 1MB literal key shouldn't pin the renderer thread. The
		// function bounds dynamic-regex input length to 256 chars.
		const monsterKey = 'k'.repeat(1024 * 1024);
		// Should not throw / hang. Just assert it completes quickly enough
		// that vitest's default 5s timeout doesn't trip.
		const sample = 'sample body';
		const out = redactWithLiteralKey(sample, monsterKey);
		expect(typeof out).toBe('string');
	});
});
