// Local declaration for jsdom — the package ships JS only, and we do
// not pull in @types/jsdom for one consumer (host/__tests__/setup-010
// OG-metadata test). The surface declared here is exactly what the
// test uses: the JSDOM constructor and its .window.document.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string);
    readonly window: { document: Document };
  }
}
