export function toPositionRouteId(positionId) {
  const normalized = String(positionId || '')
  if (!normalized) return ''

  if (normalized.startsWith('position-')) {
    return normalized.slice('position-'.length)
  }

  return normalized
}

export function toInternalPositionId(routeId) {
  const normalized = String(routeId || '')
  if (!normalized) return ''

  if (normalized.startsWith('position-') || normalized.startsWith('trade-')) {
    return normalized
  }

  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (uuidLike.test(normalized)) {
    return `position-${normalized}`
  }

  return normalized
}
