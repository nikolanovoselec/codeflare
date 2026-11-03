#!/usr/bin/env node
// Pi 1.5.0 adds secondary names but retains primary IDs. Patch presentation
// only, including the CLI bundle; selection, settings keys and wire IDs stay intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const label = 'model.provider === "codeflare-gateway" ? (model.name || model.id) : model.id';
const bundledLabel = 'model.provider==="codeflare-gateway"?(model.name||model.id):model.id';
const files = [
  ['dist/modes/interactive/components/model-selector.js', [
    [
    'const modelText = isSelected ? theme.fg("accent", item.id) : item.id;',
    'const codeflareModelLabel = item.provider === "codeflare-gateway" ? (item.model.name || item.id) : item.id;\n            const modelText = isSelected ? theme.fg("accent", codeflareModelLabel) : codeflareModelLabel;',
    ],
    ['const name = getDistinctModelName({ id: item.id, name: item.model.name });',
      'const name = item.provider === "codeflare-gateway" ? undefined : getDistinctModelName({ id: item.id, name: item.model.name });'],
  ]],
  ['dist/modes/interactive/components/settings-selector.js', [
    ['function modelDisplayLabel(model) {\n    return `${model.id} [${model.provider}]`;\n}',
      `function modelDisplayLabel(model) {\n    const label = ${label};\n    return \`\${label} [\${model.provider}]\`;\n}`],
    ['function modelItemLabel(model) {\n    return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;\n}',
      `function modelItemLabel(model) {\n    const label = ${label};\n    return \`\${label} \${theme.fg("muted", \`[\${model.provider}]\`)}\`;\n}`],
  ]],
  ['dist/modes/interactive/interactive-mode.js', [
    ['this.showStatus(`Model: ${model.id}`);',
      `this.showStatus(\`Model: \${${label}}\`);`],
    ['this.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`);',
      `this.showStatus(persist ? \`Default model: \${model.provider}/\${${label}}\` : \`Model: \${${label}}\`);`],
  ]],
  ['dist/bundle/chunks/chunk-44DLKSKE.js', [
    ['name=getDistinctModelName({id:item.id,name:item.model.name})',
      'name=item.provider==="codeflare-gateway"?void 0:getDistinctModelName({id:item.id,name:item.model.name})'],
    ['modelText=isSelected?theme.fg("accent",item.id):item.id',
      'codeflareModelLabel=item.provider==="codeflare-gateway"?(item.model.name||item.id):item.id,modelText=isSelected?theme.fg("accent",codeflareModelLabel):codeflareModelLabel'],
    ['function modelDisplayLabel(model){return`${model.id} [${model.provider}]`}',
      `function modelDisplayLabel(model){let label=${bundledLabel};return\`\${label} [\${model.provider}]\`}`],
    ['function modelItemLabel(model){return`${model.id} ${theme.fg("muted",`[${model.provider}]`)}`}',
      `function modelItemLabel(model){let label=${bundledLabel};return\`\${label} \${theme.fg("muted",\`[\${model.provider}]\`)}\`}`],
    ['this.showStatus(`Model: ${model.id}`)',
      `this.showStatus(\`Model: \${${bundledLabel}}\`)`],
    ['this.showStatus(persist?`Default model: ${model.provider}/${model.id}`:`Model: ${model.id}`)',
      `this.showStatus(persist?\`Default model: \${model.provider}/\${${bundledLabel}}\`:\`Model: \${${bundledLabel}}\`)`],
  ]],
];

// Registry SHA-512-verified 1.5.0 archive; check complete original bytes, not just replacement anchors.
const originalHashes = {
  'dist/modes/interactive/components/model-selector.js': '9a2f5d17db853130845d2b98cd5329a900923a3e107ecbb0142a38e9b7716384',
  'dist/modes/interactive/components/settings-selector.js': '4d50aef1f9cc3579bcb1300f090036b590e5cc8fad0b32f63dc26ec282f11109',
  'dist/modes/interactive/interactive-mode.js': '718980c4931aa457ba8f531c07c0f2ef4d2c8f1f660f044028029f59f11daa2c',
  'dist/bundle/chunks/chunk-44DLKSKE.js': 'e52d27d064df05fe8ec15f05db07d7c895051597551a0d62b2fe77208d88e942',
};

export function patchPiNativeModelDisplay(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.5.0') {
    throw new Error('Native model display patch requires Pi 1.5.0');
  }
  const states = new Set();
  const staged = files.map(([relative, replacements]) => {
    const path = join(root, relative);
    let source = readFileSync(path, 'utf8');
    for (const [before, after] of replacements) {
      const oldCount = source.split(before).length - 1;
      const newCount = source.split(after).length - 1;
      if (oldCount === 1 && newCount === 0) {
        states.add('original');
        source = source.replace(before, after);
      } else if (oldCount === 0 && newCount === 1) states.add('patched');
      else throw new Error(`Native model display anchor drift: ${relative}`);
    }
    const original = [...replacements].reverse().reduce((text, [before, after]) => text.replace(after, before), source);
    if (createHash('sha256').update(original).digest('hex') !== originalHashes[relative]) {
      throw new Error(`Native model display source hash drift: ${relative}`);
    }
    return { path, source };
  });
  if (states.size !== 1) throw new Error('Incomplete native model display patch');
  if (states.has('original')) for (const { path, source } of staged) writeFileSync(path, source);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: patch-pi-native-model-display.mjs PI_PACKAGE_ROOT');
  patchPiNativeModelDisplay(process.argv[2]);
}
