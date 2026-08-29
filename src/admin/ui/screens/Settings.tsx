import type { ReactNode } from 'react'
import { canManageAccess, type Me } from '../../me'
import type { Manifest } from '../../../core/schema'
import { Badge, type BadgeTone } from '../Badge'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import { href } from '../route'
import css from './Settings.module.css'
import {
  type BlockCard,
  type Fact,
  type FieldRow,
  type GlobalRow,
  type HookRow,
  isEmpty,
  type LocaleRow,
  type PresetRow,
  type ProviderRow,
  type Section,
  type SectionId,
  parseSettingsUrl,
  type SettingsView,
  settingsQuery,
  shownIn,
  type SlotRow,
  type TypeRow,
} from './settings-model'
import { useSettings } from './useSettings'

interface Props {
  /** Null while it is still loading. The shell fetches it once per load, so this
   * screen never fetches: a second read of an immutable payload would be a second
   * thing to keep in step. */
  manifest: Manifest | null
  me: Me
  /** For any link to another screen. */
  mount: string
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
}

/** Five placeholder blocks. Named rather than indexed, matching Documents'. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5']

/**
 * What this site is configured as — `docs/ui-architecture.md`'s port phase 5, and
 * the one screen in the admin that **cannot write anything**.
 *
 * That constraint is decision 6 and it is not a limitation to work around:
 * schema-as-code is what keeps the admin form, a block's prop types and the
 * rendered HTML in step, so a settings form would be a second source of truth for
 * the one thing that must have exactly one. `docs/feedback.md` takes the same
 * position on Strapi's schema-in-UI, in the owner's own words.
 *
 * The product case is the sentence after it, and it is what this screen is built
 * for: *"what is this site configured as" is currently only answerable by reading
 * someone's Worker.* So the reader here is a developer who has inherited a site,
 * or an editor asking why they cannot do something. Three consequences:
 *
 * 1. **Every section answers a question somebody asks out loud.** Not "here is
 *    `FolioConfig`, rendered" — `adminCss`, `assets` and `bindings` are all
 *    declared configuration and none of them is a question, so none of them is
 *    here. `settings-model.ts`'s header names the two that matter most.
 * 2. **Read-only is stated once, in prose, at the top.** The alternative — a
 *    disabled input per row — is what a form somebody broke looks like, and it
 *    would invite exactly the "why can't I change this" this screen is supposed
 *    to pre-empt.
 * 3. **It is filterable, and the filter is in the URL.** The reference project
 *    has eighty-seven block types; a flat dump of those is the failure mode this
 *    screen has to design against, and `filterBlocks` is the answer.
 */
export function Settings(props: Props) {
  const { manifest, me, mount, onQuery } = props
  const url = parseSettingsUrl(props.query)
  /*
   * Two routes feed this screen, and the split is a security boundary rather than
   * a convenience: `manifest` is `GET {base}/api/schema`, which is ungated and
   * carries what the host *declared*; `me.policy` is `GET {base}/api/me`, which
   * carries the sign-in policy and is only answered to a caller the server has
   * identified. `server/app.ts` states the rule; that block briefly lived on the
   * manifest and this is the shape of taking it back off.
   */
  const data = useSettings(manifest, me.policy, url)

  /*
   * Wrapped, to cancel the row gutter `ListHeader` carries — see `.head` in the
   * stylesheet for the measurement. The wrapper rather than a bare `ListHeader`
   * because every screen names itself the same way and that is worth keeping; what
   * is wrong is a *row* gutter on a screen whose body has no rows.
   */
  const header = (
    <div className={css.head}>
      <ListHeader
        level={1}
        actions={
          <input
            className={css.search}
            type="search"
            value={url.q}
            placeholder="Filter settings"
            aria-label="Filter settings"
            onChange={(e) => onQuery(settingsQuery({ q: e.target.value }))}
          />
        }
      >
        Settings
      </ListHeader>
    </div>
  )

  /*
   * The one sentence that makes the whole screen legible, and it names *where*
   * rather than only *that*: "read-only" alone reads as a permission you might
   * not have, while "declared in your Worker's `createFolio` call" is an address
   * somebody can go to.
   */
  const note = (
    <p className={css.note}>
      Everything here is declared in code, in this site's <code>createFolio</code> call, and none of
      it can be edited from the admin. Schema as code is what keeps the editor's form, a block's
      props and the rendered HTML from drifting — a settings form would be a second source of truth
      for the one thing that must have exactly one.
    </p>
  )

  if (!data.view) {
    return (
      <div className={css.screen}>
        {header}
        {note}
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      </div>
    )
  }

  const view = data.view

  return (
    <div className={css.screen}>
      {header}
      {note}

      {/*
        In-page anchors rather than a section switcher.

        **Rejected: tabs, or a route per section.** The whole rebuild exists to
        stop four site-level surfaces being 280px tabs, and "what is this site
        configured as" answered across six clicks is the same mistake one screen
        further in. An anchor list keeps the page one scrollable document — which
        is also what makes ⌘F work, and a developer reading a schema reaches for
        ⌘F before they reach for anything we build.
      */}
      <nav className={css.jump} aria-label="Settings sections">
        {data.sections.map((section) => (
          <a className={css.jumpLink} key={section.id} href={`#${section.anchor}`}>
            {section.label}
          </a>
        ))}
      </nav>

      {data.sections.map((section) => (
        <SectionBlock
          key={section.id}
          section={section}
          count={countText(view, section.id, url.q)}
          body={body(section.id, { view, data, me, mount, onQuery })}
        />
      ))}

      {isEmpty(view, url.q) ? (
        <EmptyState
          title="Nothing matches"
          body={`No declaration on this site mentions “${url.q.trim()}”. The filter matches names, labels and field kinds.`}
        />
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- scaffold --- */

/**
 * A section's frame.
 *
 * **`h2`, and it used to be an `h3` for a reason that expired.** The comment here
 * said `ListHeader` renders the screen's heading as an `h2`, so a section had to
 * start at `h3`. That was true before `ListHeader` grew its `level` prop; with
 * `level={1}` above, the outline ran `h1` → `h3` → `h4` and skipped a level, which
 * is the one thing a heading structure is not allowed to do. Sections are `h2` and
 * the tables inside them are `h3` (`.subHeading`).
 *
 * The count sits outside the heading rather than inside it, so a screen reader
 * announcing the section says "Document types" rather than "Document types 4 of
 * 12" — the number is orientation for an eye scanning the page, not part of the
 * section's name.
 */
function SectionBlock({
  section,
  count,
  body,
}: {
  section: Section
  count: string
  body: ReactNode
}) {
  return (
    <section className={css.section} id={section.anchor} aria-labelledby={`${section.anchor}-h`}>
      <div className={css.sectionHead}>
        <h2 className={css.heading} id={`${section.anchor}-h`}>
          {section.label}
        </h2>
        <span className={css.count}>{count}</span>
      </div>
      {body}
    </section>
  )
}

function countText(view: SettingsView, id: SectionId, q: string): string {
  const total = view.totals[id]
  const shown = shownIn(view, id)
  return q.trim() && shown !== total ? `${shown} of ${total}` : String(total)
}

interface Ctx {
  view: SettingsView
  data: ReturnType<typeof useSettings>
  me: Me
  mount: string
  onQuery: (next: Record<string, string | undefined>) => void
}

function body(id: SectionId, ctx: Ctx): ReactNode {
  switch (id) {
    case 'types':
      return <Types view={ctx.view} onQuery={ctx.onQuery} />
    case 'blocks':
      return <Blocks view={ctx.view} data={ctx.data} />
    case 'globals':
      return <Globals view={ctx.view} mount={ctx.mount} />
    case 'locales':
      return <Locales view={ctx.view} />
    case 'signin':
      return <SignIn view={ctx.view} me={ctx.me} mount={ctx.mount} />
    case 'hooks':
      return <Hooks view={ctx.view} />
    case 'caching':
      return <Facts label="Caching" rows={ctx.view.cache} />
  }
}

/**
 * The empty state for a section the host declared nothing in.
 *
 * **Its next step is prose, and it has no button.** `ui-architecture.md`'s
 * cross-cutting rule is that an empty state with no action is an error message,
 * and it is right everywhere else; here the action is a line of code in somebody's
 * Worker, so a button would be a control that cannot do what it says. Naming the
 * config key is the closest thing to an action this screen is allowed to offer.
 */
function Nothing({ title, children }: { title: string; children: ReactNode }) {
  return <EmptyState title={title} body={children} />
}

/* ----------------------------------------------------------- document types --- */

function Types({
  view,
  onQuery,
}: {
  view: SettingsView
  onQuery: (next: Record<string, string | undefined>) => void
}) {
  const columns: Column<TypeRow>[] = [
    {
      key: 'type',
      label: 'Type',
      /*
       * `.stack`, not a bare `.pair`: the label, then the name and its badges on a
       * declared second line. This is the one first column that shares its row with
       * seven others, so it is the one where a wrapping `.pair` ran out of width and
       * broke at a different point on every row — see `.stack` in the stylesheet.
       */
      cell: (row) => (
        <span className={css.stack}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.pair}>
            <span className={css.name}>{row.name}</span>
            {row.isDefault ? (
              <Badge title="A bare “New page” creates this type.">default</Badge>
            ) : null}
            {row.isGlobal ? (
              <Badge tone="accent" title="Named in `globals`, so it is loaded into every render.">
                global
              </Badge>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: 'kind',
      label: 'Kind',
      cell: (row) => <Badge tone={kindTone(row.kind)}>{row.kind}</Badge>,
    },
    {
      key: 'root',
      label: 'Root block',
      /*
       * Filters to that block, which is the second route into eighty-seven of
       * them: "which block is behind this type, and what does it declare" is a
       * question the types table should answer without a scroll. Narrowing to one
       * card also opens it (`openCards` rule 2), so the click lands on the schema
       * rather than on a collapsed row.
       *
       * A `<button>`, not an anchor with an `onClick`: it filters rather than
       * navigating, and Biome's `useValidAnchor` is right that an anchor which
       * does not go anywhere is a button wearing the wrong element. Styled as a
       * link because it reads as one, which is what `.linkButton` is for.
       */
      cell: (row) => (
        <button
          type="button"
          className={css.linkButton}
          title={`Show what ${row.root} declares`}
          onClick={() => onQuery({ q: row.root })}
        >
          {row.root}
        </button>
      ),
    },
    {
      key: 'title',
      label: 'Title from',
      cell: (row) =>
        row.titleField ? (
          <span className={css.name}>
            {row.titleField}
            {row.titleDerived ? (
              <span
                className={css.hint}
                title="Not declared. `titleFieldOf` derived it: a `title` field on the root block, then its `summary` field."
              >
                {' '}
                derived
              </span>
            ) : null}
          </span>
        ) : (
          <span
            className={css.blank}
            title="No title field. Documents of this type read “Untitled”."
          >
            —
          </span>
        ),
    },
    {
      key: 'where',
      label: 'Where it can live',
      cell: (row) => <span className={css.clause}>{row.where}</span>,
    },
    {
      key: 'top',
      label: 'Top level',
      /*
       * The refusal an editor actually meets, given its own column: an Insight
       * that will not be created at the root of the tree is `under`, and the
       * declaration says nothing about the top level at all. Spelling out the
       * consequence in the title is the point of the column.
       */
      cell: (row) =>
        row.topLevel === null ? (
          <span className={css.blank}>—</span>
        ) : row.topLevel ? (
          <Badge tone="ok">yes</Badge>
        ) : (
          <Badge
            tone="warn"
            title="Declaring `under` also means this type can never sit at the top level, because the top level has no type to match. This is the refusal an editor sees when creating one there."
          >
            no
          </Badge>
        ),
    },
    {
      key: 'group',
      label: 'Sidebar group',
      cell: (row) => row.group || <span className={css.blank}>—</span>,
    },
    {
      key: 'preview',
      label: 'Previewed on',
      cell: (row) => row.preview || <span className={css.blank}>—</span>,
    },
  ]

  return (
    <Table
      label="Document types"
      columns={columns}
      rows={view.types}
      rowKey={(row) => row.name}
      empty={
        <Nothing title="No document types match">
          Every site declares at least one — <code>createFolio</code> refuses to start otherwise.
        </Nothing>
      }
    />
  )
}

function kindTone(kind: TypeRow['kind']): BadgeTone {
  // `page` is the routed one and the only kind with a URL, which is the single
  // most consequential fact in the row; the other two are facts rather than
  // states, which is what `neutral` means here.
  return kind === 'page' ? 'accent' : 'neutral'
}

/* -------------------------------------------------------------- block types --- */

/**
 * Eighty-seven of these, on the site this admin was reviewed against. Every
 * decision in here is about that number.
 *
 * **One `<details>` per block, collapsed.** So the section is eighty-seven rows
 * of one line each, and opening one costs a keystroke rather than a screen.
 * `<details>` is native, so it is keyboard-operable and findable by the browser's
 * own ⌘F for free — the twelfth primitive this would otherwise have needed does
 * not exist, and `docs/design-system.md` fixes the count at eleven deliberately.
 *
 * **Rejected: an expanding table row.** `Table` has no disclosure and giving it
 * one is a change to a shared primitive for one screen's benefit. **Rejected:
 * paging the block list.** A manifest is not a live list — there is no cursor, no
 * total that moves and no second request — so a pager would be request-shaped
 * furniture over data already in hand. **Rejected: a flat dump.** Eighty-seven
 * blocks times six fields is five hundred rows, which is the unusable screen this
 * is designed against.
 */
function Blocks({ view, data }: { view: SettingsView; data: ReturnType<typeof useSettings> }) {
  if (view.blocks.length === 0) {
    return (
      <Nothing title="No block types match">
        A site's blocks are the <code>blocks</code> array passed to <code>createFolio</code>.
      </Nothing>
    )
  }

  return (
    <div className={css.cards}>
      {view.blocks.map((card) => (
        <details
          className={css.card}
          key={card.name}
          open={data.isOpen(card.name)}
          onToggle={(e) => data.setOpen(card.name, e.currentTarget.open)}
        >
          <summary className={css.summary}>
            <span className={css.pairLabel}>{card.label}</span>
            <span className={css.name}>{card.name}</span>
            <span className={css.cardMeta}>
              {plural(card.fields.length, 'field')} · {plural(card.slots.length, 'slot')} ·{' '}
              {plural(card.presets.length, 'preset')}
            </span>
            {card.rootFor.length > 0 ? (
              <Badge
                tone="accent"
                title="A document type's root block. `indexed` fields only project into the collection index here."
              >
                root for {card.rootFor.join(', ')}
              </Badge>
            ) : null}
            {card.presetsOnly ? (
              <Badge
                tone="neutral"
                title="The bare block is hidden from the add menu; only its presets are offered."
              >
                presets only
              </Badge>
            ) : null}
            {card.summary ? (
              <Badge mono title="The field whose value labels this block in the tree.">
                {card.summary}
              </Badge>
            ) : null}
          </summary>
          <div className={css.cardBody}>
            <Fields card={card} />
            {card.slots.length > 0 ? <Slots card={card} /> : null}
            {card.presets.length > 0 ? <Presets card={card} /> : null}
          </div>
        </details>
      ))}
    </div>
  )
}

function Fields({ card }: { card: BlockCard }) {
  const columns: Column<FieldRow>[] = [
    {
      key: 'field',
      label: 'Field',
      /* `help` is a second line by declaration, not by flex wrapping — see `.help`
       * in the stylesheet for the two tables that disagreed about it. */
      cell: (row) => (
        <span className={css.stack}>
          <span className={css.pair}>
            <span className={css.pairLabel}>{row.label}</span>
            <span className={css.name}>{row.name}</span>
          </span>
          {row.help ? <span className={css.help}>{row.help}</span> : null}
        </span>
      ),
    },
    { key: 'kind', label: 'Kind', cell: (row) => <span className={css.name}>{row.kind}</span> },
    { key: 'flags', label: 'Flags', cell: (row) => <Flags row={row} /> },
    {
      key: 'detail',
      label: 'Constraints',
      cell: (row) => row.detail || <span className={css.blank}>—</span>,
    },
    {
      key: 'default',
      label: 'Default',
      cell: (row) =>
        row.fieldDefault ? (
          <span className={css.name}>{row.fieldDefault}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: 'showIf',
      label: 'Shown when',
      cell: (row) => row.showIf || <span className={css.blank}>always</span>,
    },
  ]
  return (
    <>
      <h3 className={css.subHeading}>Fields</h3>
      <Table
        label={`${card.label} fields`}
        columns={columns}
        rows={card.fields}
        rowKey={(row) => row.name}
        empty={<p className={css.subNote}>This block declares no value fields.</p>}
      />
    </>
  )
}

/**
 * A field's flags, as badges — and the two of them that are *inert* wear a
 * different tone and say so.
 *
 * That is the whole reason this is not four booleans in four columns.
 * `indexed: true` on a block that is no document type's root projects nothing and
 * a `collection` naming the field is refused; `translatable: true` on a
 * single-locale site is a flag no translator will ever see the effect of. Both
 * are declarations that look like they do something, both are reported by
 * `GET {base}/api/audit`, and neither is visible in the code that declares it.
 */
function Flags({ row }: { row: FieldRow }) {
  return (
    <span className={css.flags}>
      {row.required ? (
        <Badge title="Surfaced in the editor. Declared-and-not-enforced on write, across the whole field system.">
          required
        </Badge>
      ) : null}
      {row.indexed ? (
        row.indexedInert ? (
          <Badge
            tone="warn"
            title="`indexed` only takes effect on a block that is a document type's root. This block is not one, so nothing is projected into the collection index and a query naming this field is refused."
          >
            indexed · inert
          </Badge>
        ) : (
          <Badge
            tone="accent"
            title="Filterable and sortable by a collection field and by folio.query."
          >
            indexed
          </Badge>
        )
      ) : null}
      {row.translatable ? (
        row.translatableInert ? (
          <Badge
            tone="warn"
            title="This site declares no locales, so there is no second language for a translation to live in."
          >
            translatable · inert
          </Badge>
        ) : (
          <Badge title="Holds a different value per locale, in the blok's `i18n`.">
            translatable
          </Badge>
        )
      ) : null}
      {row.hidden ? (
        <Badge title="Never drawn in the editor. Its stored value is untouched.">hidden</Badge>
      ) : null}
      {!row.required && !row.indexed && !row.translatable && !row.hidden ? (
        <span className={css.blank}>—</span>
      ) : null}
    </span>
  )
}

function Slots({ card }: { card: BlockCard }) {
  const columns: Column<SlotRow>[] = [
    {
      key: 'slot',
      label: 'Slot',
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.name}</span>
        </span>
      ),
    },
    {
      key: 'allow',
      label: 'Allows',
      cell: (row) => <span className={css.name}>{row.allow.join(', ')}</span>,
    },
    { key: 'max', label: 'Max children', numeric: true, cell: (row) => row.max },
  ]
  return (
    <>
      <h3 className={css.subHeading}>Slots</h3>
      <Table
        label={`${card.label} slots`}
        columns={columns}
        rows={card.slots}
        rowKey={(row) => row.name}
      />
    </>
  )
}

function Presets({ card }: { card: BlockCard }) {
  const columns: Column<PresetRow>[] = [
    {
      key: 'preset',
      label: 'Preset',
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.name}</span>
          {row.name === 'default' ? (
            <Badge
              tone="accent"
              title="A preset named `default` on a root block is a document type's starting content."
            >
              starting content
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'sets',
      label: 'Sets',
      cell: (row) =>
        row.sets.length ? (
          <span className={css.name}>{row.sets.join(', ')}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: 'children',
      label: 'Plants',
      cell: (row) =>
        row.children.length ? (
          <span className={css.name}>{row.children.join(', ')}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
  ]
  return (
    <>
      <h3 className={css.subHeading}>Presets</h3>
      <Table
        label={`${card.label} presets`}
        columns={columns}
        rows={card.presets}
        rowKey={(row) => row.name}
      />
    </>
  )
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/* ------------------------------------------------------------------ globals --- */

function Globals({ view, mount }: { view: SettingsView; mount: string }) {
  const columns: Column<GlobalRow>[] = [
    {
      key: 'global',
      label: 'Global',
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.name}</span>
        </span>
      ),
    },
    {
      key: 'root',
      label: 'Root block',
      cell: (row) => <span className={css.name}>{row.root}</span>,
    },
    { key: 'preview', label: 'Previewed on', cell: (row) => row.preview },
  ]
  return (
    <>
      <p className={css.subNote}>
        Singleton documents loaded into every page's resolution, so the host can place a header or a
        footer on any render.
      </p>
      <Table
        label="Globals"
        columns={columns}
        rows={view.globals}
        rowKey={(row) => row.name}
        /*
         * A link, not an `onOpen` callback: the URL is the state, and a global's
         * one document is addressable. Asking for a singleton's type is what
         * creates it, so this link always lands somewhere — `Documents` resolves
         * a singleton straight to its editor.
         */
        actions={(row) => (
          <a className={css.crossLink} href={href({ name: 'documents', type: row.name }, mount)}>
            Open
          </a>
        )}
        empty={
          <Nothing title="No globals declared">
            A global is a <code>singleton</code> type named in <code>createFolio</code>'s{' '}
            <code>globals</code>. It is an explicit list rather than every singleton, so the read
            set of a page render stays obvious.
          </Nothing>
        }
      />
    </>
  )
}

/* ------------------------------------------------------------------ locales --- */

function Locales({ view }: { view: SettingsView }) {
  const columns: Column<LocaleRow>[] = [
    {
      key: 'code',
      label: 'Code',
      cell: (row) => (
        <span className={css.pair}>
          <Badge mono>{row.code}</Badge>
          <span className={css.pairLabel}>{row.label}</span>
        </span>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      cell: (row) =>
        row.source ? (
          <Badge
            tone="accent"
            title="The locale `Blok.data` holds. Every other language is a per-field override in `i18n`."
          >
            source
          </Badge>
        ) : (
          <Badge>translation</Badge>
        ),
    },
    {
      key: 'fallback',
      label: 'Declared fallback',
      cell: (row) =>
        row.fallback ? (
          <span className={css.name}>{row.fallback}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: 'order',
      label: 'An untranslated field reads',
      cell: (row) => <span className={css.name}>{row.readOrder.join(' → ')}</span>,
    },
  ]
  return (
    <Table
      label="Locales"
      columns={columns}
      rows={view.locales}
      rowKey={(row) => row.code}
      empty={
        <Nothing title="Single-locale site">
          Nothing declares <code>locales</code>, so there is no locale switcher, no second inspector
          column, and every read is the source locale. One document would hold every language if
          there were more than one.
        </Nothing>
      }
    />
  )
}

/* ------------------------------------------------------------------ sign-in --- */

function SignIn({ view, me, mount }: { view: SettingsView; me: Me; mount: string }) {
  const columns: Column<ProviderRow>[] = [
    {
      key: 'provider',
      label: 'Provider',
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.id}</span>
        </span>
      ),
    },
    { key: 'flow', label: 'Flow', cell: (row) => <span className={css.clause}>{row.flow}</span> },
    {
      key: 'unknown',
      label: 'An email with no account',
      cell: (row) => <span className={css.clause}>{row.unknownEmail}</span>,
    },
  ]

  return (
    <>
      {/*
        This whole section comes from `GET {base}/api/me`, never from the manifest:
        the mode, the providers and the two policy numbers. That is a security
        boundary, not a plumbing detail — `server/app.ts` states the rule and
        `server/auth/config.ts`'s `AuthPolicy` argues it.

        `auth: 'open'` is the one configuration on this screen worth flagging
        rather than reporting, because its consequence is a publicly editable CMS
        and it is a single line of config away from not being one.
      */}
      <p className={css.subNote}>
        {me.mode === 'open' ? (
          <>
            <Badge tone="danger">open</Badge> This deployment declares <code>auth: 'open'</code>.
            Anyone who reaches the editor may edit and publish, and there are no accounts at all.
          </>
        ) : (
          <>
            <Badge tone="ok">sign-in required</Badge> Folio owns the session; the host sends the
            mail and holds the provider's credentials, which is why none of them are on this screen.
          </>
        )}
      </p>

      <Table
        label="Sign-in providers"
        columns={columns}
        rows={view.providers}
        rowKey={(row) => row.id}
        /*
         * Two ways to be empty, and they are different answers. Under `open` there
         * is genuinely no sign-in flow. In session mode an empty list means the
         * *policy* is missing rather than the providers — `/api/me` does not
         * describe a site's security posture to a caller it cannot identify, which
         * is the whole point of the block living there.
         */
        empty={
          me.mode === 'open' ? (
            <Nothing title="No providers to list">
              Under <code>auth: 'open'</code> there is no sign-in flow. A deployment that wants one
              names providers in <code>createFolio</code>'s <code>auth</code> key.
            </Nothing>
          ) : (
            <Nothing title="Sign in to see the sign-in policy">
              Which providers are configured, and what they do with an unknown address, is answered
              by <code>/api/me</code> rather than by the public schema — so it is not described to a
              caller the server cannot identify.
            </Nothing>
          )
        }
      />

      {view.session.length > 0 ? (
        <Facts label="Session policy" heading="Session policy" rows={view.session} />
      ) : null}

      {/*
        Absent rather than disabled for a non-admin, which is the cross-cutting
        rule: Access 404s server-side for anyone below `admin`, so the link would
        be an offer of a broken screen.
      */}
      {canManageAccess(me) ? (
        <p className={css.subNote}>
          Who may sign in, and with which role, is{' '}
          <a className={css.crossLink} href={href({ name: 'access' }, mount)}>
            Access
          </a>{' '}
          — that list is content, not configuration, so it is editable and this is not.
        </p>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------- hooks --- */

function Hooks({ view }: { view: SettingsView }) {
  const columns: Column<HookRow>[] = [
    { key: 'event', label: 'Event', cell: (row) => <span className={css.name}>{row.event}</span> },
    {
      key: 'awaited',
      label: 'Awaited',
      cell: (row) =>
        row.awaited ? (
          <Badge
            tone="warn"
            title="The write waits for this handler before responding. Everything else rides `waitUntil`."
          >
            before responding
          </Badge>
        ) : (
          <Badge title="Runs after the response, on `waitUntil`.">after the response</Badge>
        ),
    },
  ]
  return (
    <>
      <p className={css.subNote}>
        After-commit callbacks in the host's own Worker — a typed function call, not a webhook, so
        there is no secret, no retry policy and no delivery log to configure.
      </p>
      <Table
        label="Publish hooks"
        columns={columns}
        rows={view.hooks}
        rowKey={(row) => row.event}
        empty={
          <Nothing title="No publish hooks declared">
            Nothing runs after a write beyond Folio's own cache purge. A host adds handlers in{' '}
            <code>createFolio</code>'s <code>hooks</code> key.
          </Nothing>
        }
      />
    </>
  )
}

/* -------------------------------------------------------------------- facts --- */

/**
 * The two sections that are not lists of declarations. Three columns, and the
 * third is why: a number on a settings screen with no explanation beside it is
 * the thing a reader has to go and look up, which is the problem this screen
 * exists to solve.
 */
function Facts({
  label,
  rows,
  heading,
}: {
  label: string
  rows: readonly Fact[]
  /** Rendered when this table sits *beneath* another one in the same section, so
   * a reader can tell where the providers stop and the policy starts. Omitted
   * when the section's own `h3` already names it. */
  heading?: string
}) {
  const columns: Column<Fact>[] = [
    { key: 'label', label: 'Setting', cell: (row) => row.label },
    { key: 'value', label: 'Value', cell: (row) => <span className={css.name}>{row.value}</span> },
    { key: 'why', label: 'Why', cell: (row) => <span className={css.why}>{row.why}</span> },
  ]
  return (
    <>
      {heading ? <h3 className={css.subHeading}>{heading}</h3> : null}
      <Table label={label} columns={columns} rows={rows} rowKey={(row) => row.label} />
    </>
  )
}
