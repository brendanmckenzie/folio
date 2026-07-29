import './preview.css'
import { useEffect, useState } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { toRegistry, type AnyBlockDef, type Registry } from '../core/block'
import type { Doc } from '../core/doc'
import { applyAll } from '../core/mutations'
import {
  isPreviewMsg,
  PROTOCOL_VERSION,
  type PreviewFrame,
  type PreviewToAdminMsg,
} from '../core/protocol'
import { EMPTY_RESOLUTION, type Resolution } from '../core/resolve'
import { FolioDoc } from './Render'

declare global {
  interface Window {
    __FOLIO__?: {
      doc: Doc
      resolution?: Resolution
      /**
       * Present only when editing a global in the context of a host page
       * (`../../../docs/specs/content-model/globals.md` decision 4): `doc`
       * above is then the *global's* own draft, not the page's, and `mount`
       * names the wrapper `renderGlobal` already rendered server-side for it
       * — the same markup in both modes, so hydrating into it is a plain
       * `hydrateRoot`, not a rebuild. `#folio-root` stays static in this mode.
       */
      editing?: { global: string; mount: string }
    }
  }
}

function post(msg: PreviewToAdminMsg) {
  window.parent?.postMessage(
    { source: 'folio-preview', v: PROTOCOL_VERSION, ...msg },
    // Same-origin is a hard requirement, not a courtesy check — see
    // core/protocol.ts. A preview whose `previewUrl` lands on a different
    // origin than the admin does not degrade, it just never gets here.
    window.location.origin,
  )
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
      // Same hardening as the admin's side of this seam (see usePreviewBridge):
      // origin alone only proves the sender is same-origin, not that it is the
      // parent frame this preview was embedded in.
      if (e.source !== window.parent) return
      const data = e.data as Partial<PreviewFrame> | null
      if (data?.source !== 'folio-admin') return
      if (!isPreviewMsg(data)) return
      const msg = data

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
        const { folioParent: parent, folioSlot } = slot.dataset
        // Both attributes are set together wherever a slot is rendered
        // (see Render.tsx); a slot missing either is not a message worth
        // sending rather than one worth sending malformed.
        if (parent && folioSlot) post({ type: 'add', parent, slot: folioSlot })
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
  if (!boot) return
  // Editing a global in context (`editing.mount`) hydrates its own wrapper
  // instead of `#folio-root`; the page around it stays static server-rendered
  // markup with no React root of its own (`globals.md` decision 4).
  const root = boot.editing
    ? document.querySelector(boot.editing.mount)
    : document.getElementById('folio-root')
  if (!root) return
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
