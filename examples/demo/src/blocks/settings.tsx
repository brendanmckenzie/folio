import { blocks, defineBlock, text, textarea } from 'folio/core'

/**
 * Root block for the `settings` **singleton** (`document-types.md` architecture
 * decision 4 and 7).
 *
 * There is exactly one of these, and it does not need a uniqueness constraint to
 * stay that way: its id is *derived* from the type name (`sng_settings`), so
 * there is no other id a second one could be created under. An editor never
 * creates or deletes it either — it exists because this schema says so, and the
 * admin's Data rail is what brings the row into being on first access
 * (`ensureSingleton`).
 *
 * Reading it from *host* code — `folio.global('settings')` in a page's shell —
 * is `docs/specs/content-model/globals.md`'s job, not this spec's. Until that
 * lands, this demonstrates the admin half: the document exists, it is editable
 * and publishable like any other, and it refuses to be deleted or duplicated.
 */
export const settingsRoot = defineBlock({
  name: 'settingsRoot',
  label: 'Site settings',
  summary: 'siteName',
  fields: {
    siteName: text({ label: 'Site name', default: 'Folio demo' }),
    tagline: text({ label: 'Tagline' }),
    footerNote: textarea({ label: 'Footer note', rows: 2 }),
    footerLinks: blocks({ label: 'Footer links', allow: ['button'], max: 4 }),
  },
  render: ({ siteName, tagline, footerNote, footerLinks }) => (
    <footer className="settings">
      <p className="settings__name">{siteName}</p>
      {tagline ? <p className="settings__tagline">{tagline}</p> : null}
      {footerNote ? <p className="settings__note">{footerNote}</p> : null}
      <nav className="settings__links">{footerLinks}</nav>
    </footer>
  ),
})
