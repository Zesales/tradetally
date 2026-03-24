import { toPositionRouteId } from './positionRoute'

export function buildPositionsListRoute(options = {}) {
  const { symbol = null, status = null, query = {} } = options

  const nextQuery = {
    ...query,
    view: 'positions'
  }

  if (symbol) {
    nextQuery.symbol = symbol
    nextQuery.symbolExact = 'true'
  } else {
    delete nextQuery.symbol
    delete nextQuery.symbolExact
  }

  if (status) {
    nextQuery.status = status
  } else {
    delete nextQuery.status
  }

  return {
    name: 'trades',
    query: nextQuery
  }
}

export function buildPositionDetailRoute(positionId) {
  return {
    name: 'position-detail',
    params: { id: toPositionRouteId(positionId) }
  }
}
