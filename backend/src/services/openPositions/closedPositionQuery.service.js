const Trade = require('../../models/Trade');
const ClosedPositionAggregationService = require('./closedPositionAggregation.service');
const OpenPositionAggregationService = require('./openPositionAggregation.service');
const OpenPositionIdentityService = require('./openPositionIdentity.service');
const OpenPositionReferenceService = require('./openPositionReference.service');
const OpenPositionTradeTransformerService = require('./openPositionTradeTransformer.service');

class ClosedPositionQueryService {
  static toTimestamp(value) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  static filterTradesWithPositionReference(trades = []) {
    return trades.filter(trade => OpenPositionReferenceService.hasTradePositionReference(trade));
  }

  static buildPositionRecords(trades = []) {
    const groupedTrades = new Map();

    for (const trade of trades) {
      const key = trade.positionRouteId || trade.id;
      if (!key) continue;
      if (!groupedTrades.has(key)) {
        groupedTrades.set(key, []);
      }
      groupedTrades.get(key).push(trade);
    }

    return ClosedPositionAggregationService.aggregate(trades).map(position => ({
      ...position,
      linkedTrades: groupedTrades.get(position.positionRouteId || position.id) || []
    }));
  }

  static async loadMatchingTrades(userId, filters = {}) {
    const trades = await Trade.findByUser(userId, { ...filters, limit: 5000, offset: 0 });
    const matchingTrades = this.filterTradesWithPositionReference(trades);

    return OpenPositionTradeTransformerService.normalizeTradesForApi(matchingTrades);
  }

  static async loadOpenTrades(userId, filters = {}) {
    const openTrades = await Trade.findByUser(userId, {
      ...filters,
      status: 'open',
      limit: 5000,
      offset: 0
    });

    OpenPositionTradeTransformerService.parseTradeExecutions(openTrades);
    OpenPositionTradeTransformerService.normalizeTradesForApi(openTrades);

    return openTrades;
  }

  static buildOpenPositionRecords(trades = []) {
    const positions = OpenPositionAggregationService.buildPositions(trades);

    return positions.map(position => {
      const firstTrade = position.trades?.[0] || {};
      const entryTimes = (position.trades || [])
        .map(trade => trade.entry_time || trade.trade_date)
        .filter(Boolean)
        .sort((left, right) => this.toTimestamp(left) - this.toTimestamp(right));

      return {
        ...firstTrade,
        id: position.id,
        legacyId: position.legacyId,
        positionRouteId: position.id,
        positionKey: position.positionKey,
        positionReferences: Array.from(new Set(
          (position.trades || [])
            .flatMap(trade => trade.positionReferences || OpenPositionReferenceService.extractTradePositionReferences(trade))
            .filter(Boolean)
        )),
        symbol: position.symbol,
        side: position.side,
        quantity: position.totalQuantity,
        entry_price: position.avgPrice,
        exit_price: null,
        entry_time: entryTimes[0] || null,
        exit_time: null,
        pnl: position.unrealizedPnL ?? null,
        pnl_percent: position.unrealizedPnLPercent ?? null,
        total_cost: position.totalCost,
        tradeCount: Array.isArray(position.trades) ? position.trades.length : 0,
        tradeIds: Array.isArray(position.trades) ? position.trades.map(trade => trade.id).filter(Boolean) : [],
        linkedTrades: Array.isArray(position.trades) ? position.trades : [],
        isAggregatedPosition: true,
        status: 'open',
        instrument_type: position.instrumentType || firstTrade.instrument_type || firstTrade.instrumentType || 'stock'
      };
    });
  }

  static sortPositionRecords(positions = []) {
    return [...positions].sort((left, right) => {
      const leftTime = this.toTimestamp(left.exit_time || left.entry_time);
      const rightTime = this.toTimestamp(right.exit_time || right.entry_time);
      return rightTime - leftTime;
    });
  }

  static async buildRecordsForUser(userId, filters = {}) {
    const requestedStatus = String(filters?.status || '').toLowerCase();

    if (requestedStatus === 'open') {
      const openTrades = await this.loadOpenTrades(userId, filters);
      return {
        matchingTrades: openTrades,
        positions: this.sortPositionRecords(this.buildOpenPositionRecords(openTrades))
      };
    }

    if (requestedStatus === 'closed') {
      const matchingTrades = await this.loadMatchingTrades(userId, filters);
      return {
        matchingTrades,
        positions: this.sortPositionRecords(this.buildPositionRecords(matchingTrades))
      };
    }

    const [closedTrades, openTrades] = await Promise.all([
      this.loadMatchingTrades(userId, { ...filters, status: 'closed' }),
      this.loadOpenTrades(userId, filters)
    ]);

    return {
      matchingTrades: [...closedTrades, ...openTrades],
      positions: this.sortPositionRecords([
        ...this.buildOpenPositionRecords(openTrades),
        ...this.buildPositionRecords(closedTrades)
      ])
    };
  }

  static async getPositionById(userId, positionId, filters = {}) {
    const { positions } = await this.buildRecordsForUser(userId, filters);
    return positions.find(position => OpenPositionIdentityService.matchesPosition(position, positionId)) || null;
  }
}

module.exports = ClosedPositionQueryService;
