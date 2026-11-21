// REQ-AGENT-023 AC1: inspect and exercise the real image-owned tool environment.
// This deliberately does not use GRAPHIFY_TEST_PYTHON (the separate compatibility
// lane installs only [mcp]) or synthesize Python distribution metadata.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

const imageOnly = { skip: process.env.CODEFLARE_IMAGE_TEST !== '1' };
const python = '/root/.local/share/uv/tools/graphifyy/bin/python';
const trackedVersion = JSON.parse(readFileSync(new URL(
  '../../preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json', import.meta.url,
), 'utf8')).version;

const offlineGuard = `
import sys
# Offline checks must fail rather than silently contact a provider.
def offline(event, args):
    if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo'):
        raise RuntimeError('network access forbidden in image smoke test')
sys.addaudithook(offline)
`;

function inImage(check) {
  const root = mkdtempSync(join(tmpdir(), 'graphify-image-'));
  // No inherited provider credentials, user Python packages, or user config.
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root,
    GRAPHIFY_NO_AUTO_REFRESH: '1', LANG: 'C.UTF-8' };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${command}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  try {
    check({ run, python: (script) => run(python, ['-I', '-c', `${offlineGuard}\n${script}`]) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('REQ-AGENT-023 AC1: packaged Graphify distribution and CLI match the tracked version', imageOnly, () => {
  inImage(({ run, python }) => {
    const installed = python("from importlib.metadata import version\nprint(version('graphifyy'))").trim();
    assert.equal(installed, trackedVersion);
    // --version is an intentional public CLI contract, not a source-token check.
    const cli = run('/usr/local/bin/graphify', ['--version']).trim();
    assert.match(cli, new RegExp(`(?:^|\\s)${trackedVersion.replaceAll('.', '\\.')}($|\\s)`));
  });
});

it('REQ-AGENT-023 AC1: packaged MCP extra serves an offline graph over stdio', imageOnly, () => {
  inImage(({ python }) => python(`
import asyncio, json
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import anyio, starlette

graph = Path('graph.json').resolve()
graph.write_text(json.dumps({
    'directed': True, 'multigraph': False, 'graph': {},
    'nodes': [{'id': 'ImageNode', 'label': 'ImageNode', 'source_file': 'image.py',
               'file_type': 'code', 'community': 0}], 'links': []
}))
async def check():
    params = StdioServerParameters(command=sys.executable,
        args=['-I', '-c', ${JSON.stringify(offlineGuard)} +
              '\\nimport runpy; runpy.run_module("graphify.serve", run_name="__main__")', str(graph)],
        env={'HOME': str(Path.cwd()), 'PATH': '/usr/local/bin:/usr/bin:/bin',
             'GRAPHIFY_NO_AUTO_REFRESH': '1'})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert 'graph_stats' in {tool.name for tool in tools.tools}
            result = await session.call_tool('graph_stats', {})
            # Assert the MCP wire contract, independent of SDK attribute casing.
            assert not result.model_dump(by_alias=True).get('isError'), result
            text = '\\n'.join(item.text for item in result.content if item.type == 'text')
            assert 'Nodes: 1\\n' in text, text
asyncio.run(check())
`));
});

it('REQ-AGENT-023 AC1: packaged SQL extra extracts a table through Graphify', imageOnly, () => {
  inImage(({ python }) => python(`
from pathlib import Path
from graphify.extractors.sql import extract_sql
result = extract_sql(Path('schema.sql'), 'CREATE TABLE image_widgets (id INTEGER PRIMARY KEY);')
assert not result.get('error'), result
assert any(node['label'] == 'image_widgets' for node in result['nodes']), result
`));
});

it('REQ-AGENT-023 AC1: packaged PDF extra extracts text and converts markup offline', imageOnly, () => {
  inImage(({ python }) => python(`
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from graphify.detect import extract_pdf_text
from markdownify import markdownify

writer = PdfWriter()
page = writer.add_blank_page(width=200, height=100)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
    NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):
    DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
stream = DecodedStreamObject()
stream.set_data(b'BT /F1 12 Tf 10 50 Td (Image PDF extra proof) Tj ET')
page[NameObject('/Contents')] = writer._add_object(stream)
path = Path('proof.pdf')
with path.open('wb') as output:
    writer.write(output)
assert 'Image PDF extra proof' in extract_pdf_text(path)
assert markdownify('<strong>Image markup proof</strong>').strip() == '**Image markup proof**'
`));
});
