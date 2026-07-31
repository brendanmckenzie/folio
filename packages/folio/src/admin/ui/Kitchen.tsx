import { useCallback, useState } from 'react'
import '../ui/tokens.css'
import css from './Kitchen.module.css'
import {
  Badge,
  Button,
  type Column,
  Dialog,
  EmptyState,
  Field,
  Input,
  List,
  ListHeader,
  Menu,
  Palette,
  type PaletteAction,
  Row,
  SAVE_NOTICE,
  scoped,
  Select,
  type Sort,
  Table,
  Textarea,
  Toast,
  useShortcuts,
} from './index'

/**
 * Every primitive, in both themes, next to a mock of the shell they will build.
 *
 * This exists because `docs/design-system.md` decided the spike is the
 * foundation rather than a mockup: the tokens and components here are the real
 * ones, so nothing is thrown away when screen ports begin. Reachable in dev at
 * `{base}/edit/<any id>?_ui` until the router lands, at which point it becomes a
 * screen of its own and this comment goes with it.
 */

interface Person {
  id: string
  name: string
  role: string
  joined: string
  state: 'draft' | 'live' | 'changed'
}

const PEOPLE: Person[] = [
  {
    id: 'p1',
    name: 'Ada Lovelace',
    role: 'Analytical engines',
    joined: '2019-04-01',
    state: 'live',
  },
  { id: 'p2', name: 'Grace Hopper', role: 'Compilers', joined: '2020-11-12', state: 'changed' },
  { id: 'p3', name: 'Alan Turing', role: 'Decidability', joined: '2021-02-03', state: 'draft' },
  {
    id: 'p4',
    name: 'Katherine Johnson',
    role: 'Orbital mechanics',
    joined: '2022-07-19',
    state: 'live',
  },
]

const COLUMNS: Column<Person>[] = [
  { key: 'name', label: 'Full name', sortable: true, cell: (p) => p.name },
  { key: 'role', label: 'Role', sortable: true, cell: (p) => p.role },
  {
    key: 'state',
    label: 'Status',
    cell: (p) =>
      p.state === 'live' ? null : (
        <Badge tone={p.state === 'changed' ? 'accent' : 'neutral'}>
          {p.state === 'changed' ? 'unpublished changes' : 'draft'}
        </Badge>
      ),
  },
  { key: 'joined', label: 'Joined', sortable: true, numeric: true, cell: (p) => p.joined },
]

/**
 * `slug` as well as `path`, because the row shows the slug and the palette shows
 * the path: inside a tree the indent already carries the ancestry, so repeating
 * it per row spends the width that made the path truncate to `/showc…` in the
 * first place.
 */
const TREE = [
  { id: 't1', title: 'Home', slug: '/', path: '/', depth: 0, state: null },
  { id: 't2', title: 'About', slug: 'about', path: '/about', depth: 0, state: 'draft' as const },
  {
    id: 't3',
    title: 'Our team',
    slug: 'team',
    path: '/about/team',
    depth: 1,
    state: 'changed' as const,
  },
  {
    id: 't4',
    title: 'Field types',
    slug: 'showcase',
    path: '/showcase',
    depth: 0,
    state: null,
  },
  {
    id: 't5',
    title: 'A referenced page',
    slug: 'reference-target',
    path: '/showcase/reference-target',
    depth: 1,
    state: 'unpublished' as const,
  },
]

const TONES = [
  { tone: 'neutral' as const, label: 'draft', why: 'the normal state of new content' },
  { tone: 'accent' as const, label: 'unpublished changes', why: 'a look-here, not a problem' },
  { tone: 'danger' as const, label: 'not live', why: 'withdrawal and refusal' },
  { tone: 'warn' as const, label: 'behind the model', why: 'drift and history' },
  { tone: 'ok' as const, label: '6/6 translated', why: 'completeness' },
]

type Theme = 'system' | 'light' | 'dark'

export function Kitchen() {
  const [theme, setTheme] = useState<Theme>('system')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dialog, setDialog] = useState<'none' | 'confirm' | 'wide'>('none')
  const [notice, setNotice] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' })
  const [selected, setSelected] = useState('t3')

  const openPalette = useCallback(() => setPaletteOpen(true), [])

  const say = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 2400)
  }

  /**
   * The whole keyboard surface, as a map. `?` demonstrates the bare-chord rule:
   * it fires from anywhere except a field, so typing a question mark into Title
   * does not open help. `mod+s` demonstrates the opposite — it fires even inside
   * a field, because the browser dialog it suppresses does too.
   */
  useShortcuts({
    'mod+k': openPalette,
    'mod+s': () => say(SAVE_NOTICE),
    '?': () => say('The shortcut map would open here'),
  })

  /**
   * Actions as data, which is the whole point of the shape: this same list feeds
   * the palette below and would feed a menu and a shortcut map unchanged.
   */
  const actions: PaletteAction[] = [
    ...TREE.map((node) => ({
      id: node.id,
      label: node.title,
      group: 'Pages',
      hint: node.path,
      keywords: node.path,
      run: () => say(`Would open ${node.title}`),
    })),
    ...PEOPLE.map((person) => ({
      id: person.id,
      label: person.name,
      group: 'People',
      hint: person.role,
      keywords: `person record ${person.role}`,
      run: () => say(`Would open ${person.name}`),
    })),
    { id: 'c1', label: 'Publish', group: 'Commands', hint: '⌘S', run: () => say('Would publish') },
    {
      id: 'c2',
      label: 'Go to content',
      group: 'Commands',
      hint: 'g c',
      run: () => say('Would go to content'),
    },
    {
      id: 'c3',
      label: 'Go to assets',
      group: 'Commands',
      hint: 'g a',
      run: () => say('Would go to assets'),
    },
    {
      id: 'c4',
      label: 'Toggle dark mode',
      group: 'Commands',
      keywords: 'theme appearance',
      run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    },
  ]

  const sorted = [...PEOPLE].sort((a, b) => {
    const key = sort.key as keyof Person
    const order = String(a[key]).localeCompare(String(b[key]))
    return sort.dir === 'asc' ? order : -order
  })

  return (
    <div className={scoped(css.page)} data-theme={theme === 'system' ? undefined : theme}>
      <header className={css.bar}>
        <strong>Folio</strong>
        <span className={css.slug}>design system</span>
        <div className={css.barRight}>
          <Button size="sm" onClick={openPalette}>
            Search <kbd>⌘K</kbd>
          </Button>
          <Menu
            align="end"
            trigger={`Theme: ${theme}`}
            items={[
              { id: 'system', label: 'Follow the system', run: () => setTheme('system') },
              { id: 'light', label: 'Light', run: () => setTheme('light') },
              { id: 'dark', label: 'Dark', run: () => setTheme('dark') },
            ]}
          />
          <Button variant="primary" size="sm" onClick={() => say('Published')}>
            Publish
          </Button>
        </div>
      </header>

      <div className={css.body}>
        {/* The rail, at its real width, holding a real tree. Density is the thing
            to judge here: 28px rows, 16px indent, and no per-row type chip. */}
        <aside className={css.rail}>
          <ListHeader
            actions={
              <Button size="sm" variant="subtle">
                + New
              </Button>
            }
          >
            Pages
          </ListHeader>
          <List label="Pages">
            {TREE.map((node) => (
              <Row
                key={node.id}
                depth={node.depth}
                selected={selected === node.id}
                handle="⋮⋮"
                meta={node.slug}
                trailing={
                  node.state === 'draft' ? (
                    <Badge>draft</Badge>
                  ) : node.state === 'changed' ? (
                    <Badge tone="accent">changes</Badge>
                  ) : node.state === 'unpublished' ? (
                    <Badge tone="danger">not live</Badge>
                  ) : null
                }
                actions={
                  <>
                    <Button size="sm" variant="subtle" title="Duplicate">
                      ⧉
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      title="Delete"
                      onClick={() => setDialog('confirm')}
                    >
                      ×
                    </Button>
                  </>
                }
                onOpen={() => setSelected(node.id)}
              >
                {node.title}
              </Row>
            ))}
          </List>
        </aside>

        <main className={css.main}>
          <section className={css.section}>
            <h1 className={css.h1}>Primitives</h1>
            <p className={css.lede}>
              Eleven, fixed. Everything below is the real component — nothing here is a mock, and
              nothing is thrown away when the screen ports begin.
            </p>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Buttons</h2>
            <div className={css.strip}>
              <Button variant="primary">Publish</Button>
              <Button>Cancel</Button>
              <Button variant="subtle">Subtle</Button>
              <Button variant="danger">Delete</Button>
              <Button disabled reason="Your role may not publish">
                Disabled, with a reason
              </Button>
            </div>
            <div className={css.strip}>
              <Button size="sm" variant="primary">
                Small
              </Button>
              <Button size="sm">Small</Button>
              <Button size="sm" variant="subtle">
                Small
              </Button>
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>The state palette</h2>
            <p className={css.lede}>
              One hue, one meaning. Ten states used to speak in eight hand-mixed amber tints.
            </p>
            <div className={css.tones}>
              {TONES.map((t) => (
                <div key={t.label} className={css.tone}>
                  <Badge tone={t.tone}>{t.label}</Badge>
                  <span className={css.toneWhy}>{t.why}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Fields</h2>
            <div className={css.form}>
              <Field label="Title" required help="Shown in the tree and in search results.">
                {(id) => <Input id={id} defaultValue="Our team" />}
              </Field>
              <Field
                label="Slug"
                note="shared across locales"
                help="Renaming updates every page beneath this one."
              >
                {(id) => <Input id={id} defaultValue="team" />}
              </Field>
              <Field label="Parent page">
                {(id) => (
                  <Select id={id} defaultValue="about">
                    <option value="">— Top level —</option>
                    <option value="about">About</option>
                  </Select>
                )}
              </Field>
              <Field label="Meta description" error="Longer than 160 characters.">
                {(id) => <Textarea id={id} defaultValue="Every Folio field type on one page." />}
              </Field>
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Table</h2>
            <div className={css.panel}>
              <Table
                label="People"
                columns={COLUMNS}
                rows={sorted}
                rowKey={(p) => p.id}
                currentKey="p2"
                sort={sort}
                onSort={(key) =>
                  setSort((prev) => ({
                    key,
                    dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc',
                  }))
                }
                onOpen={(p) => say(`Would open ${p.name}`)}
                actions={(p) => (
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => say(`Would duplicate ${p.name}`)}
                  >
                    ⧉
                  </Button>
                )}
              />
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Overlays</h2>
            <div className={css.strip}>
              <Button onClick={() => setDialog('confirm')}>Confirmation dialog</Button>
              <Button onClick={() => setDialog('wide')}>Wide dialog</Button>
              <Button onClick={openPalette}>Command palette</Button>
              <Menu
                trigger="Menu"
                align="start"
                items={[
                  { id: 'm1', label: 'Duplicate', run: () => say('Would duplicate') },
                  { id: 'm2', label: 'Unpublish…', run: () => say('Would unpublish') },
                  { id: 'm3', label: 'Delete', danger: true, run: () => setDialog('confirm') },
                  {
                    id: 'm4',
                    label: 'Restore',
                    disabled: true,
                    reason: 'Nothing to restore',
                    run: () => {},
                  },
                ]}
              />
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Empty state</h2>
            <div className={css.panel}>
              <EmptyState
                title="No redirects yet"
                body="Renaming or moving a page writes one automatically. You can add one by hand too."
                action={<Button variant="primary">Add a redirect</Button>}
              />
            </div>
          </section>

          <section className={css.section}>
            <h2 className={css.h2}>Type and space</h2>
            <div className={css.specimens}>
              <p className={css.xl}>--text-xl · 20px · one screen title</p>
              <p className={css.lg}>--text-lg · 15px · panel and dialog titles</p>
              <p className={css.base}>--text-base · 13px · rows, inputs, buttons, menus</p>
              <p className={css.sm}>--text-sm · 12px · labels, help, table cells</p>
              <p className={css.xs}>--TEXT-XS · 11PX · MICRO-HEADERS AND BADGES</p>
              <p className={css.mono}>
                --font-mono · /about/team · sty_b33cb28bd08e · content:write
              </p>
            </div>
            <div className={css.scale}>
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <div key={step} className={css.scaleRow}>
                  <span className={css.scaleLabel}>--space-{step}</span>
                  <span className={css.scaleBar} style={{ width: `var(--space-${step})` }} />
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>

      {dialog === 'confirm' ? (
        <Dialog
          title="Delete /about/team?"
          description="This cannot be undone."
          onClose={() => setDialog('none')}
          actions={
            <>
              <Button onClick={() => setDialog('none')}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setDialog('none')
                  say('Would delete')
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <label className={css.check}>
            <input type="checkbox" defaultChecked /> Redirect <code>/about/team</code> to{' '}
            <code>/about</code>
          </label>
        </Dialog>
      ) : dialog === 'wide' ? (
        <Dialog
          title="Media library"
          size="wide"
          onClose={() => setDialog('none')}
          actions={<Button onClick={() => setDialog('none')}>Close</Button>}
        >
          <EmptyState
            title="A grid goes here"
            body="Wide is for a picker rather than a question. The library becomes a screen of its own, not a modal — this size exists for the pickers that stay modal."
          />
        </Dialog>
      ) : null}

      {paletteOpen ? <Palette actions={actions} onClose={() => setPaletteOpen(false)} /> : null}
      <Toast message={notice} />
    </div>
  )
}
