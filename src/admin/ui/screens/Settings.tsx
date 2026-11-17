import type { ReactNode } from "react";
import { canManageAccess, type Me } from "../../me";
import type { Manifest } from "../../../core/schema";
import { Badge } from "../Badge";
import { EmptyState } from "../EmptyState";
import { ListHeader } from "../List";
import { type Column, Table } from "../Table";
import { href } from "../route";
import css from "./Settings.module.css";
import {
  type BlockCard,
  type Fact,
  type FieldRow,
  type HookRow,
  groupBlocks,
  groupTypes,
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
} from "./settings-model";
import { useSettings } from "./useSettings";

interface Props {
  /** Null while it is still loading. The shell fetches it once per load, so this
   * screen never fetches: a second read of an immutable payload would be a second
   * thing to keep in step. */
  manifest: Manifest | null;
  me: Me;
  /** For any link to another screen. */
  mount: string;
  query: Readonly<Record<string, string>>;
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void;
}

/** Five placeholder blocks. Named rather than indexed, matching Documents'. */
const SKELETON = ["s1", "s2", "s3", "s4", "s5"];

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
  const { manifest, me, mount, onQuery } = props;
  const url = parseSettingsUrl(props.query);
  /*
   * Two routes feed this screen, and the split is a security boundary rather than
   * a convenience: `manifest` is `GET {base}/api/schema`, which is ungated and
   * carries what the host *declared*; `me.policy` is `GET {base}/api/me`, which
   * carries the sign-in policy and is only answered to a caller the server has
   * identified. `server/app.ts` states the rule; that block briefly lived on the
   * manifest and this is the shape of taking it back off.
   */
  const data = useSettings(manifest, me.policy, url);

  const header = (
    <ListHeader
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
    />
  );

  /*
   * One line, and it still names *where*: "read-only" alone reads as a permission
   * you might not have, while `createFolio` is an address somebody can go to. The
   * rationale (schema as code, one source of truth) lives in `ui-architecture.md`
   * decision 6 and this file's header; it was four lines here and nobody read it.
   */
  const note = (
    <p className={css.note}>
      Declared in code in <code>createFolio</code>. Read-only here.
    </p>
  );

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
    );
  }

  const view = data.view;

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
  );
}

/* ---------------------------------------------------------------- scaffold --- */

/**
 * A section's frame.
 *
 * **`h2`, and this file went through two wrong reasons to make it something else
 * before landing here.** The comment used to say `ListHeader` renders the screen's
 * heading as an `h2`, so a section had to start at `h3` — true before `ListHeader`
 * grew a `level` prop. It then briefly said `level={1}` made this screen's own
 * `h1`, so a section starting at `h2` skipped nothing. Both are gone: the screen's
 * `h1` is the breadcrumb's last crumb now (issue #8), above everything this
 * component renders, so the outline is `h1` (top bar) → `h2` (this section) → `h3`
 * (the tables inside it, `.subHeading`) — still correct, and still skips nothing.
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
  section: Section;
  count: string;
  body: ReactNode;
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
  );
}

function countText(view: SettingsView, id: SectionId, q: string): string {
  const total = view.totals[id];
  const shown = shownIn(view, id);
  return q.trim() && shown !== total ? `${shown} of ${total}` : String(total);
}

interface Ctx {
  view: SettingsView;
  data: ReturnType<typeof useSettings>;
  me: Me;
  mount: string;
  onQuery: (next: Record<string, string | undefined>) => void;
}

function body(id: SectionId, ctx: Ctx): ReactNode {
  switch (id) {
    case "types":
      return <Types view={ctx.view} mount={ctx.mount} onQuery={ctx.onQuery} />;
    case "blocks":
      return <Blocks view={ctx.view} data={ctx.data} />;
    case "locales":
      return <Locales view={ctx.view} />;
    case "signin":
      return <SignIn view={ctx.view} me={ctx.me} mount={ctx.mount} />;
    case "hooks":
      return <Hooks view={ctx.view} />;
    case "caching":
      return <Facts label="Caching" rows={ctx.view.cache} />;
  }
}

/**
 * The empty line for a section the host declared nothing in.
 *
 * **A muted sentence, not an `EmptyState`.** It used to be the large centred
 * empty state, four or five lines of it, twice on a site with no locales and no
 * hooks. That shape is right where an empty list is a problem with a button to fix
 * it (`ui-architecture.md`'s cross-cutting rule), and wrong here: the next step is a
 * line of code in somebody's Worker, so there is no button, and "this site declares
 * none" is a one-line answer. The next step stays as prose, naming the config key.
 */
function Nothing({ children }: { children: ReactNode }) {
  return <p className={css.empty}>{children}</p>;
}

/* ----------------------------------------------------------- document types --- */

/**
 * Document types, one table per kind.
 *
 * **This was one eight-column table, and it is superseded** (it recorded that the
 * header labels had to wrap to fit it). Most cells were an em dash or restated the
 * kind: "Not in the tree — edited as a table" on every record, "yes" top level on
 * every page. Each kind keeps only the columns that can differ within it, so the
 * widths are apportioned per table and no header needs to wrap to fit. A kind with
 * no types draws nothing.
 */
function Types({
  view,
  mount,
  onQuery,
}: {
  view: SettingsView;
  mount: string;
  onQuery: (next: Record<string, string | undefined>) => void;
}) {
  const groups = groupTypes(view.types);

  const typeCol = (width: string): Column<TypeRow> => ({
    key: "type",
    label: "Type",
    width,
    /*
     * `.stack`, not a bare `.pair`: the label, then the name and its badges on a
     * declared second line, so every row of every table is the same two lines tall.
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
  });

  const rootCol = (width: string): Column<TypeRow> => ({
    key: "root",
    label: "Root block",
    width,
    /*
     * Filters to that block: "which block is behind this type, and what does it
     * declare" is a question this table should answer without a scroll. Narrowing
     * to one card also opens it (`openCards` rule 2). A `<button>`, not an anchor
     * with an `onClick`: it filters rather than navigating, and Biome's
     * `useValidAnchor` is right that an anchor which goes nowhere is a button.
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
  });

  const titleCol = (width: string): Column<TypeRow> => ({
    key: "title",
    label: "Title from",
    width,
    cell: (row) =>
      row.titleField ? (
        // Derived is the common case, so it is the quiet one: same text, muted,
        // with the explanation in the tooltip rather than a word in every row.
        <span
          className={row.titleDerived ? css.derived : css.name}
          title={
            row.titleDerived
              ? "Not declared. `titleFieldOf` derived it: a `title` field on the root block, then its `summary` field."
              : undefined
          }
        >
          {row.titleField}
        </span>
      ) : (
        <span className={css.blank} title="No title field. Documents of this type read “Untitled”.">
          —
        </span>
      ),
  });

  const dash = (value: string) => value || <span className={css.blank}>—</span>;

  const pages: Column<TypeRow>[] = [
    typeCol("26%"),
    rootCol("20%"),
    titleCol("16%"),
    {
      key: "where",
      label: "Where it can live",
      width: "38%",
      cell: (row) => (
        /*
         * The refusal an editor actually meets, folded into the one cell that
         * explains it: an Insight that will not be created at the root of the tree
         * is `under`, and the declaration says nothing about the top level at all.
         * A page that cannot sit at the top level is warned, as the old "no" badge was.
         */
        <span
          className={row.topLevel === false ? css.clauseWarn : css.clause}
          title={
            row.topLevel === false
              ? "Declaring `under` also means this type can never sit at the top level, because the top level has no type to match. This is the refusal an editor sees when creating one there."
              : undefined
          }
        >
          {row.where}
        </span>
      ),
    },
  ];

  const records: Column<TypeRow>[] = [
    typeCol("26%"),
    rootCol("20%"),
    titleCol("16%"),
    { key: "group", label: "Sidebar group", width: "16%", cell: (row) => dash(row.group) },
    { key: "preview", label: "Previewed on", width: "22%", cell: (row) => dash(row.preview) },
  ];

  const singletons: Column<TypeRow>[] = [
    // Sums to 90%, not 100%: the `Open` actions column is a `<col>` with no width, and
    // declared widths that already fill the table leave it none, so the table was
    // wider than its container and drew a horizontal scrollbar (the Globals bug).
    typeCol("32%"),
    rootCol("28%"),
    { key: "preview", label: "Previewed on", width: "30%", cell: (row) => dash(row.preview) },
  ];

  const section = (heading: string, columns: Column<TypeRow>[], rows: TypeRow[], open = false) =>
    rows.length === 0 ? null : (
      <>
        <h3 className={css.subHeading}>
          {heading} <span className={css.count}>{rows.length}</span>
        </h3>
        <Table
          label={heading}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.name}
          /*
           * A link, not an `onOpen` callback: the URL is the state, and a singleton's
           * one document is addressable. Asking for a singleton's type is what creates
           * it, so this link always lands somewhere. This is what the Globals table
           * carried that the type rows did not, and the only reason it is not simply gone.
           */
          actions={
            open
              ? (row) => (
                  <a
                    className={css.crossLink}
                    href={href({ name: "documents", type: row.name }, mount)}
                  >
                    Open
                  </a>
                )
              : undefined
          }
        />
      </>
    );

  return (
    <>
      {section("Pages", pages, groups.pages)}
      {section("Records", records, groups.records)}
      {section("Singletons", singletons, groups.singletons, true)}
    </>
  );
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
      <Nothing>
        None declared. A site's blocks are the <code>blocks</code> array passed to{" "}
        <code>createFolio</code>.
      </Nothing>
    );
  }

  /*
   * **Two groups, because the flat list mixed two audiences.** A document root is
   * the block behind a type (it is where `indexed` takes effect and where the "root
   * for" chip lives); every other block is a module an editor places in a slot.
   * Thirty-five rows in one list buried the half somebody asks about by type.
   */
  const groups = groupBlocks(view.blocks);
  const list = (heading: string, cards: BlockCard[]) =>
    cards.length === 0 ? null : (
      <>
        <h3 className={css.subHeading}>
          {heading} <span className={css.count}>{cards.length}</span>
        </h3>
        <div className={css.cards}>
          {cards.map((card) => (
            <details
              className={css.card}
              key={card.name}
              open={data.isOpen(card.name)}
              onToggle={(e) => data.setOpen(card.name, e.currentTarget.open)}
            >
              <summary className={css.summary}>
                <span className={css.pairLabel}>{card.label}</span>
                <span className={css.name}>{card.name}</span>
                <span className={css.cardMeta}>{counts(card)}</span>
                {card.rootFor.length > 0 ? (
                  <Badge
                    tone="accent"
                    title="A document type's root block. `indexed` fields only project into the collection index here."
                  >
                    root for {card.rootFor.join(", ")}
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
      </>
    );

  return (
    <>
      {list("Document roots", groups.roots)}
      {list("Blocks", groups.modules)}
    </>
  );
}

/** "5 fields · 1 slot", leaving out what is zero: "0 slots · 0 presets" on most rows said nothing. */
function counts(card: BlockCard): string {
  return [
    [card.fields.length, "field"],
    [card.slots.length, "slot"],
    [card.presets.length, "preset"],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, noun]) => plural(n as number, noun as string))
    .join(" · ");
}

function Fields({ card }: { card: BlockCard }) {
  const columns: Column<FieldRow>[] = [
    {
      key: "field",
      label: "Field",
      width: "40%",
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
    {
      key: "kind",
      label: "Kind",
      width: "10%",
      cell: (row) => <span className={css.name}>{row.kind}</span>,
    },
    { key: "flags", label: "Flags", width: "14%", cell: (row) => <Flags row={row} /> },
    {
      key: "detail",
      label: "Constraints",
      width: "15%",
      cell: (row) => row.detail || <span className={css.blank}>—</span>,
    },
    {
      key: "default",
      label: "Default",
      width: "10%",
      cell: (row) =>
        row.fieldDefault ? (
          <span className={css.name}>{row.fieldDefault}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: "showIf",
      label: "Shown when",
      width: "11%",
      cell: (row) => row.showIf || <span className={css.blank}>always</span>,
    },
  ];
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
  );
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
  );
}

function Slots({ card }: { card: BlockCard }) {
  const columns: Column<SlotRow>[] = [
    {
      key: "slot",
      label: "Slot",
      width: "30%",
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.name}</span>
        </span>
      ),
    },
    {
      key: "allow",
      label: "Allows",
      // The widest thing in this table by a distance: a permissive slot lists
      // fourteen block names, where the slot's own label and name are two words.
      width: "56%",
      cell: (row) => <span className={css.name}>{row.allow.join(", ")}</span>,
    },
    { key: "max", label: "Max children", width: "14%", numeric: true, cell: (row) => row.max },
  ];
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
  );
}

function Presets({ card }: { card: BlockCard }) {
  const columns: Column<PresetRow>[] = [
    {
      key: "preset",
      label: "Preset",
      width: "40%",
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.name}</span>
          {row.name === "default" ? (
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
      key: "sets",
      label: "Sets",
      width: "40%",
      cell: (row) =>
        row.sets.length ? (
          <span className={css.name}>{row.sets.join(", ")}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: "children",
      label: "Plants",
      width: "20%",
      cell: (row) =>
        row.children.length ? (
          <span className={css.name}>{row.children.join(", ")}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
  ];
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
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ locales --- */

function Locales({ view }: { view: SettingsView }) {
  const columns: Column<LocaleRow>[] = [
    {
      key: "code",
      label: "Code",
      width: "14%",
      cell: (row) => (
        <span className={css.pair}>
          <Badge mono>{row.code}</Badge>
          <span className={css.pairLabel}>{row.label}</span>
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      width: "16%",
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
      key: "fallback",
      label: "Declared fallback",
      width: "22%",
      cell: (row) =>
        row.fallback ? (
          <span className={css.name}>{row.fallback}</span>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: "order",
      label: "An untranslated field reads",
      width: "48%",
      cell: (row) => <span className={css.name}>{row.readOrder.join(" → ")}</span>,
    },
  ];
  if (view.locales.length === 0) {
    return (
      <Nothing>
        Single locale. Nothing declares <code>locales</code>.
      </Nothing>
    );
  }
  return <Table label="Locales" columns={columns} rows={view.locales} rowKey={(row) => row.code} />;
}

/* ------------------------------------------------------------------ sign-in --- */

function SignIn({ view, me, mount }: { view: SettingsView; me: Me; mount: string }) {
  const columns: Column<ProviderRow>[] = [
    {
      key: "provider",
      label: "Provider",
      width: "26%",
      cell: (row) => (
        <span className={css.pair}>
          <span className={css.pairLabel}>{row.label}</span>
          <span className={css.name}>{row.id}</span>
        </span>
      ),
    },
    {
      key: "flow",
      label: "Flow",
      width: "16%",
      cell: (row) => <span className={css.clause}>{row.flow}</span>,
    },
    {
      key: "unknown",
      label: "An email with no account",
      width: "24%",
      cell: (row) => <span className={css.clause}>{row.unknownEmail}</span>,
    },
    // Where to go to change somebody's role, which is the fact an editor needs:
    // never the mapping itself, because a `RoleMapper` is a host function
    // (`server/auth/config.ts`, and the spec's decision 5).
    {
      key: "roles",
      label: "Roles",
      width: "14%",
      cell: (row) => <span className={css.clause}>{row.roles}</span>,
    },
    {
      key: "domains",
      label: "Enforced domains",
      width: "20%",
      cell: (row) => <span className={css.clause}>{row.domains}</span>,
    },
  ];

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
        {me.mode === "open" ? (
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

      {view.providers.length === 0 ? (
        /*
         * Two ways to be empty, and they are different answers. Under `open` there
         * is genuinely no sign-in flow. In session mode an empty list means the
         * *policy* is missing rather than the providers — `/api/me` does not
         * describe a site's security posture to a caller it cannot identify, which
         * is the whole point of the block living there.
         */
        <Nothing>
          {me.mode === "open" ? (
            <>
              No providers: under <code>auth: 'open'</code> there is no sign-in flow.
            </>
          ) : (
            <>Sign in to see the sign-in policy. It is not described to an unidentified caller.</>
          )}
        </Nothing>
      ) : (
        <Table
          label="Sign-in providers"
          columns={columns}
          rows={view.providers}
          rowKey={(row) => row.id}
        />
      )}

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
          Who may sign in, and with which role, is{" "}
          <a className={css.crossLink} href={href({ name: "access" }, mount)}>
            Access
          </a>{" "}
          — that list is content, not configuration, so it is editable and this is not.
        </p>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------- hooks --- */

function Hooks({ view }: { view: SettingsView }) {
  const columns: Column<HookRow>[] = [
    {
      key: "event",
      label: "Event",
      width: "25%",
      cell: (row) => <span className={css.name}>{row.event}</span>,
    },
    {
      key: "awaited",
      label: "Awaited",
      width: "75%",
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
  ];
  if (view.hooks.length === 0) {
    return (
      <Nothing>
        None declared. Add handlers in <code>createFolio</code>'s <code>hooks</code>.
      </Nothing>
    );
  }
  return (
    <>
      <p className={css.subNote}>
        After-commit callbacks in the host's own Worker: a typed function call, not a webhook, so
        there is no secret, no retry policy and no delivery log to configure.
      </p>
      <Table
        label="Publish hooks"
        columns={columns}
        rows={view.hooks}
        rowKey={(row) => row.event}
      />
    </>
  );
}

/* -------------------------------------------------------------------- facts --- */

/**
 * The two sections that are not lists of declarations. Three columns, and the
 * third is why: a number on a settings screen with no explanation beside it is
 * the thing a reader has to go and look up. The explanation is kept but quiet (one
 * clamped line, full text on hover), because a paragraph per row made two five-row
 * tables read as the heaviest thing on the screen.
 */
function Facts({
  label,
  rows,
  heading,
}: {
  label: string;
  rows: readonly Fact[];
  /** Rendered when this table sits *beneath* another one in the same section, so
   * a reader can tell where the providers stop and the policy starts. Omitted
   * when the section's own `h3` already names it. */
  heading?: string;
}) {
  const columns: Column<Fact>[] = [
    { key: "label", label: "Setting", width: "22%", cell: (row) => row.label },
    {
      key: "value",
      label: "Value",
      width: "24%",
      cell: (row) => <span className={css.name}>{row.value}</span>,
    },
    {
      key: "why",
      label: "Why",
      width: "54%",
      /* One line, clamped; the whole sentence is the tooltip and stays in the DOM for
         a screen reader. Below 640px it wraps again, where there is no hover to reach it. */
      cell: (row) => (
        <span className={css.why} title={row.why}>
          {row.why}
        </span>
      ),
    },
  ];
  return (
    <>
      {heading ? <h3 className={css.subHeading}>{heading}</h3> : null}
      <Table label={label} columns={columns} rows={rows} rowKey={(row) => row.label} />
    </>
  );
}
