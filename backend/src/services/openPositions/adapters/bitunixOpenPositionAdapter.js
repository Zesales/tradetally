class BitunixOpenPositionAdapter {
  static getExecutionMeta(trade, executionType = 'entry') {
    if (!Array.isArray(trade?.executions)) {
      return null;
    }

    return trade.executions.find(execution =>
      String(execution?.type || '').toLowerCase() === executionType
    ) || null;
  }

  static getExecutionTotals(trade) {
    if (!Array.isArray(trade?.executions)) {
      return null;
    }

    return trade.executions.reduce((acc, execution) => {
      const quantity = Math.abs(parseFloat(execution?.quantity) || 0);
      const type = String(execution?.type || '').toLowerCase();
      const action = String(execution?.action || execution?.side || '').toLowerCase();

      const isEntryAction = trade.side === 'short'
        ? (action === 'sell' || action === 'short')
        : (action === 'buy' || action === 'long');
      const isExitAction = trade.side === 'short'
        ? (action === 'buy' || action === 'long')
        : (action === 'sell' || action === 'short');

      if (type === 'entry' || isEntryAction) {
        acc.entryQty += quantity;

        const explicitMarginUsed = parseFloat(execution?.marginUsed);
        if (Number.isFinite(explicitMarginUsed) && explicitMarginUsed > 0) {
          acc.entryMarginUsed += explicitMarginUsed;
          acc.entryMarginSamples += 1;
        }
      } else if (type === 'exit' || isExitAction) {
        acc.exitQty += quantity;
      }

      return acc;
    }, {
      entryQty: 0,
      exitQty: 0,
      entryMarginUsed: 0,
      entryMarginSamples: 0
    });
  }

  static getMarginCost(trade) {
    if (trade?.broker !== 'bitunix') {
      return null;
    }

    const totals = this.getExecutionTotals(trade);
    if (totals && totals.entryQty > 0 && totals.entryMarginSamples > 0) {
      const remainingQty = Math.max(totals.entryQty - totals.exitQty, 0);
      if (remainingQty > 0) {
        return totals.entryMarginUsed * (remainingQty / totals.entryQty);
      }
    }

    const referenceExecution = this.getExecutionMeta(trade, 'entry')
      || this.getExecutionMeta(trade, 'exit');

    const explicitMargin = parseFloat(referenceExecution?.marginUsed);
    if (Number.isFinite(explicitMargin) && explicitMargin > 0) {
      return explicitMargin;
    }

    const leverage = parseFloat(referenceExecution?.leverage);
    const notionalValue = parseFloat(referenceExecution?.notionalValue);
    if (Number.isFinite(leverage) && leverage > 0) {
      if (Number.isFinite(notionalValue) && notionalValue > 0) {
        return notionalValue / leverage;
      }

      const fallbackNotional = (parseFloat(trade?.entry_price) || 0) * (parseFloat(trade?.quantity) || 0);
      if (fallbackNotional > 0) {
        return fallbackNotional / leverage;
      }
    }

    return null;
  }
}

module.exports = BitunixOpenPositionAdapter;
