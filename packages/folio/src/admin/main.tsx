import './admin.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type DocumentType, indexManifest, type Manifest, type SchemaIndex } from '../core/schema'
import { Editor } from './Editor'

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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${boot.apiBase}/schema`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`schema ${r.status}`))))
      .then((m) => {
        const manifest = m as Manifest
        setLoaded({
          schema: indexManifest(manifest),
          types: manifest.types ?? [],
          globals: manifest.globals ?? [],
        })
      })
      .catch((e: Error) => setError(e.message))
  }, [boot.apiBase])

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
  return (
    <Editor
      storyId={boot.storyId}
      schema={loaded.schema}
      types={loaded.types}
      globals={loaded.globals}
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
