import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { shellPaths } from './trail.mjs'

const ok = (value: unknown) => ({ value }) as never

test('shell commands: writers and readers are told apart', () => {
  expect(shellPaths("Set-Content -Path notes.md -Value 'x'; Get-Content C:\\a\\b.txt").writes).toEqual(['notes.md'])
  expect(shellPaths("Set-Content -Path notes.md -Value 'x'; Get-Content C:\\a\\b.txt").reads).toEqual(['C:\\a\\b.txt'])
  expect(shellPaths('echo hi > out.log').writes).toEqual(['out.log'])
  expect(shellPaths('Get-ChildItem -Recurse').reads).toEqual([])
})

function world(on: On) {
  mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:\\Users\\Hasan' })
  const modelCalls: string[] = []
  on('model.complete', async ($, e) => {
    modelCalls.push(e.prompt)
    return ok({ isAnswered: true, text: '', usage: {} })
  })
  on('session.cwd', async () => ok('G:\\My Drive\\proj'))
  // Only notes.md exists on disk; grep patterns and folders do not count.
  on('fs.stat', async ($, e) => {
    if (String(e.path).endsWith('notes.md')) return ok({ kind: 'file', size: 1, mtimeMs: 0, isLink: false })
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  on('command.register', async ($, e) => ok({ command: e.name }))
  on('ui.invalidate', async () => ok(undefined))
  on('session.start', async () => ({ cwd: 'G:\\My Drive\\proj' }) as never)
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  return modelCalls
}

test('edits, reads and shell writes anywhere show up grouped by folder, with no model calls', async ($, on) => {
  const modelCalls = world(on)
  await $.session.start({ source: 'startup', cwd: 'G:\\My Drive\\proj', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\Hasan\\.claude-mods\\plugins\\mod-bar\\hooks\\mod-bar.mjs', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'G:\\My Drive\\proj\\README.md', tool_use_id: 'r1' } as never)
  await $.tool.call({ tool: 'PowerShell', command: "Set-Content -Path notes.md -Value 'x'", tool_use_id: 'p1' } as never)
  await $.tool.call({ tool: 'Bash', command: `grep -n "ok(['terminal'])" src/a.test.ts | head`, tool_use_id: 'b1' } as never)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'trail', surface, component: 'Pane', requestId: 'trail', props: { bodyColumns: 40, title: 'Trail', isFocused: false, placement: 'dock' } as never })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
    const names = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
    expect(texts).toContain('3 FILES · 2 CHANGED')
    // Folders as foldable rows, single-child chains merged; the files just touched glow.
    expect(names).toEqual(expect.arrayContaining(['clear', String.raw`▾ ~\.claude-mods\plugins\mod-bar\hooks`, String.raw`▾ G:\My Drive\proj`]))
    expect(texts).toEqual(expect.arrayContaining([' ● mod-bar.mjs ', ' ● README.md ', ' ● notes.md ', ' +2 −1']))
    await ui.unmount()
  }
  expect(modelCalls).toEqual([])
})

test('/trail answers and opens the pane', async ($, on) => {
  world(on)
  const opened: unknown[] = []
  on('ui.open', async ($, e) => {
    opened.push(e)
    return ok({ isPlaced: true })
  })
  await $.session.start({ source: 'startup', cwd: 'G:\My Drive\proj', surface: 'desktop', isInteractive: true } as never)
  const r = await $.command.run({ command: 'trail', args: '' } as never)
  expect(JSON.stringify(r)).toContain('Trail')
  expect(opened.length).toBe(1)
})
