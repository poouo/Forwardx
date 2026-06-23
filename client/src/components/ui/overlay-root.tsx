import * as React from "react"

const OVERLAY_ROOT_ID = "forwardx-overlay-root"

function getExistingOverlayRoot() {
  if (typeof document === "undefined") return null
  return document.getElementById(OVERLAY_ROOT_ID) as HTMLElement | null
}

export function ensureOverlayRoot() {
  if (typeof document === "undefined") return null
  const existing = getExistingOverlayRoot()
  if (existing) return existing

  const root = document.createElement("div")
  root.id = OVERLAY_ROOT_ID
  root.setAttribute("data-forwardx-overlay-root", "")
  document.body.appendChild(root)
  return root
}

export function useOverlayContainer() {
  const [container, setContainer] = React.useState<HTMLElement | null>(() => getExistingOverlayRoot())

  React.useLayoutEffect(() => {
    setContainer(ensureOverlayRoot())
  }, [])

  return container ?? undefined
}
