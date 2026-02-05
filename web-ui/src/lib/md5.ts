/**
 * Minimal MD5 hash implementation for browser use (Gravatar URLs).
 * SubtleCrypto doesn't support MD5, so we need a pure JS implementation.
 * Based on the well-known public domain MD5 algorithm by Joseph Myers.
 */

function md5cycle(x: number[], k: number[]) {
  let a = x[0], b = x[1], c = x[2], d = x[3];
  const f = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => {
    a += ((b & c) | (~b & d)) + x + t;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  };
  const g = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => {
    a += ((b & d) | (c & ~d)) + x + t;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  };
  const h = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => {
    a += (b ^ c ^ d) + x + t;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  };
  const i = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => {
    a += (c ^ (b | ~d)) + x + t;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  };

  a=f(a,b,c,d,k[0],7,-680876936);d=f(d,a,b,c,k[1],12,-389564586);c=f(c,d,a,b,k[2],17,606105819);b=f(b,c,d,a,k[3],22,-1044525330);
  a=f(a,b,c,d,k[4],7,-176418897);d=f(d,a,b,c,k[5],12,1200080426);c=f(c,d,a,b,k[6],17,-1473231341);b=f(b,c,d,a,k[7],22,-45705983);
  a=f(a,b,c,d,k[8],7,1770035416);d=f(d,a,b,c,k[9],12,-1958414417);c=f(c,d,a,b,k[10],17,-42063);b=f(b,c,d,a,k[11],22,-1990404162);
  a=f(a,b,c,d,k[12],7,1804603682);d=f(d,a,b,c,k[13],12,-40341101);c=f(c,d,a,b,k[14],17,-1502002290);b=f(b,c,d,a,k[15],22,1236535329);

  a=g(a,b,c,d,k[1],5,-165796510);d=g(d,a,b,c,k[6],9,-1069501632);c=g(c,d,a,b,k[11],14,643717713);b=g(b,c,d,a,k[0],20,-373897302);
  a=g(a,b,c,d,k[5],5,-701558691);d=g(d,a,b,c,k[10],9,38016083);c=g(c,d,a,b,k[15],14,-660478335);b=g(b,c,d,a,k[4],20,-405537848);
  a=g(a,b,c,d,k[9],5,568446438);d=g(d,a,b,c,k[14],9,-1019803690);c=g(c,d,a,b,k[3],14,-187363961);b=g(b,c,d,a,k[8],20,1163531501);
  a=g(a,b,c,d,k[13],5,-1444681467);d=g(d,a,b,c,k[2],9,-51403784);c=g(c,d,a,b,k[7],14,1735328473);b=g(b,c,d,a,k[12],20,-1926607734);

  a=h(a,b,c,d,k[5],4,-378558);d=h(d,a,b,c,k[8],11,-2022574463);c=h(c,d,a,b,k[11],16,1839030562);b=h(b,c,d,a,k[14],23,-35309556);
  a=h(a,b,c,d,k[1],4,-1530992060);d=h(d,a,b,c,k[4],11,1272893353);c=h(c,d,a,b,k[7],16,-155497632);b=h(b,c,d,a,k[10],23,-1094730640);
  a=h(a,b,c,d,k[13],4,681279174);d=h(d,a,b,c,k[0],11,-358537222);c=h(c,d,a,b,k[3],16,-722521979);b=h(b,c,d,a,k[6],23,76029189);
  a=h(a,b,c,d,k[9],4,-640364487);d=h(d,a,b,c,k[12],11,-421815835);c=h(c,d,a,b,k[15],16,530742520);b=h(b,c,d,a,k[2],23,-995338651);

  a=i(a,b,c,d,k[0],6,-198630844);d=i(d,a,b,c,k[7],10,1126891415);c=i(c,d,a,b,k[14],15,-1416354905);b=i(b,c,d,a,k[5],21,-57434055);
  a=i(a,b,c,d,k[12],6,1700485571);d=i(d,a,b,c,k[3],10,-1894986606);c=i(c,d,a,b,k[10],15,-1051523);b=i(b,c,d,a,k[1],21,-2054922799);
  a=i(a,b,c,d,k[8],6,1873313359);d=i(d,a,b,c,k[15],10,-30611744);c=i(c,d,a,b,k[6],15,-1560198380);b=i(b,c,d,a,k[13],21,1309151649);
  a=i(a,b,c,d,k[4],6,-145523070);d=i(d,a,b,c,k[11],10,-1120210379);c=i(c,d,a,b,k[2],15,718787259);b=i(b,c,d,a,k[9],21,-343485551);

  x[0] = (a + x[0]) | 0;
  x[1] = (b + x[1]) | 0;
  x[2] = (c + x[2]) | 0;
  x[3] = (d + x[3]) | 0;
}

function md5blk(s: string) {
  const md5blks: number[] = [];
  for (let i = 0; i < 64; i += 4) {
    md5blks[i >> 2] =
      s.charCodeAt(i) +
      (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) +
      (s.charCodeAt(i + 3) << 24);
  }
  return md5blks;
}

function rhex(n: number) {
  const hex = '0123456789abcdef';
  let s = '';
  for (let j = 0; j < 4; j++) {
    s += hex.charAt((n >> (j * 8 + 4)) & 0x0f) + hex.charAt((n >> (j * 8)) & 0x0f);
  }
  return s;
}

export function md5(s: string): string {
  const n = s.length;
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let i: number;

  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(s.substring(i - 64, i)));
  }

  s = s.substring(i - 64);
  const tail = Array(16).fill(0) as number[];
  for (i = 0; i < s.length; i++) {
    tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  }
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);

  if (i > 55) {
    md5cycle(state, tail);
    tail.fill(0);
  }
  tail[14] = n * 8;
  md5cycle(state, tail);

  return state.map(rhex).join('');
}
