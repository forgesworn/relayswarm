// Stand-in core modules for failure tests: every export the loader requires,
// with each function either trapping or returning a constant.

const I32 = 0x7f, F64 = 0x7c;
export const CORE_FUNCTIONS = {
  rs_alloc: [[I32], [I32]],
  rs_free: [[I32, I32], []],
  rs_call: [[I32, I32, I32], [I32]],
  rs_result_ptr: [[], [I32]],
  rs_sel_observe: [[F64, F64, F64, F64, F64], []],
  rs_sel_record: [[F64, I32, F64, F64], []],
  rs_sel_forget: [[I32], []],
  rs_sel_select: [[I32, I32, F64, F64], [F64]],
  rs_sel_state: [[], [I32]],
  rs_sel_project: [[F64], [F64]],
  rs_sel_minimum: [[F64], [F64]],
  rs_sel_estimate: [[I32, F64], [F64]],
  rs_sel_summary: [[I32], [I32]],
};

const leb = (value) => { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const name = (text) => vec([...Buffer.from(text)]);

/**
 * A module whose functions named in `trap` trap; the rest return zero, or
 * the small i32 in `values` (-64 to 63).
 */
export function stubCore(trap, values = {}) {
  const entries = Object.entries(CORE_FUNCTIONS);
  const types = entries.map(([, [params, results]]) => [0x60, ...vec(params), ...vec(results)]);
  const bodies = entries.map(([fn, [, results]]) => {
    const code = trap.includes(fn) ? [0x00] : results[0] === I32 ? [0x41, (values[fn] ?? 0) & 0x7f] : results[0] === F64 ? [0x44, 0, 0, 0, 0, 0, 0, 0, 0] : [];
    const body = [0, ...code, 0x0b];
    return [...leb(body.length), ...body];
  });
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec(types)),
    ...section(3, vec(entries.map((_, index) => leb(index)))),
    ...section(5, [1, 0, 1]),
    ...section(7, vec([[...name("memory"), 2, 0], ...entries.map(([fn], index) => [...name(fn), 0, ...leb(index)])])),
    ...section(10, vec(bodies))]);
}
