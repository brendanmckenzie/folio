import './preview.css'
import { useEffect, useState } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { toRegistry, type AnyBlockDef, type Registry } from '../core/block'
import type { Doc } from '../core/doc'
import { applyAll, type Mutation } from '../core/mutations'
import { EMPTY_RESOLUTION, type Resolution } from '../core/resolve'
import { FolioDoc } from './Render'

declare global {
  interface Window {
    __FOLIO__?: { doc: Doc; resolution?: Resolution }
  }
}

type FromAdmin =
  | { type: 'apply'; mutations: Mutation[] }
  | { type: 'replace'; doc: Doc }
  | { type: 'select'; uid: string | null }
  /** Story structure changed, so ids may now resolve to different URLs. */
  | { type: 'resolve'; resolution: Resolution }

function post(msg: Record<string, unknown>) {
  window.parent?.postMessage({ source: 'folio-preview', ...msg }, window.location.origin)
}

function PreviewApp({
  initial,
  initialResolution,
  registry,
}: {
  initial: Doc
  initialResolution: Resolution
  registry: Registry
}) {
  const [doc, setDoc] = useState(initial)
  const [resolution, setResolution] = useState(initialResolution)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const msg = e.data as ({ source?: string } & FromAdmin) | null
      if (msg?.source !== 'folio-admin') return

      switch (msg.type) {
        case 'apply':
          // The whole point: no network, no page reload. The same reducer the
          // admin ran, against the same document.
          setDoc((d) => applyAll(d, msg.mutations))
          break
        case 'replace':
          setDoc(msg.doc)
          break
        case 'resolve':
          setResolution(msg.resolution)
          break
        case 'select':
          markSelected(msg.uid)
          break
      }
    }
    window.addEventListener('message', onMessage)
    post({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return <FolioDoc doc={doc} registry={registry} edit resolution={resolution} />
}

function markSelected(uid: string | null) {
  for (const el of document.querySelectorAll('[data-folio-selected]')) {
    el.removeAttribute('data-folio-selected')
  }
  if (!uid) return
  const el = document.querySelector(`[data-folio-uid="${CSS.escape(uid)}"]`)
  if (!el) return
  el.setAttribute('data-folio-selected', '')
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/**
 * Delegated listeners, attached once outside React so the server-rendered
 * markup stays free of per-element handlers.
 */
function attachBridge() {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null
      const slot = target?.closest<HTMLElement>('[data-folio-slot]')
      if (slot) {
        e.preventDefault()
        post({ type: 'add', parent: slot.dataset.folioParent, slot: slot.dataset.folioSlot })
        return
      }
      const block = target?.closest<HTMLElement>('[data-folio-uid]')
      if (!block) return
      // Links inside the preview must not navigate while editing.
      e.preventDefault()
      const uid = block.dataset.folioUid!
      markSelected(uid)
      post({ type: 'select', uid })
    },
    true,
  )

  let hovered: Element | null = null
  document.addEventListener('mouseover', (e) => {
    const block = (e.target as Element | null)?.closest('[data-folio-uid]') ?? null
    if (block === hovered) return
    hovered?.removeAttribute('data-folio-hover')
    hovered = block
    hovered?.setAttribute('data-folio-hover', '')
  })
  document.addEventListener('mouseleave', () => {
    hovered?.removeAttribute('data-folio-hover')
    hovered = null
  })
}

/**
 * Called by the preview entry that `folio/vite` generates, with the project's
 * own blocks. This is the one client bundle that needs your components.
 */
export function mountPreview(blocks: readonly AnyBlockDef[] | Registry) {
  const boot = window.__FOLIO__
  const root = document.getElementById('folio-root')
  if (!boot || !root) return
  hydrateRoot(
    root,
    <PreviewApp
      initial={boot.doc}
      initialResolution={boot.resolution ?? EMPTY_RESOLUTION}
      registry={toRegistry(blocks)}
    />,
  )
  attachBridge()
}
