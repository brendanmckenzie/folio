import './admin.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { indexManifest, type Manifest, type SchemaIndex } from '../core/schema'
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

function App({ boot }: { boot: Boot }) {
  const [schema, setSchema] = useState<SchemaIndex | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${boot.apiBase}/schema`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`schema ${r.status}`))))
      .then((m) => setSchema(indexManifest(m as Manifest)))
      .catch((e: Error) => setError(e.message))
  }, [boot.apiBase])

  if (error) {
    return (
      <div className="boot">
        <p>Could not load the block schema: {error}</p>
      </div>
    )
  }
  if (!schema) {
    return (
      <div className="boot">
        <p>Loading schema…</p>
      </div>
    )
  }
  return <Editor storyId={boot.storyId} schema={schema} apiBase={boot.apiBase} />
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
