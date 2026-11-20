/**
 * Security-gap tests for storage path traversal and Content-Disposition hardening
 *
 *   REQ-SEC-010 AC1  — decodeURIComponent applied before traversal check
 *   REQ-SEC-010 AC2  — double-encoded (%252E%252E) input is neutralized to an inert literal (single decode, used verbatim)
 *   REQ-SEC-010 AC3  — malformed URI encoding throws ValidationError
 *   REQ-SEC-010 AC4  — decoded key returned to callers
 *   REQ-SEC-013 AC2  — special characters stripped from Content-Disposition filename
 *   REQ-SEC-013 AC3  — Content-Disposition uses "attachment" disposition type
 */
import { describe, it, expect } from 'vitest';
import { validateKey } from '../../routes/storage/validation';
import { getR2Url } from '../../lib/r2-client';
import { ValidationError } from '../../lib/error-types';
import { buildContentDisposition } from '../../routes/storage/download';

// ── REQ-SEC-010: Path traversal prevention ────────────────────────────────────

describe('REQ-SEC-010 AC1/AC2: URI-decoded traversal attacks are caught', () => {
  it('REQ-SEC-010 AC1: %2E%2E decoded to ".." is rejected', () => {
    // Single-encoded: %2E%2E decodes to ".."
    expect(() => validateKey('foo/%2E%2E/bar')).toThrow('path traversal not allowed');
  });

  it('REQ-SEC-010 AC1: %2e%2e%2f (lowercase) decoded to "../" is rejected', () => {
    expect(() => validateKey('foo/%2e%2e%2fbar')).toThrow('path traversal not allowed');
  });

  it('REQ-SEC-010 AC2: double-encoded %252E%252E decodes once to an inert literal, used verbatim and never re-decoded', () => {
    const result = validateKey('tenant/%252E%252E/Gr%C3%BC%C3%9Fe%20%23%3F.txt');
    expect(result).toBe('tenant/%2E%2E/Grüße #?.txt');
    const request = new Request(getR2Url('https://r2.test', 'user-bucket', result));
    const url = new URL(request.url);
    expect(url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')).toBe(result);
    expect(url.pathname.split('/')[1]).toBe('user-bucket');
    expect(url.search).toBe(''); expect(url.hash).toBe('');
  });

  it('REQ-SEC-010 AC2: direct ".." literal is always rejected regardless of encoding', () => {
    expect(() => validateKey('../etc/passwd')).toThrow('path traversal not allowed');
    expect(() => validateKey('foo/../../etc')).toThrow('path traversal not allowed');
  });

  it('REQ-SEC-010 AC2: mixed case encoded traversal %2E%2e is rejected', () => {
    expect(() => validateKey('prefix/%2E%2e/suffix')).toThrow('path traversal not allowed');
  });
});

describe('REQ-SEC-010 AC3: malformed URI encoding throws ValidationError', () => {
  it('REQ-SEC-010 AC3: lone percent sign is malformed URI and throws ValidationError', () => {
    expect(() => validateKey('foo/%ZZ')).toThrow(ValidationError);
  });

  it('REQ-SEC-010 AC3: incomplete percent encoding throws ValidationError', () => {
    expect(() => validateKey('foo/%')).toThrow(ValidationError);
  });

  it('REQ-SEC-010 AC3: truncated percent sequence throws ValidationError', () => {
    expect(() => validateKey('%2')).toThrow(ValidationError);
  });
});

describe('REQ-SEC-010 AC4: validateKey returns decoded key for callers', () => {
  it('REQ-SEC-010 AC4: URL-encoded spaces are returned decoded', () => {
    const result = validateKey('my%20file.txt');
    expect(result).toBe('my file.txt');
  });

  it('REQ-SEC-010 AC4: encoded slashes in path are returned decoded', () => {
    const result = validateKey('folder%2Fsubfolder%2Ffile.txt');
    expect(result).toBe('folder/subfolder/file.txt');
  });

  it('REQ-SEC-010 AC4: plain keys pass through unchanged', () => {
    const result = validateKey('workspace/project/main.ts');
    expect(result).toBe('workspace/project/main.ts');
  });
});

// ── REQ-SEC-013: Content-Disposition hardening ────────────────────────────────
//
// Behavioral tests for buildContentDisposition() — imported directly from the
// download route module. Inputs are crafted attack vectors (CRLF injection,
// quote-break, encoded smuggling); outputs are asserted against the exact
// header value the browser will receive.

describe('REQ-SEC-013: Content-Disposition is built safely', () => {
  it('REQ-SEC-013 AC3: emits attachment disposition type', () => {
    const header = buildContentDisposition('report.pdf');
    expect(header.startsWith('attachment;')).toBe(true);
  });

  it('REQ-SEC-013 AC3: preserves both filename and filename* parameters', () => {
    const header = buildContentDisposition('report.pdf');
    expect(header).toContain('filename="report.pdf"');
    expect(header).toContain("filename*=UTF-8''report.pdf");
  });

  it('REQ-SEC-013 AC2: replaces CR with underscore (prevents header injection)', () => {
    const header = buildContentDisposition('evil\rname.txt');
    expect(header).not.toContain('\r');
    expect(header).toContain('filename="evil_name.txt"');
  });

  it('REQ-SEC-013 AC2: replaces LF with underscore (prevents header injection)', () => {
    const header = buildContentDisposition('evil\nname.txt');
    expect(header).not.toContain('\n');
    expect(header).toContain('filename="evil_name.txt"');
  });

  it('REQ-SEC-013 AC2: replaces CRLF in both ASCII fallback and RFC 5987 filename*', () => {
    const header = buildContentDisposition('a\r\nb.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="a__b.txt"');
    expect(header).toContain("filename*=UTF-8''a__b.txt");
  });

  it('REQ-SEC-013 AC2: replaces embedded double quotes (prevents ASCII filename break-out)', () => {
    const header = buildContentDisposition('evil"; filename="oops.txt');
    const asciiPart = header.match(/filename="([^"]*)"/);
    expect(asciiPart).not.toBeNull();
    expect(asciiPart![1]).not.toContain('"');
    expect(asciiPart![1]).toBe('evil_; filename=_oops.txt');
  });

  it('REQ-SEC-013 AC2: replaces backslashes (prevents ASCII filename quoted-string escape)', () => {
    const header = buildContentDisposition('evil\\.txt');
    const asciiPart = header.match(/filename="([^"]*)"/);
    expect(asciiPart).not.toBeNull();
    expect(asciiPart![1]).not.toContain('\\');
    expect(asciiPart![1]).toBe('evil_.txt');
  });

  it('REQ-SEC-013 AC2: keeps a literal single quote out of filename* by percent-encoding it', () => {
    const header = buildContentDisposition("o'clock.txt");
    const rfc5987 = header.split("filename*=UTF-8''")[1];
    expect(rfc5987).toBeDefined();
    expect(rfc5987).not.toContain("'");
    expect(rfc5987).toContain('%27');
  });

  it('REQ-SEC-013 AC2: percent-encodes Unicode characters in filename*', () => {
    const header = buildContentDisposition('café.txt');
    expect(header).toContain('filename="café.txt"');
    expect(header).toMatch(/filename\*=UTF-8''caf%C3%A9\.txt/);
  });

  it('REQ-SEC-013 AC3: removes HTTP controls without losing Unicode identity', () => {
    const filename = '東京😀\u0000\u0009\u001f\u007f\u0085.txt';
    const header = buildContentDisposition(filename);
    expect(header).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe('東京😀_____.txt');
    expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow();
  });

  it('REQ-SEC-013 AC2: leaves a plain ASCII filename completely unchanged', () => {
    const header = buildContentDisposition('plain.txt');
    expect(header).toBe(`attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`);
  });
});
