import { test, expect } from 'claude-code/testing'
import { candidates, linkPaths, openCommand, splitPosition, looksLikePath } from './paths'

const cwd = 'C:\\repo'
const home = 'C:\\Users\\me'
const real = new Set(['C:\\repo\\mods\\readable\\hooks\\register.tsx', 'C:\\Users\\me\\notes.md', 'C:\\repo\\README.md', 'C:\\data\\Report.docx'])
const exists = async (p: string) => real.has(p)

test('position splits off a line and column, not a drive letter', () => {
  expect(splitPosition('a/b.ts:12:3')).toEqual({ path: 'a/b.ts', line: 12, col: 3 })
  expect(splitPosition('C:\\x.py')).toEqual({ path: 'C:\\x.py' })
})

test('what reads as a path', () => {
  expect(looksLikePath('mods/readable/x.ts')).toBe(true)
  expect(looksLikePath('README.md')).toBe(true)
  expect(looksLikePath('C:\\data\\Report.docx')).toBe(true)
  expect(looksLikePath('hello world')).toBe(false)
  expect(looksLikePath('https://x.com/a')).toBe(false)
})

test('only existing paths become links; fences and links are left alone', async () => {
  const text = 'See `mods/readable/hooks/register.tsx:41`, ~/notes.md and C:\\data\\Report.docx. Not `nope/x.ts`.\n```\nmods/readable/hooks/register.tsx\n```\n[README](README.md)'
  const out = await linkPaths(text, cwd, home, exists)
  expect(out).toContain('[`mods/readable/hooks/register.tsx:41`](file:///C:/repo/mods/readable/hooks/register.tsx#L41)')
  expect(out).toContain('[~/notes.md](file:///C:/Users/me/notes.md)')
  expect(out).toContain('[C:\\data\\Report.docx](file:///C:/data/Report.docx).')
  expect(out).toContain('`nope/x.ts`')
  expect(out).toContain('```\nmods/readable/hooks/register.tsx\n```')
  expect(out).toContain('[README](README.md)')
  expect(candidates('and/or terminal/desktop').length).toBe(2)
})

test('press: code at the line in VS Code, documents in their app, programs revealed', () => {
  expect(openCommand('file:///C:/repo/a.py#L41')).toEqual(['explorer.exe', 'vscode://file/C:/repo/a.py:41'])
  expect(openCommand('file:///C:/data/Report.docx')).toEqual(['explorer.exe', 'C:\\data\\Report.docx'])
  expect(openCommand('file:///C:/x/setup.exe')).toEqual(['explorer.exe', '/select,C:\\x\\setup.exe'])
  expect(openCommand('file:///C:/x/run.ps1')).toEqual(['explorer.exe', 'vscode://file/C:/x/run.ps1'])
})
