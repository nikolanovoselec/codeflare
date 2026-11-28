// Managed Terminal Pi 1.7.0 only. Its public ExtensionContext reports agent
// runs but not the awaited prompt preflight. Expose only that native counter;
// leave the installed package, stock pi-web, and other Pi processes untouched.
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = dirname(realpathSync(process.argv[1]));
const chunk = join(bundle, 'chunks/chunk-Q6QBNASS.js');
const url = pathToFileURL(chunk).href;
const { version } = JSON.parse(readFileSync(join(bundle, '../../package.json'), 'utf8'));
const boundary = 'this._promptPreflightCount++;let trigger;try{trigger=await this._preparePrompt(text,options)}finally{this._promptPreflightCount--}';
const source = readFileSync(chunk, 'utf8');
if (version !== '1.7.0' || source.split(boundary).length !== 2) {
  throw new Error('Managed Pi prompt preflight boundary does not match the installed CLI');
}
const key = 'codeflare.pi.nativePromptPending';
const probe = `globalThis[Symbol.for(${JSON.stringify(key)})]`;
const adapted = source.replace(boundary, `${probe}(1);${boundary.slice(0, -1)};${probe}(-1)}`);
let pending = 0;
globalThis[Symbol.for(key)] = (delta = 0) => (pending += delta) > 0;
registerHooks({
  load(moduleUrl, context, next) {
    if (moduleUrl === url) return { format: 'module', shortCircuit: true, source: adapted };
    return next(moduleUrl, context);
  },
});
