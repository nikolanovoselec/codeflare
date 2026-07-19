import { describe, it, expect } from 'vitest';
import {
  createFrameAssembler,
  FRAME_STALL_TIMEOUT_MS,
  FRAME_MAX_CHARS,
} from '../../lib/terminal-frames';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

describe('terminal-frames (REQ-TERM-021)', () => {
  it('REQ-TERM-021 AC2: ordinary output passes through unchanged, in order', () => {
    const assembler = createFrameAssembler();
    expect(assembler.ingest('hello world\r\n', 0)).toEqual(['hello world\r\n']);
    expect(assembler.ingest('\x1b[31mred\x1b[0m', 1)).toEqual(['\x1b[31mred\x1b[0m']);
    expect(assembler.hasPending()).toBe(false);
  });

  it('REQ-TERM-021 AC1: a complete frame in one chunk is one unit, byte-identical', () => {
    const assembler = createFrameAssembler();
    const frame = `${BSU}\x1b[2J\x1b[H\x1b[3Jreplay${ESU}`;
    expect(assembler.ingest(frame, 0)).toEqual([frame]);
    expect(assembler.hasPending()).toBe(false);
  });

  it('REQ-TERM-021 AC1: a frame split across chunks emits nothing until the end marker, then exactly one byte-identical unit', () => {
    const assembler = createFrameAssembler();
    const middle = 'x'.repeat(30_000);
    expect(assembler.ingest(`${BSU}\x1b[2J\x1b[H\x1b[3J`, 0)).toEqual([]);
    expect(assembler.hasPending()).toBe(true);
    expect(assembler.ingest(middle, 10)).toEqual([]);
    expect(assembler.ingest(middle, 20)).toEqual([]);
    const units = assembler.ingest(`tail${ESU}`, 30);
    expect(units).toEqual([`${BSU}\x1b[2J\x1b[H\x1b[3J${middle}${middle}tail${ESU}`]);
    expect(assembler.hasPending()).toBe(false);
  });

  it('REQ-TERM-021 AC1: markers split across chunk boundaries are recognized at every split offset', () => {
    for (let split = 1; split < BSU.length; split++) {
      const assembler = createFrameAssembler();
      const first = assembler.ingest(`pre${BSU.slice(0, split)}`, 0);
      // The marker fragment is withheld; only the ordinary prefix may emit.
      expect(first.join('')).toBe('pre');
      const second = assembler.ingest(`${BSU.slice(split)}body${ESU.slice(0, split)}`, 1);
      expect(second).toEqual([]);
      const third = assembler.ingest(ESU.slice(split), 2);
      expect(third).toEqual([`${BSU}body${ESU}`]);
      expect(assembler.hasPending()).toBe(false);
    }
  });

  it('REQ-TERM-021 AC1: prefix, frame, and suffix in one chunk stay ordered and the frame stays whole', () => {
    const assembler = createFrameAssembler();
    const units = assembler.ingest(`before${BSU}frame${ESU}after`, 0);
    expect(units).toEqual(['before', `${BSU}frame${ESU}`, 'after']);
  });

  it('REQ-TERM-021 AC1: a redundant begin marker does not extend the frame — the first end marker closes it (set/reset mode semantics)', () => {
    // DEC 2026 is a mode, not a nesting scope: xterm ignores a redundant
    // begin and stops synchronizing at the FIRST end marker, so holding past
    // it would defer bytes xterm no longer treats as synchronized.
    const assembler = createFrameAssembler();
    expect(assembler.ingest(`${BSU}a${BSU}b${ESU}`, 0)).toEqual([`${BSU}a${BSU}b${ESU}`]);
    expect(assembler.ingest(`c${ESU}`, 1)).toEqual([`c${ESU}`]);
    expect(assembler.hasPending()).toBe(false);
  });

  it('REQ-TERM-021 AC3: a stalled frame fails open after the stall timeout, not before', () => {
    const assembler = createFrameAssembler();
    expect(assembler.ingest(`${BSU}partial`, 1_000)).toEqual([]);
    expect(assembler.reap(1_000 + FRAME_STALL_TIMEOUT_MS - 1)).toEqual([]);
    expect(assembler.hasPending()).toBe(true);
    expect(assembler.reap(1_000 + FRAME_STALL_TIMEOUT_MS)).toEqual([`${BSU}partial`]);
    expect(assembler.hasPending()).toBe(false);
  });

  it('REQ-TERM-021 AC3: a frame exceeding the size ceiling fails open immediately', () => {
    const assembler = createFrameAssembler();
    const units = assembler.ingest(BSU + 'x'.repeat(FRAME_MAX_CHARS), 0);
    expect(units).toHaveLength(1);
    expect(units[0].startsWith(BSU)).toBe(true);
    expect(units[0].length).toBe(BSU.length + FRAME_MAX_CHARS);
    expect(assembler.hasPending()).toBe(false);
  });

  it('releases an idle marker-prefix carry through the reaper', () => {
    const assembler = createFrameAssembler();
    expect(assembler.ingest('tail\x1b[?20', 0)).toEqual(['tail']);
    expect(assembler.hasPending()).toBe(true);
    expect(assembler.reap(FRAME_STALL_TIMEOUT_MS)).toEqual(['\x1b[?20']);
    expect(assembler.hasPending()).toBe(false);
  });

  it('a marker-prefix carry completed by the next chunk still frames correctly', () => {
    const assembler = createFrameAssembler();
    expect(assembler.ingest('a\x1b[?2026', 0)).toEqual(['a']);
    expect(assembler.ingest(`hbody${ESU}b`, 1)).toEqual([`${BSU}body${ESU}`, 'b']);
  });

  it('a stray end marker without a begin passes through as ordinary output', () => {
    const assembler = createFrameAssembler();
    expect(assembler.ingest(`x${ESU}y`, 0)).toEqual([`x${ESU}y`]);
    expect(assembler.hasPending()).toBe(false);
  });
});
