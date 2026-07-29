import { asset, defineBlock, defineRecord, reference, references, richtext, text } from 'folio/core'

/**
 * Root block for the `person` document type — a **record**
 * (`content-model/data-documents.md`): it has no URL at all, so naming one
 * "Contact" cannot take `/contact` away from the page that needs it.
 *
 * Written with `defineRecord` rather than `defineBlock`. The two are the same
 * function under the skin — `render` is optional on every block now — but the
 * name says what the definition is *for*, and this one keeps a renderer on
 * purpose: checkpoint 2's "a record may still have one, and it is used for
 * `reference.content`". `personCard` and `leadership` below both inline a person
 * with `{person.content}` and never restate this markup.
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
export const personRecord = defineRecord({
  name: 'personRecord',
  label: 'Person',
  summary: 'fullName',
  fields: {
    // `indexed: true` on a record's root is what fills the Data list view's
    // columns (`data-documents.md` decision 2) as well as making people
    // queryable through `folio.query`. Root-block only, same rule as everywhere.
    fullName: text({ label: 'Full name', required: true, indexed: true }),
    role: text({ label: 'Role', indexed: true }),
    // A sortable column that is not a name: the list view sorts this
    // numerically, because the projection fills `num_value` for a number field.
    since: text({
      label: 'Joined',
      indexed: true,
      placeholder: '2019-04-01',
      help: 'ISO 8601. Sorted as a date in the Data list, not as text.',
    }),
    portrait: asset({ label: 'Portrait', accept: 'image/*' }),
    bio: richtext({
      label: 'Short bio',
      marks: ['bold', 'italic', 'link'],
      nodes: ['paragraph'],
      translatable: true,
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
 * The other half of checkpoint 1: a record with **no renderer at all**.
 *
 * An office is an address, a phone number and a set of opening hours. There is no
 * layout for it — every page that shows one shows it differently — so this
 * definition has no `render`, and Folio does not make it return `null` from a
 * mandatory function to say so. A block that references one reads `office.data`,
 * because `office.content` is genuinely `null`.
 *
 * In the editor this is invisible rather than broken: an office is only ever
 * opened through the Data list, which is a form with no preview, and a
 * `folio-unrendered` placeholder appears only if a *page* somehow contains one.
 */
export const officeRecord = defineRecord({
  name: 'officeRecord',
  label: 'Office',
  summary: 'city',
  fields: {
    city: text({ label: 'City', required: true, indexed: true }),
    address: text({ label: 'Street address' }),
    phone: text({ label: 'Phone', indexed: true }),
    hours: text({ label: 'Opening hours', translatable: true }),
  },
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

/**
 * `references()` — a hand-picked, **ordered** list
 * (`content-model/data-documents.md` decision 3).
 *
 * Deliberately not a `collection` with a filter: a query cannot express "these
 * three, in this order", and `ord` on the people themselves is one global order
 * rather than a per-usage one. A leadership section and an "authors in this
 * issue" section want different orders over the same records.
 *
 * `team.map(…)` needs no guard. Every entry resolved — an unresolvable one (a
 * person since deleted) is dropped by `resolveReferences` rather than left as a
 * hole, so nothing here renders an empty card. The *editor* still shows the
 * missing entry, which is where that information belongs.
 */
export const leadership = defineBlock({
  name: 'leadership',
  label: 'Leadership',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    team: references({
      label: 'People',
      types: ['person'],
      min: 1,
      max: 6,
      help: 'Pick up to six, in the order they should appear. Drag with ↑ ↓.',
    }),
  },
  render: ({ heading, team }) => (
    <section className="leadership">
      {heading ? <h2 className="leadership__heading">{heading}</h2> : null}
      {team.length === 0 ? (
        <p className="leadership__empty">Nobody picked yet.</p>
      ) : (
        <ul className="leadership__items">
          {team.map((person) => (
            <li key={person.id}>{person.content}</li>
          ))}
        </ul>
      )}
    </section>
  ),
})

/**
 * The counterpart block: a reference to a record with **no** renderer, so
 * `office.content` is null and this reads `office.data` itself.
 *
 * That is checkpoint 2's split written out in one component — and the reason
 * `content` is literally `null` rather than an element that renders nothing: the
 * `??` below would be dead code otherwise.
 */
export const officeCard = defineBlock({
  name: 'officeCard',
  label: 'Office card',
  fields: {
    office: reference({
      label: 'Office',
      types: ['office'],
      help: 'An Office record has no renderer of its own, so this block draws it.',
    }),
  },
  render: ({ office }) => {
    if (!office) {
      return <section className="card card--empty">No office selected.</section>
    }
    // No renderer on `officeRecord`, so `content` is null and `data` is the whole
    // contract. `data` is already read in the resolution's locale, so a French
    // page gets the French opening hours with no extra work here.
    return (
      <section className="office">
        {office.content ?? (
          <>
            <h3 className="office__city">{String(office.data.city ?? office.title)}</h3>
            {office.data.address ? (
              <p className="office__line">{String(office.data.address)}</p>
            ) : null}
            {office.data.phone ? (
              <p className="office__line">
                <a href={`tel:${String(office.data.phone).replace(/\s+/g, '')}`}>
                  {String(office.data.phone)}
                </a>
              </p>
            ) : null}
            {office.data.hours ? (
              <p className="office__hours">{String(office.data.hours)}</p>
            ) : null}
          </>
        )}
      </section>
    )
  },
})
