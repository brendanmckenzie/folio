import { asset, blocks, boolean, defineBlock, select, text, textarea } from 'folio/core'

/**
 * Root block. Every document has exactly one.
 *
 * Page metadata lives here rather than in the stories table, so editing it runs
 * through the same sync engine as everything else: multiplayer, undoable,
 * versioned, and published atomically with the content. Only routing structure
 * (slug, parent, order) lives in D1.
 *
 * `access` is the `gate` field this demo declares
 * (`docs/specs/platform/visitor-access.md` phase 4). `Everyone` has to be
 * first: `defaultValue(select)` is `options[0]?.value` (`fields.ts`), so a
 * seeded document carries whichever option is listed first, and if that were
 * `Members` every new page would publish gated with nobody having chosen it.
 */
export const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true, translatable: true }),
    description: textarea({
      label: 'Meta description',
      rows: 3,
      help: 'Shown in search results. Around 150 characters.',
      translatable: true,
    }),
    socialImage: asset({ label: 'Social share image', accept: 'image/*' }),
    noindex: boolean({ label: 'Hide from search engines' }),
    // The gate field named in `createFolio`'s `gate: { field: 'access', ... }`
    // below (src/index.tsx). `indexed: true` is required by `validateGate` —
    // lists are not gated (checkpoint 6), so a host filters on this field
    // instead — and it must not be `translatable` (decision 2): a gate that
    // varies by language is a hole a stranger asking in French could walk
    // through.
    access: select({
      label: 'Access',
      options: [
        { label: 'Everyone', value: 'public' },
        { label: 'Members', value: 'members' },
      ],
      indexed: true,
      help: 'Members-only pages show a paywall to anyone not signed in to membership.',
    }),
    body: blocks({
      label: 'Body',
      allow: [
        'hero',
        'prose',
        'pullquote',
        'image',
        'gallery',
        'features',
        'cta',
        'embed',
        'section',
        'personCard',
        // Two more blocks that read records rather than holding content
        // (`content-model/data-documents.md`): a hand-picked ordered list of
        // people, and a reference to a record with no renderer of its own.
        'leadership',
        'officeCard',
        // The one block that lists other documents rather than holding content
        // (`content-model/collections.md`), so a page can be an index page.
        'insightList',
        // The one block that *collects* rather than shows
        // (`content-model/forms.md`): a form built in the admin, embedded here
        // by id and rendered from the descriptor.
        'contactForm',
      ],
    }),
  },
  render: ({ body }) => <main className="page">{body}</main>,
})
