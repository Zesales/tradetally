const HIDDEN_SYNTHETIC_EXECUTION_REASONS = new Set([
  'missing-entry-coverage',
  'missing-entry-reconciliation'
])

export function shouldHideSyntheticExecution(execution) {
  return execution?.synthetic === true
    && HIDDEN_SYNTHETIC_EXECUTION_REASONS.has(String(execution?.syntheticReason || ''))
}

export function normalizeTradeExecutions(trade, options = {}) {
  const { includeTradeFallback = true } = options

  if (!Array.isArray(trade?.executions) || trade.executions.length === 0) {
    if (!includeTradeFallback) {
      return []
    }

    return [{
      type: trade?.exit_price ? 'exit' : 'entry',
      quantity: parseFloat(trade?.quantity) || 0,
      price: parseFloat(trade?.exit_price || trade?.entry_price),
      datetime: trade?.exit_time || trade?.entry_time || trade?.trade_date,
      pnl: trade?.pnl,
      tradeId: trade?.id || null,
      tradeDate: trade?.exit_time || trade?.entry_time || trade?.trade_date
    }]
  }

  return trade.executions
    .filter(execution => !shouldHideSyntheticExecution(execution))
    .filter(execution => (parseFloat(execution?.quantity) || 0) > 0)
    .map(execution => ({
      ...execution,
      type: String(execution?.type || '').toLowerCase() === 'exit' ? 'exit' : 'entry',
      quantity: parseFloat(execution?.quantity) || 0,
      price: parseFloat(execution?.price),
      datetime: execution?.datetime || trade?.entry_time || trade?.trade_date,
      tradeId: trade?.id || null,
      tradeDate: execution?.datetime || trade?.entry_time || trade?.trade_date
    }))
}

export function buildPositionTimelineRows(trades = []) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return []
  }

  const details = trades.flatMap((trade, tradeIndex) => {
    const executions = normalizeTradeExecutions(trade, { includeTradeFallback: false })

    if (executions.length === 0) {
      return [{
        id: `${trade?.id || tradeIndex}-trade`,
        label: `Trade ${tradeIndex + 1}`,
        quantity: parseFloat(trade?.quantity) || 0,
        signedQuantity: parseFloat(trade?.quantity) || 0,
        price: parseFloat(trade?.entry_price) || null,
        totalCost: (parseFloat(trade?.entry_price) || 0) * (parseFloat(trade?.quantity) || 0),
        tradeDate: trade?.entry_time || trade?.trade_date,
        type: 'entry',
        tradeId: trade?.id || null,
        side: trade?.side || 'long'
      }]
    }

    let entryIndex = 0
    let exitIndex = 0

    return executions.map((execution, executionIndex) => {
      const normalizedType = execution.type === 'exit' ? 'exit' : 'entry'
      const quantity = parseFloat(execution?.quantity) || 0
      const signedQuantity = normalizedType === 'exit' ? -quantity : quantity
      const price = parseFloat(execution?.price)

      if (normalizedType === 'exit') {
        exitIndex += 1
      } else {
        entryIndex += 1
      }

      return {
        id: `${trade?.id || tradeIndex}-execution-${executionIndex}`,
        label: `${normalizedType === 'exit' ? 'Exit' : 'Entry'} ${normalizedType === 'exit' ? exitIndex : entryIndex}`,
        quantity,
        signedQuantity,
        price: Number.isFinite(price) ? price : null,
        totalCost: Number.isFinite(price) ? signedQuantity * price : 0,
        tradeDate: execution?.tradeDate || execution?.datetime || trade?.entry_time || trade?.trade_date,
        type: normalizedType,
        tradeId: trade?.id || null,
        side: trade?.side || 'long'
      }
    })
  })

  const sorted = [...details].sort((left, right) => {
    const leftTime = new Date(left.tradeDate || 0).getTime()
    const rightTime = new Date(right.tradeDate || 0).getTime()
    if (leftTime !== rightTime) {
      return leftTime - rightTime
    }

    return String(left.id).localeCompare(String(right.id))
  })

  let runningQuantity = 0
  return sorted.map(detail => {
    runningQuantity += detail.signedQuantity || 0
    return {
      ...detail,
      runningQuantity
    }
  })
}

export function buildPositionDetailSummary(details = []) {
  if (!Array.isArray(details) || details.length === 0) {
    return '0 entries'
  }

  const entryCount = details.filter(detail => detail.type === 'entry').length
  const exitCount = details.filter(detail => detail.type === 'exit').length

  if (exitCount === 0) {
    return `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`
  }

  if (entryCount === 0) {
    return `${exitCount} ${exitCount === 1 ? 'exit' : 'exits'}`
  }

  return `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}, ${exitCount} ${exitCount === 1 ? 'exit' : 'exits'}`
}

export function calculateRealizedPositionStats(trades = [], side = 'long') {
  const executions = trades
    .flatMap(trade => normalizeTradeExecutions(trade, { includeTradeFallback: false }))
    .sort((left, right) => new Date(left.datetime || 0) - new Date(right.datetime || 0))

  let openQuantity = 0
  let openCostBasis = 0
  let realizedPnl = 0
  let realizedExitCount = 0

  for (const execution of executions) {
    if (!Number.isFinite(execution.quantity) || execution.quantity <= 0) {
      continue
    }

    if (execution.type === 'entry') {
      if (!Number.isFinite(execution.price)) {
        continue
      }

      openCostBasis += execution.quantity * execution.price
      openQuantity += execution.quantity
      continue
    }

    realizedExitCount += 1

    const explicitRealized = parseFloat(execution.realizedPnl ?? execution.realizedPNL ?? execution.pnl)
    if (Number.isFinite(explicitRealized)) {
      realizedPnl += explicitRealized
    } else if (openQuantity > 0 && Number.isFinite(execution.price)) {
      const closeQuantity = Math.min(execution.quantity, openQuantity)
      const averageEntry = openCostBasis / openQuantity
      realizedPnl += side === 'short'
        ? (averageEntry - execution.price) * closeQuantity
        : (execution.price - averageEntry) * closeQuantity
    }

    if (openQuantity > 0) {
      const closeQuantity = Math.min(execution.quantity, openQuantity)
      const averageEntry = openCostBasis / openQuantity
      openCostBasis -= averageEntry * closeQuantity
      openQuantity -= closeQuantity
    }
  }

  return {
    realizedPnl,
    realizedExitCount
  }
}
