const Trade = require('../../models/Trade');
const DividendService = require('../dividendService');
const OpenPositionAggregationService = require('./openPositionAggregation.service');
const OpenPositionBrokerPolicyService = require('./openPositionBrokerPolicy.service');
const OpenPositionIdentityService = require('./openPositionIdentity.service');
const OpenPositionReferenceService = require('./openPositionReference.service');

class OpenPositionHoldingAdapterService {
  static shouldExposePositionAsHolding(position = {}) {
    return OpenPositionBrokerPolicyService.shouldExposeAsHolding(position);
  }

  static async getTradeBasedHoldings(userId) {
    const records = await this.buildTradePositionRecords(userId);
    const holdings = records.map(record => record.holding);
    await this.attachDividendData(userId, holdings);

    return holdings;
  }

  static async getTradeBasedHolding(userId, holdingId) {
    const records = await this.buildTradePositionRecords(userId, { includeLinkedTrades: true });
    const normalizedId = String(holdingId || '');
    const legacySymbol = OpenPositionIdentityService.getLegacySymbol(normalizedId);

    const matchedRecord = records.find(({ holding }) =>
      OpenPositionIdentityService.matchesPosition(holding, normalizedId)
      || String(holding.legacyId) === normalizedId
      || (legacySymbol && holding.symbol === legacySymbol)
    );

    if (!matchedRecord) {
      return null;
    }

    await this.attachDividendData(userId, [matchedRecord.holding]);
    return matchedRecord.holding;
  }

  static async buildTradePositionRecords(userId, options = {}) {
    const { includeLinkedTrades = false } = options;
    const openTrades = await Trade.findByUser(userId, {
      status: 'open',
      limit: 500
    });

    if (!Array.isArray(openTrades) || openTrades.length === 0) {
      return [];
    }

    OpenPositionAggregationService.parseTradeExecutions(openTrades);
    const positions = OpenPositionAggregationService.buildPositions(openTrades);

    return positions
      .filter(position => this.shouldExposePositionAsHolding(position))
      .map(position => ({
        position,
        holding: this.positionToHolding(userId, position, { includeLinkedTrades })
      }));
  }

  static positionToHolding(userId, position, options = {}) {
    const { includeLinkedTrades = false } = options;
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

    const realizedPnl = this.calculateRealizedPnl(position);

    const holding = {
      id: position.id || OpenPositionIdentityService.buildPositionId(position),
      legacyId: position.legacyId || OpenPositionIdentityService.buildLegacyPositionId(position.symbol),
      userId,
      symbol: position.symbol,
      positionKey: position.positionKey,
      positionReferences: Array.from(new Set(
        (position.trades || [])
          .flatMap(trade => OpenPositionReferenceService.extractTradePositionReferences(trade))
          .filter(Boolean)
      )),
      side: position.side || 'long',
      totalShares: position.totalQuantity || 0,
      totalSharesTraded: position.totalSharesTraded || 0,
      averageCostBasis: Number.isFinite(position.avgPrice) ? position.avgPrice : null,
      totalCostBasis: position.totalCost || 0,
      currentPrice: null,
      currentValue: null,
      unrealizedPnl: null,
      unrealizedPnlPercent: null,
      realizedPnl,
      priceUpdatedAt: null,
      totalDividendsReceived: 0,
      dividendYieldOnCost: null,
      lastDividendDate: null,
      targetAllocationPercent: null,
      notes: null,
      sector: null,
      lotCount: Array.isArray(position.trades) ? position.trades.length : 0,
      tradeCount: Array.isArray(position.trades) ? position.trades.length : 0,
      linkedTradeIds: Array.isArray(position.trades) ? position.trades.map(trade => trade.id).filter(Boolean) : [],
      createdAt: entryDates[0]?.toISOString?.() || null,
      updatedAt: entryDates[entryDates.length - 1]?.toISOString?.() || null,
      source: 'trades',
      brokers,
      instrumentType: position.instrumentType || 'stock',
      contractSize: position.instrumentType === 'option' ? (parseFloat(position.contractSize) || 100) : 1,
      pointValue: position.instrumentType === 'future' ? (parseFloat(position.pointValue) || 1) : null
    };

    if (includeLinkedTrades) {
      holding.linkedTrades = Array.isArray(position.trades)
        ? position.trades.map(trade => this.mapLinkedTrade(trade))
        : [];
    };

    return holding;
  }

  static calculateRealizedPnl(position = {}) {
    const side = position?.side === 'short' ? 'short' : 'long';
    const executions = (position.trades || [])
      .flatMap(trade => (Array.isArray(trade.executions) ? trade.executions : []))
      .filter(execution => (parseFloat(execution?.quantity) || 0) > 0)
      .map(execution => ({
        type: String(execution?.type || '').toLowerCase() === 'exit' ? 'exit' : 'entry',
        quantity: parseFloat(execution?.quantity) || 0,
        price: parseFloat(execution?.price),
        realizedPnl: parseFloat(execution?.realizedPnl ?? execution?.realizedPNL ?? execution?.pnl),
        datetime: execution?.datetime || null
      }))
      .sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0));

    let openQuantity = 0;
    let openCostBasis = 0;
    let realizedPnl = 0;

    for (const execution of executions) {
      if (!Number.isFinite(execution.quantity) || execution.quantity <= 0) {
        continue;
      }

      if (execution.type === 'entry') {
        if (!Number.isFinite(execution.price)) {
          continue;
        }

        openCostBasis += execution.quantity * execution.price;
        openQuantity += execution.quantity;
        continue;
      }

      if (Number.isFinite(execution.realizedPnl)) {
        realizedPnl += execution.realizedPnl;
      } else if (openQuantity > 0 && Number.isFinite(execution.price)) {
        const closeQuantity = Math.min(execution.quantity, openQuantity);
        const averageEntry = openCostBasis / openQuantity;
        realizedPnl += side === 'short'
          ? (averageEntry - execution.price) * closeQuantity
          : (execution.price - averageEntry) * closeQuantity;
      }

      if (openQuantity > 0) {
        const closeQuantity = Math.min(execution.quantity, openQuantity);
        const averageEntry = openCostBasis / openQuantity;
        openCostBasis -= averageEntry * closeQuantity;
        openQuantity -= closeQuantity;
      }
    }

    return realizedPnl;
  }

  static mapLinkedTrade(trade = {}) {
    return {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      broker: trade.broker,
      quantity: trade.quantity,
      entry_price: trade.entry_price,
      exit_price: trade.exit_price,
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      trade_date: trade.trade_date,
      pnl: trade.pnl,
      account_identifier: trade.account_identifier || null,
      notes: trade.notes || null,
      executions: Array.isArray(trade.executions) ? trade.executions : []
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
