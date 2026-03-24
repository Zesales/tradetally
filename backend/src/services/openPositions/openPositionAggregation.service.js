const OpenPositionBrokerAdapterRegistry = require('./adapters');
const OpenPositionIdentityService = require('./openPositionIdentity.service');
const OpenPositionReferenceService = require('./openPositionReference.service');
const OpenPositionTradeTransformerService = require('./openPositionTradeTransformer.service');

class OpenPositionAggregationService {
  static normalizeExpirationDate(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }

  static parseTradeExecutions(trades = []) {
    return OpenPositionTradeTransformerService.parseTradeExecutions(trades);
  }

  static buildPositions(trades = []) {
    const positionMap = Object.create(null);

    trades.forEach(trade => {
      const netPosition = this.calculateNetPosition(trade);
      if (Math.abs(netPosition) < 1e-12) {
        return;
      }

      const positionKey = this.getPositionKey(trade);
      if (!Object.hasOwn(positionMap, positionKey)) {
        positionMap[positionKey] = this.createPositionBucket(trade, positionKey);
      }

      const position = positionMap[positionKey];
      position.trades.push(trade);
      position.totalQuantity += netPosition;
      position.totalSharesTraded += this.calculateTotalSharesTraded(trade);

      const notionalCost = this.calculateTradeNotionalCost(trade, netPosition);
      const marginCost = this.getBrokerAdapter(trade?.broker)?.getMarginCost?.(trade);

      position.priceCostBasis += notionalCost;
      position.totalCost += Number.isFinite(marginCost) && marginCost > 0
        ? marginCost
        : notionalCost;
    });

    this.mergeFallbackOptionPositions(positionMap);
    return this.finalizePositions(positionMap);
  }

  static createPositionBucket(trade, positionKey) {
    return {
      positionKey,
      symbol: trade.symbol,
      side: null,
      trades: [],
      totalQuantity: 0,
      totalSharesTraded: 0,
      totalCost: 0,
      priceCostBasis: 0,
      avgPrice: 0,
      instrumentType: trade.instrument_type || 'stock',
      contractSize: trade.contract_size || (trade.instrument_type === 'option' ? 100 : 1),
      pointValue: trade.point_value || null,
      underlying_symbol: trade.underlying_symbol || null,
      expiration_date: trade.expiration_date || null,
      option_type: trade.option_type || null,
      strike_price: trade.strike_price || null
    };
  }

  static calculateNetPosition(trade) {
    if (Array.isArray(trade?.executions) && trade.executions.length > 0) {
      return trade.executions.reduce((netPosition, execution) => {
        const quantity = parseFloat(execution?.quantity) || 0;
        const isGroupedExecution = execution.entryPrice !== undefined
          || execution.exitPrice !== undefined
          || execution.entryTime !== undefined;
        const isMixedFormat = isGroupedExecution
          && execution.action
          && execution.price !== undefined
          && execution.datetime;

        if (isGroupedExecution && !isMixedFormat) {
          if (!execution.exitPrice) {
            return netPosition + (trade.side === 'long' ? quantity : -quantity);
          }
          return netPosition;
        }

        const action = String(execution?.action || execution?.side || '').toLowerCase();
        if (action === 'buy' || action === 'long') {
          return netPosition + quantity;
        }
        if (action === 'sell' || action === 'short') {
          return netPosition - quantity;
        }
        if (action === '' || action === 'unknown') {
          console.warn(`[POSITION] Execution missing action for trade ${trade.id}, skipping from net position calculation`);
        }
        return netPosition;
      }, 0);
    }

    return trade.side === 'long' ? trade.quantity : -trade.quantity;
  }

  static calculateTotalSharesTraded(trade) {
    if (Array.isArray(trade?.executions) && trade.executions.length > 0) {
      const totalTraded = trade.executions.reduce((sum, execution) => {
        const quantity = parseFloat(execution?.quantity) || 0;
        const executionType = String(execution?.type || '').toLowerCase();
        const action = String(execution?.action || execution?.side || '').toLowerCase();
        const isEntryExecution =
          executionType === 'entry'
          || ((action === 'buy' || action === 'long') && trade.side === 'long')
          || ((action === 'sell' || action === 'short') && trade.side === 'short');

        return isEntryExecution ? sum + Math.abs(quantity) : sum;
      }, 0);

      return totalTraded || (trade.quantity || 0);
    }

    return trade.quantity || 0;
  }

  static calculateTradeNotionalCost(trade, netPosition) {
    const price = parseFloat(trade?.entry_price) || 0;
    return Math.abs(netPosition) * price * this.getCostMultiplier(trade);
  }

  static getCostMultiplier(trade) {
    if (trade?.instrument_type === 'future') {
      return trade.point_value || 1;
    }
    if (trade?.instrument_type === 'option') {
      return trade.contract_size || 100;
    }
    return 1;
  }

  static getPositionKey(trade) {
    const positionReferenceKey = OpenPositionReferenceService.buildTradePositionGroupKey(trade);
    if (positionReferenceKey) {
      return positionReferenceKey;
    }

    if (
      trade.instrument_type === 'option'
      && trade.underlying_symbol
      && trade.strike_price
      && trade.expiration_date
      && trade.option_type
    ) {
      return [
        trade.underlying_symbol,
        trade.strike_price,
        this.normalizeExpirationDate(trade.expiration_date),
        trade.option_type
      ].join('_');
    }

    return trade.symbol;
  }

  static getBrokerAdapter(broker) {
    return OpenPositionBrokerAdapterRegistry.getAdapter(broker);
  }

  static mergeFallbackOptionPositions(positionMap) {
    const fallbackKeys = new Set();

    Object.entries(positionMap).forEach(([key, position]) => {
      if (position.instrumentType === 'option' && key === position.symbol) {
        fallbackKeys.add(key);
      }
    });

    for (const fallbackKey of fallbackKeys) {
      if (!positionMap[fallbackKey]) continue;

      const fallbackPosition = positionMap[fallbackKey];
      const compositeMatch = Object.entries(positionMap).find(([key, position]) =>
        key !== fallbackKey
        && position.symbol === fallbackPosition.symbol
        && position.instrumentType === 'option'
        && !fallbackKeys.has(key)
      );

      if (!compositeMatch) {
        continue;
      }

      const [compositeKey, compositePosition] = compositeMatch;
      console.log(`[POSITION] Merging fallback position "${fallbackKey}" into composite position "${compositeKey}" (symbol: ${fallbackPosition.symbol})`);

      compositePosition.trades.push(...fallbackPosition.trades);
      compositePosition.totalQuantity += fallbackPosition.totalQuantity;
      compositePosition.totalSharesTraded += fallbackPosition.totalSharesTraded;
      compositePosition.totalCost += fallbackPosition.totalCost;
      compositePosition.priceCostBasis += fallbackPosition.priceCostBasis;

      if (!compositePosition.underlying_symbol && fallbackPosition.underlying_symbol) compositePosition.underlying_symbol = fallbackPosition.underlying_symbol;
      if (!compositePosition.strike_price && fallbackPosition.strike_price) compositePosition.strike_price = fallbackPosition.strike_price;
      if (!compositePosition.expiration_date && fallbackPosition.expiration_date) compositePosition.expiration_date = fallbackPosition.expiration_date;
      if (!compositePosition.option_type && fallbackPosition.option_type) compositePosition.option_type = fallbackPosition.option_type;

      delete positionMap[fallbackKey];
    }
  }

  static finalizePositions(positionMap) {
    const positions = [];

    Object.values(positionMap).forEach(position => {
      if (position.totalQuantity === 0) {
        return;
      }

      position.side = position.totalQuantity > 0 ? 'long' : 'short';
      const absoluteQuantity = Math.abs(position.totalQuantity);
      const firstTrade = position.trades[0];
      const avgPriceMultiplier = this.getCostMultiplier(firstTrade);
      const priceBasis = position.priceCostBasis || position.totalCost;

      position.totalQuantity = absoluteQuantity;
      position.marginCost = position.totalCost;
      position.totalCost = priceBasis;
      position.avgPrice = priceBasis / (absoluteQuantity * avgPriceMultiplier);
      position.id = OpenPositionIdentityService.buildPositionId(position);
      position.legacyId = OpenPositionIdentityService.buildLegacyPositionId(position.symbol);

      positions.push(position);
    });

    return positions;
  }
}

module.exports = OpenPositionAggregationService;
