import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

it('renders SVG and converts PNG to JPEG offline with bundled tools', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'image-tools-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  try {
    writeFileSync(join(root, 'input.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#ff0000"/></svg>');
    run('rsvg-convert', ['input.svg', '-o', 'output.png']);
    run('convert', ['output.png', 'output.jpg']);
    run('python3', ['-c', `from PIL import Image, ImageFont
png = Image.open('output.png')
assert png.format == 'PNG' and png.size == (32, 24)
assert png.convert('RGB').getpixel((16, 12)) == (255, 0, 0)
jpg = Image.open('output.jpg')
assert jpg.format == 'JPEG' and jpg.size == (32, 24)
r, g, b = jpg.convert('RGB').getpixel((16, 12))
assert r > 240 and g < 15 and b < 15
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
assert font.getbbox('Letterbox')[2] > 0
`]);
    run('python3', ['-m', 'venv', 'venv']);
    run(join(root, 'venv/bin/python'), ['-m', 'pip', '--version']);
    run('python3', ['-m', 'pip', '--version']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
