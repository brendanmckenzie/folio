import './admin.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type DocumentType, indexManifest, type Manifest, type SchemaIndex } from '../core/schema'
import { onUnauthorized, signInUrl } from './api'
import { Editor } from './Editor'
import { fetchMe, type Me, OPEN } from './me'

/**
 * Injected by the server route. The admin is a prebuilt, project-agnostic
 * bundle: everything it knows about a project's blocks arrives over HTTP.
 */
interface Boot {
  storyId: string
  apiBase: string
}

declare global {
  interface Window {
    __FOLIO_ADMIN__?: Boot
  }
}

/** The manifest, split into what the panels actually consume. */
interface Loaded {
  schema: SchemaIndex
  /** Every declared document type (`document-types.md`). Never empty: the
   * server refuses to construct without one. */
  types: DocumentType[]
  /** `FolioConfig.globals` (`content-model/globals.md`). */
  globals: string[]
}

function App({ boot }: { boot: Boot }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [me, setMe] = useState<Me>(OPEN)
  const [error, setError] = useState<string | null>(null)

  /**
   * The manifest and the actor, together, before anything renders.
   *
   * Together because the editor's whole shape depends on both: a role decides
   * whether the inspector is read-only, whether Publish is offered and whether
   * the Access rail exists at all, and rendering it once as an editor and then
   * again as a viewer is worse than a moment of "Loading". `/folio/schema` is
   * ungated, so it answers even when `/folio/me` says nobody is signed in — which
   * is what lets the sign-in prompt below be a Folio page rather than a blank one.
   */
  useEffect(() => {
    Promise.all([
      fetch(`${boot.apiBase}/schema`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`schema ${r.status}`)),
      ),
      fetchMe(boot.apiBase),
    ])
      .then(([m, who]) => {
        const manifest = m as Manifest
        setLoaded({
          schema: indexManifest(manifest),
          types: manifest.types ?? [],
          globals: manifest.globals ?? [],
        })
        setMe(who)
      })
      .catch((e: Error) => setError(e.message))
  }, [boot.apiBase])

  // The one place a 401 from any mutating call becomes a navigation rather than a
  // toast (`identity-and-access.md` phase 4, step 1). Registered per api base,
  // and only where there is a login page to go to.
  useEffect(() => {
    if (me.mode !== 'session' || !me.loginUrl) return
    onUnauthorized(() => {
      const next = `${window.location.pathname}${window.location.search}`
      window.location.assign(signInUrl(me.loginUrl, next))
    })
    return () => onUnauthorized(null)
  }, [me.loginUrl, me.mode])

  if (error) {
    return (
      <div className="boot">
        <p>Could not load the block schema: {error}</p>
      </div>
    )
  }
  if (!loaded) {
    return (
      <div className="boot">
        <p>Loading schema…</p>
      </div>
    )
  }
  // Reachable when a session expires between the HTML route's own check and this
  // fetch — rare, but the alternative is an editor rendered for nobody, whose
  // every request 401s.
  if (me.mode === 'session' && me.actor === null) {
    return (
      <div className="boot">
        <p>Your session has ended.</p>
        <p>
          <a href={me.loginUrl}>Sign in again</a>
        </p>
      </div>
    )
  }
  return (
    <Editor
      storyId={boot.storyId}
      schema={loaded.schema}
      types={loaded.types}
      globals={loaded.globals}
      me={me}
      apiBase={boot.apiBase}
    />
  )
}

const boot = window.__FOLIO_ADMIN__
const el = document.getElementById('folio-admin')
if (boot && el) {
  createRoot(el).render(
    <StrictMode>
      <App boot={boot} />
    </StrictMode>,
  )
}
