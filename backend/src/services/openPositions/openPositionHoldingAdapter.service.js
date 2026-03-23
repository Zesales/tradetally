const Trade = require('../../models/Trade');
const DividendService = require('../dividendService');
const OpenPositionAggregationService = require('./openPositionAggregation.service');

class OpenPositionHoldingAdapterService {
  static async getTradeBasedHoldings(userId) {
    const openTrades = await Trade.findByUser(userId, {
      status: 'open',
      limit: 500
    });

    if (!Array.isArray(openTrades) || openTrades.length === 0) {
      return [];
    }

    OpenPositionAggregationService.parseTradeExecutions(openTrades);
    const positions = OpenPositionAggregationService
      .buildPositions(openTrades)
      .filter(position => position.side === 'long');

    const holdings = positions.map(position => this.positionToHolding(userId, position));
    await this.attachDividendData(userId, holdings);

    return holdings;
  }

  static positionToHolding(userId, position) {
    const brokers = [...new Set(
      (position.trades || [])
        .map(trade => trade.broker)
        .filter(Boolean)
    )].join(', ');

    const entryDates = (position.trades || [])
      .map(trade => trade.entry_time || trade.trade_date)
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a - b);

    return {
      id: `trade-${position.symbol}`,
      userId,
      symbol: position.symbol,
      totalShares: position.totalQuantity || 0,
      totalSharesTraded: position.totalSharesTraded || 0,
      averageCostBasis: Number.isFinite(position.avgPrice) ? position.avgPrice : null,
      totalCostBasis: position.totalCost || 0,
      currentPrice: null,
      currentValue: null,
      unrealizedPnl: null,
      unrealizedPnlPercent: null,
      priceUpdatedAt: null,
      totalDividendsReceived: 0,
      dividendYieldOnCost: null,
      lastDividendDate: null,
      targetAllocationPercent: null,
      notes: null,
      sector: null,
      lotCount: Array.isArray(position.trades) ? position.trades.length : 0,
      createdAt: entryDates[0]?.toISOString?.() || null,
      updatedAt: entryDates[entryDates.length - 1]?.toISOString?.() || null,
      source: 'trades',
      brokers,
      instrumentType: position.instrumentType || 'stock',
      contractSize: position.instrumentType === 'option' ? (parseFloat(position.contractSize) || 100) : 1,
      pointValue: position.instrumentType === 'future' ? (parseFloat(position.pointValue) || 1) : null
    };
  }

  static async attachDividendData(userId, holdings) {
    if (!Array.isArray(holdings) || holdings.length === 0) {
      return holdings;
    }

    try {
      const dividendsBySymbol = await DividendService.getUserDividendsBySymbol(userId);
      for (const holding of holdings) {
        const dividendData = dividendsBySymbol[holding.symbol];
        if (!dividendData) {
          continue;
        }

        holding.totalDividendsReceived = dividendData.totalAmount;
        holding.lastDividendDate = dividendData.lastDividendDate;

        if (holding.totalCostBasis > 0 && dividendData.totalAmount > 0) {
          holding.dividendYieldOnCost = (dividendData.totalAmount / holding.totalCostBasis) * 100;
        }
      }
    } catch (error) {
      console.error('[HOLDINGS] Failed to fetch dividend data:', error.message);
    }

    return holdings;
  }
}

module.exports = OpenPositionHoldingAdapterService;
