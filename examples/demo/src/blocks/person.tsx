import { asset, defineBlock, reference, richtext, text } from 'folio/core'

/**
 * Root block for the `person` document type — a **record** (`document-types.md`
 * checkpoint 2): it has no URL at all, so naming one "Contact" cannot take
 * `/contact` away from the page that needs it.
 *
 * Note what is *not* here: no `description`, no `socialImage`, no `noindex`.
 * That is the whole point of a document type. Before this existed, a person was
 * a page with three unused metadata fields and a comment explaining which ones
 * mattered.
 *
 * `titleField: 'fullName'` on the type (see src/index.tsx) is what tells Folio
 * where the display title lives, since this block has no `title` field for the
 * tree cache or the version list to have guessed at.
 */
export const personRecord = defineBlock({
  name: 'personRecord',
  label: 'Person',
  summary: 'fullName',
  fields: {
    fullName: text({ label: 'Full name', required: true }),
    role: text({ label: 'Role' }),
    portrait: asset({ label: 'Portrait', accept: 'image/*' }),
    bio: richtext({
      label: 'Short bio',
      marks: ['bold', 'italic', 'link'],
      nodes: ['paragraph'],
    }),
  },
  // A record is still an ordinary document: it renders through the same
  // registry, which is what lets `personCard` below inline it with `content`.
  render: ({ fullName, role, portrait, bio }) => (
    <figure className="person">
      {portrait ? (
        <img
          className="person__portrait"
          src={portrait.srcFor({ width: 320, height: 320, fit: 'cover', format: 'webp' })}
          alt={portrait.alt}
          style={{ objectPosition: portrait.objectPosition }}
        />
      ) : null}
      <figcaption className="person__caption">
        <p className="person__name">{fullName || 'Unnamed'}</p>
        {role ? <p className="person__role">{role}</p> : null}
        <div className="person__bio">{bio}</div>
      </figcaption>
    </figure>
  ),
})

/**
 * A block whose picker is narrowed by document type: `reference({ types:
 * ['person'] })` offers only people, so an editor cannot wire this to the
 * homepage. Enforced twice (`document-types.md` architecture decision 5) — the
 * admin's picker only lists people, *and* `resolveReference` re-checks, because
 * a value can also arrive from an importer or over the API. A wrong-type value
 * resolves to `null` and the empty state below is what renders.
 */
export const personCard = defineBlock({
  name: 'personCard',
  label: 'Person card',
  fields: {
    person: reference({
      label: 'Person',
      types: ['person'],
      help: 'Only Person records are offered here.',
    }),
  },
  render: ({ person }) => {
    if (!person) {
      return <section className="card card--empty">No person selected.</section>
    }
    // `content` is the record rendered through its own root block, so this card
    // never restates a person's markup.
    return <section className="card">{person.content}</section>
  },
})
