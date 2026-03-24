class ClosedPositionAggregationService {
  static toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  static toTimestamp(value) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  static buildPositionRow(trades = []) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return null;
    }

    const firstTrade = trades[0];
    let totalQuantity = 0;
    let totalEntryValue = 0;
    let totalExitValue = 0;
    let totalPnl = 0;
    let totalCommission = 0;
    let totalFees = 0;
    let earliestEntry = firstTrade.entry_time || null;
    let latestExit = firstTrade.exit_time || null;
    const tagSet = new Set();
    const brokers = new Set();
    const accounts = new Set();

    for (const trade of trades) {
      const quantity = Math.abs(this.toNumber(trade.quantity));
      const entryPrice = this.toNumber(trade.entry_price);
      const exitPrice = this.toNumber(trade.exit_price);

      totalQuantity += quantity;
      totalEntryValue += quantity * entryPrice;
      totalExitValue += quantity * exitPrice;
      totalPnl += this.toNumber(trade.pnl);
      totalCommission += this.toNumber(trade.commission);
      totalFees += this.toNumber(trade.fees);

      if (!earliestEntry || this.toTimestamp(trade.entry_time) < this.toTimestamp(earliestEntry)) {
        earliestEntry = trade.entry_time || earliestEntry;
      }

      if (!latestExit || this.toTimestamp(trade.exit_time) > this.toTimestamp(latestExit)) {
        latestExit = trade.exit_time || latestExit;
      }

      if (Array.isArray(trade.tags)) {
        trade.tags.forEach(tag => tag && tagSet.add(tag));
      }

      if (trade.broker) {
        brokers.add(trade.broker);
      }

      if (trade.account_identifier) {
        accounts.add(trade.account_identifier);
      }
    }

    const totalCost = totalEntryValue;
    const avgEntryPrice = totalQuantity > 0 ? totalEntryValue / totalQuantity : 0;
    const avgExitPrice = totalQuantity > 0 ? totalExitValue / totalQuantity : 0;

    return {
      ...firstTrade,
      id: firstTrade.positionRouteId || firstTrade.id,
      positionRouteId: firstTrade.positionRouteId || firstTrade.id,
      entry_time: earliestEntry,
      exit_time: latestExit,
      quantity: totalQuantity,
      entry_price: avgEntryPrice,
      exit_price: avgExitPrice || null,
      total_cost: totalCost,
      pnl: totalPnl,
      pnl_percent: totalCost > 0 ? (totalPnl / totalCost) * 100 : null,
      commission: totalCommission || null,
      fees: totalFees || null,
      tags: Array.from(tagSet),
      broker: brokers.size === 1 ? Array.from(brokers)[0] : firstTrade.broker,
      account_identifier: accounts.size === 1 ? Array.from(accounts)[0] : firstTrade.account_identifier,
      comment_count: null,
      tradeCount: trades.length,
      tradeIds: trades.map(trade => trade.id).filter(Boolean),
      isAggregatedPosition: true,
      status: 'closed'
    };
  }

  static aggregate(trades = []) {
    const groups = new Map();

    for (const trade of trades) {
      const key = trade?.positionRouteId || trade?.id;
      if (!key) {
        continue;
      }

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      groups.get(key).push(trade);
    }

    return Array.from(groups.values())
      .map(group => this.buildPositionRow(group))
      .filter(Boolean)
      .sort((left, right) => {
        const exitDiff = this.toTimestamp(right.exit_time) - this.toTimestamp(left.exit_time);
        if (exitDiff !== 0) {
          return exitDiff;
        }

        return this.toTimestamp(right.entry_time) - this.toTimestamp(left.entry_time);
      });
  }

  static paginate(positions = [], limit = 50, offset = 0) {
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(Number(limit), 1) : 50;
    const safeOffset = Number.isFinite(Number(offset)) ? Math.max(Number(offset), 0) : 0;
    return positions.slice(safeOffset, safeOffset + safeLimit);
  }
}

module.exports = ClosedPositionAggregationService;
