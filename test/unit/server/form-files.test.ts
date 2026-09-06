import { describe, expect, it } from 'vitest'
import type { FormField } from '../../../src/core/forms'
import { MAX_UPLOAD_BYTES } from '../../../src/server/assets'
import { type Actor, allows, FORMS, hasScope } from '../../../src/server/auth/roles'
import {
  capFor,
  newUploadKey,
  sniffUpload,
  UPLOAD_PREFIX,
} from '../../../src/server/form-responses'
import { fileCap, type Form, uploadKeysOf } from '../../../src/server/forms'

/**
 * The pure half of an upload (`docs/specs/content-model/forms.md` decision 15).
 *
 * Everything here decides what happens to bytes an anonymous stranger posted at
 * a public endpoint, and every one of these functions is the *only* thing
 * standing between those bytes and an R2 bucket somebody pays for. Four
 * properties, each silent when it breaks:
 *
 *  - **The declared content type is never consulted.** `sniffUpload` reads magic
 *    bytes, so a `.exe` renamed `cv.pdf` and sent as `application/pdf` is
 *    refused on what it is rather than on what it says.
 *  - **The submitted filename never decides the key.** It rides along after a
 *    minted prefix and through `safeFilename`, so no path separator, no `..` and
 *    no collision.
 *  - **The cap is the editor's number clamped to the platform's**, and the same
 *    clamp serves the descriptor, the body cap and the per-file check.
 *  - **Reading responses is `publisher` plus `forms:read`**, implied by nothing
 *    but `admin`.
 */

const bytes = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0))
    else out.push(...part)
  }
  return new Uint8Array(out)
}

/** A ZIP local file header is a fixed 30 bytes before the entry's name. */
const zip = (entry: string): Uint8Array =>
  bytes('PK\x03\x04', new Array(26).fill(0) as number[], entry)

const PNG = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0])
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')
const GIF = bytes('GIF89a', [0, 0])
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBP')
const AVIF = bytes([0, 0, 0, 0], 'ftyp', 'avif')
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const PDF = bytes('%PDF-1.7\n%')
const OOXML = zip('[Content_Types].xml')
const ODT = zip('mimetype')
const OLE2 = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0, 0, 0, 0])
const TEXT = bytes('name,email\nada,ada@example.com\n')
const EXE = bytes('MZ', [0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])

describe('sniffUpload: what the bytes say, never what the header claims', () => {
  it('names each image the fixed menu offers, and refuses the two it does not', () => {
    expect(sniffUpload(PNG)).toEqual({ family: 'images', contentType: 'image/png' })
    expect(sniffUpload(JPEG)).toEqual({ family: 'images', contentType: 'image/jpeg' })
    expect(sniffUpload(GIF)).toEqual({ family: 'images', contentType: 'image/gif' })
    expect(sniffUpload(WEBP)).toEqual({ family: 'images', contentType: 'image/webp' })

    // Neither is in `FILE_ACCEPT.images`, and the menu is the contract. SVG is
    // the one that matters: it is attacker-supplied XML, and an `<img>` on this
    // origin is the last place it should end up.
    expect(sniffUpload(AVIF)).toBeNull()
    expect(sniffUpload(SVG)).toBeNull()
  })

  it('names a PDF exactly and a container only by family', () => {
    expect(sniffUpload(PDF)).toEqual({ family: 'documents', contentType: 'application/pdf' })
    // A `.docx` and an `.xlsx` are the same ZIP container, and no cheap
    // signature tells them apart — so the family is what the gate uses and the
    // exact label is decided from the submitter's claim afterwards.
    expect(sniffUpload(OOXML)).toEqual({ family: 'documents', contentType: null })
    expect(sniffUpload(OLE2)).toEqual({ family: 'documents', contentType: null })
  })

  it('refuses an archive that is not an Office package', () => {
    // `[Content_Types].xml` at the fixed offset is what makes a ZIP a document
    // rather than an arbitrary archive somebody wanted to post at a contact form.
    expect(sniffUpload(ODT)).toBeNull()
  })

  it('reads a file with no signature at all as text, and a binary one as nothing', () => {
    expect(sniffUpload(TEXT)).toEqual({ family: 'documents', contentType: 'text/plain' })
    // `text/plain` is the one member of the menu with no magic bytes, so "is it
    // text" has to be a property of the bytes. A NUL or a stray C0 control is
    // what every binary this does not recognise carries in its first bytes.
    expect(sniffUpload(EXE)).toBeNull()
    expect(sniffUpload(new Uint8Array(0))).toBeNull()
  })

  it('admits tab, newline and carriage return, and nothing else below space', () => {
    expect(sniffUpload(bytes('a\tb\r\nc'))?.contentType).toBe('text/plain')
    expect(sniffUpload(bytes('a', [0x07], 'b'))).toBeNull()
    expect(sniffUpload(bytes('a', [0x00], 'b'))).toBeNull()
  })
})

describe('newUploadKey: a stranger cannot choose a path', () => {
  const KEY = /^sub_[0-9a-f]{12}-[a-z0-9.-]{1,80}$/

  it('mints under the prefix the public asset route cannot serve', () => {
    const key = newUploadKey('cv.pdf')
    expect(key.startsWith(UPLOAD_PREFIX)).toBe(true)
    expect(key).toMatch(KEY)
    // `{base}/asset/:key` is anchored to `^ast_…`, so this is a 400 from the
    // parameter validator before a handler runs — no new guard to forget.
    expect(key.startsWith('ast_')).toBe(false)
  })

  it('drops every path segment, so traversal is not representable', () => {
    for (const hostile of [
      '../../../.env',
      '/etc/passwd',
      'C:\\Windows\\System32\\config',
      'a/b/c/logo.png',
    ]) {
      const key = newUploadKey(hostile)
      expect(key).toMatch(KEY)
      expect(key).not.toContain('/')
      expect(key).not.toContain('\\')
      expect(key).not.toContain('..')
    }
  })

  it('survives a filename that is nothing but punctuation, and one that is enormous', () => {
    expect(newUploadKey('')).toMatch(KEY)
    expect(newUploadKey('!!!')).toMatch(KEY)
    expect(newUploadKey(`${'a'.repeat(500)}.pdf`)).toMatch(KEY)
  })

  it('never collides, because the id decides the key and the name only decorates it', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newUploadKey('cv.pdf')))
    expect(keys.size).toBe(50)
  })
})

describe('fileCap: the editor picks a number, the platform picks the ceiling', () => {
  const file = (maxBytes?: number): FormField => ({
    name: 'cv',
    kind: 'file',
    label: 'CV',
    accept: 'documents',
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })

  it('clamps to the upload ceiling and defaults to it', () => {
    expect(fileCap(file(1024))).toBe(1024)
    expect(fileCap(file(MAX_UPLOAD_BYTES * 4))).toBe(MAX_UPLOAD_BYTES)
    expect(fileCap(file())).toBe(MAX_UPLOAD_BYTES)
  })

  it('is what the body cap sums, so a text-only form never budgets 20MB', () => {
    const form = (fields: FormField[]) => ({ fields }) as Form

    // The whole reason the cap is not `MAX_UPLOAD_BYTES`: a form with nowhere to
    // put a byte must not let a stranger stream twenty megabytes into a Worker.
    const empty = capFor(form([]))
    expect(capFor(form([{ name: 'note', kind: 'textarea', label: 'Note' }]))).toBeLessThan(
      MAX_UPLOAD_BYTES,
    )
    expect(capFor(form([file(1024)])) - empty).toBe(1024)
    expect(capFor(form([file(1024)]))).toBeLessThan(MAX_UPLOAD_BYTES)

    // Two questions of 1MB each is a 2MB body cap — and `prepareUploads` is what
    // stops one 2MB file from filling it.
    expect(capFor(form([file(1_000_000), file(1_000_000)]))).toBeGreaterThan(2_000_000)
  })
})

describe('uploadKeysOf: the delete walk cannot be stopped by a bad row', () => {
  it('reads the keys out of a files column', () => {
    expect(uploadKeysOf('[{"field":"cv","key":"sub_aaaaaaaaaaaa-cv.pdf"}]')).toEqual([
      'sub_aaaaaaaaaaaa-cv.pdf',
    ])
  })

  it('answers nothing for anything that is not a list of keyed objects', () => {
    // Screened on read, `parseScopes`' posture: a malformed column must not be
    // the reason a form cannot be deleted.
    expect(uploadKeysOf('[]')).toEqual([])
    expect(uploadKeysOf('not json')).toEqual([])
    expect(uploadKeysOf('{"key":"sub_x"}')).toEqual([])
    expect(uploadKeysOf('[null, 3, "sub_x", {}, {"key":42}, {"key":""}]')).toEqual([])
  })
})

describe('FORMS: reading what strangers typed about themselves', () => {
  const user = (role: 'viewer' | 'editor' | 'publisher' | 'admin'): Actor => ({
    kind: 'user',
    id: 'usr_1',
    name: 'A',
    colour: '#000',
    role,
    session: 's',
    expiresAt: 0,
  })
  const token = (...scopes: Parameters<typeof hasScope>[0]): Actor => ({
    kind: 'token',
    id: 'tok_1',
    name: 't',
    scopes,
  })

  it('is publisher, not viewer, and not editor', () => {
    expect(allows(user('publisher'), FORMS)).toBe(true)
    expect(allows(user('admin'), FORMS)).toBe(true)
    // An editor who may write a page is not thereby somebody who may read the
    // enquiries — decision 8's point, and the gap from READ is deliberate.
    expect(allows(user('editor'), FORMS)).toBe(false)
    expect(allows(user('viewer'), FORMS)).toBe(false)
    expect(allows(null, FORMS)).toBe(false)
  })

  it('is implied by admin and by nothing else', () => {
    expect(allows(token('forms:read'), FORMS)).toBe(true)
    expect(allows(token('admin'), FORMS)).toBe(true)
    // Writing content says nothing about reading responses, and reading
    // responses says nothing about writing content.
    expect(allows(token('content:write'), FORMS)).toBe(false)
    expect(allows(token('publish'), FORMS)).toBe(false)
    expect(allows(token('assets:write'), FORMS)).toBe(false)
    expect(hasScope(['forms:read'], 'content:read')).toBe(false)
  })
})
