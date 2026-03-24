const {
  DEFAULT_MARGIN_COIN,
  STABLECOIN_TO_CURRENCY
} = require('./constants');

class BitunixTradeParser {
  constructor() {
    this.orderIntentByPositionSide = {
      long: {
        scale_in: 'BUY',
        reduce: 'SELL'
      },
      short: {
        scale_in: 'SELL',
        reduce: 'BUY'
      }
    };
  }

  normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase();
  }

  normalizeOriginalCurrency(marginCoin) {
    const normalizedMarginCoin = String(marginCoin || DEFAULT_MARGIN_COIN).trim().toUpperCase();
    return STABLECOIN_TO_CURRENCY[normalizedMarginCoin] || (normalizedMarginCoin.length <= 3 ? normalizedMarginCoin : 'USD');
  }

  normalizePositionSide(sideValue) {
    const normalizedSide = String(sideValue || '').trim().toUpperCase();

    if (normalizedSide === 'SHORT' || normalizedSide === 'SELL') {
      return 'short';
    }

    if (normalizedSide === 'LONG' || normalizedSide === 'BUY') {
      return 'long';
    }

    return 'long';
  }

  normalizeOrderSide(sideValue) {
    const normalizedSide = String(sideValue || '').trim().toUpperCase();

    if (normalizedSide === 'SELL' || normalizedSide === 'SHORT') {
      return 'sell';
    }

    if (normalizedSide === 'BUY' || normalizedSide === 'LONG') {
      return 'buy';
    }

    return 'buy';
  }

  getExpectedActionsForPositionSide(positionSide) {
    return this.orderIntentByPositionSide[positionSide] || this.orderIntentByPositionSide.long;
  }

  determineFillAction(positionSide, fill = {}) {
    const expectedActions = this.getExpectedActionsForPositionSide(positionSide);
    const normalizedFillSide = this.normalizeOrderSide(fill.side);

    if (normalizedFillSide === expectedActions.scale_in.toLowerCase()) {
      return normalizedFillSide;
    }

    if (normalizedFillSide === expectedActions.reduce.toLowerCase()) {
      return normalizedFillSide;
    }

    if (this.parseBoolean(fill.reduceOnly)) {
      return expectedActions.reduce.toLowerCase();
    }

    return expectedActions.scale_in.toLowerCase();
  }

  determineFillType(positionSide, fill = {}) {
    const action = this.determineFillAction(positionSide, fill);
    const expectedActions = this.getExpectedActionsForPositionSide(positionSide);
    return action === expectedActions.reduce.toLowerCase() ? 'exit' : 'entry';
  }

  parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return Boolean(value);
  }

  toIsoString(timestamp) {
    if (!timestamp) return null;
    const date = new Date(Number(timestamp));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  toTradeDate(value) {
    const iso = this.toIsoString(value);
    return iso ? iso.split('T')[0] : null;
  }

  parsePendingOrder(order) {
    if (!order?.orderId || !order?.symbol) {
      return null;
    }

    return {
      orderId: String(order.orderId),
      symbol: this.normalizeSymbol(order.symbol),
      side: this.normalizeOrderSide(order.side),
      quantity: this.parseNumber(order.qty),
      filledQuantity: this.parseNumber(order.tradeQty),
      remainingQuantity: Math.max(
        0,
        (this.parseNumber(order.qty) || 0) - (this.parseNumber(order.tradeQty) || 0)
      ),
      price: this.parseNumber(order.price),
      status: order.status || null,
      orderType: order.orderType || order.type || null,
      effect: order.effect || null,
      reduceOnly: this.parseBoolean(order.reduceOnly),
      leverage: this.parseNumber(order.leverage),
      marginMode: order.marginMode || null,
      positionMode: order.positionMode || null,
      tpPrice: this.parseNumber(order.tpPrice),
      tpStopType: order.tpStopType || null,
      tpOrderType: order.tpOrderType || null,
      tpOrderPrice: this.parseNumber(order.tpOrderPrice),
      slPrice: this.parseNumber(order.slPrice),
      slStopType: order.slStopType || null,
      slOrderType: order.slOrderType || null,
      slOrderPrice: this.parseNumber(order.slOrderPrice),
      createdAt: this.toIsoString(order.ctime),
      updatedAt: this.toIsoString(order.mtime),
      source: 'pending_order'
    };
  }

  parsePendingTpSlOrder(order) {
    if (!order?.id || !order?.positionId || !order?.symbol) {
      return null;
    }

    return {
      id: String(order.id),
      positionId: String(order.positionId),
      symbol: this.normalizeSymbol(order.symbol),
      tpPrice: this.parseNumber(order.tpPrice),
      tpStopType: order.tpStopType || null,
      tpOrderType: order.tpOrderType || null,
      tpOrderPrice: this.parseNumber(order.tpOrderPrice),
      tpQty: this.parseNumber(order.tpQty),
      slPrice: this.parseNumber(order.slPrice),
      slStopType: order.slStopType || null,
      slOrderType: order.slOrderType || null,
      slOrderPrice: this.parseNumber(order.slOrderPrice),
      slQty: this.parseNumber(order.slQty),
      source: 'position_tpsl'
    };
  }

  buildPendingOrdersIndex(pendingOrders = []) {
    return pendingOrders
      .map(order => this.parsePendingOrder(order))
      .filter(Boolean)
      .reduce((acc, order) => {
        const key = order.symbol;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(order);
        return acc;
      }, {});
  }

  buildPendingTpSlIndex(pendingTpSlOrders = []) {
    return pendingTpSlOrders
      .map(order => this.parsePendingTpSlOrder(order))
      .filter(Boolean)
      .reduce((acc, order) => {
        const key = order.positionId;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(order);
        return acc;
      }, {});
  }

  getRelevantPendingOrders(position, pendingOrdersIndex = {}) {
    const symbol = this.normalizeSymbol(position.symbol);
    const side = this.normalizePositionSide(position.side);
    const expectedActions = this.orderIntentByPositionSide[side] || this.orderIntentByPositionSide.long;
    const orders = pendingOrdersIndex[symbol] || [];

    return orders
      .filter(order => {
        if (!order?.side) return false;
        if (order.reduceOnly) {
          return order.side.toUpperCase() === expectedActions.reduce;
        }
        return order.side.toUpperCase() === expectedActions.scale_in;
      })
      .map(order => ({
        ...order,
        intent: order.reduceOnly ? 'reduce' : 'scale_in'
      }));
  }

  buildPositionTargets(positionTpSlOrders = [], relevantPendingOrders = []) {
    const takeProfitTargets = [];
    let stopLoss = null;
    let takeProfit = null;

    positionTpSlOrders.forEach(order => {
      if (stopLoss === null && order.slPrice !== null) {
        stopLoss = order.slPrice;
      }
      if (order.tpPrice !== null) {
        takeProfitTargets.push({
          price: order.tpPrice,
          shares: order.tpQty || null,
          orderType: order.tpOrderType || null,
          orderPrice: order.tpOrderPrice || null,
          stopType: order.tpStopType || null,
          source: order.source
        });
      }
    });

    relevantPendingOrders.forEach(order => {
      if (stopLoss === null && order.slPrice !== null) {
        stopLoss = order.slPrice;
      }
      if (order.tpPrice !== null) {
        takeProfitTargets.push({
          price: order.tpPrice,
          shares: order.remainingQuantity || order.quantity || null,
          orderType: order.tpOrderType || null,
          orderPrice: order.tpOrderPrice || null,
          stopType: order.tpStopType || null,
          source: order.source
        });
      }
    });

    const dedupedTakeProfitTargets = takeProfitTargets.filter((target, index, list) =>
      list.findIndex(candidate =>
        candidate.price === target.price &&
        candidate.shares === target.shares &&
        candidate.orderType === target.orderType &&
        candidate.source === target.source
      ) === index
    );

    if (dedupedTakeProfitTargets.length > 0) {
      takeProfit = dedupedTakeProfitTargets[0].price;
    }

    return {
      stopLoss,
      takeProfit,
      takeProfitTargets: dedupedTakeProfitTargets
    };
  }

  calculatePositionPnl(entryPrice, exitPrice, quantity, side) {
    const parsedEntry = this.parseNumber(entryPrice);
    const parsedExit = this.parseNumber(exitPrice);
    const parsedQty = this.parseNumber(quantity);

    if (parsedEntry === null || parsedExit === null || parsedQty === null) {
      return null;
    }

    if (side === 'short') {
      return (parsedEntry - parsedExit) * parsedQty;
    }

    return (parsedExit - parsedEntry) * parsedQty;
  }

  parseHistoryTradeFill(fill, positionSide, fallbackMeta = {}, forcedPositionId = null) {
    const positionId = forcedPositionId || (fill?.positionId ? String(fill.positionId) : null);
    const quantity = Math.abs(this.parseNumber(fill?.qty) || 0);
    const price = this.parseNumber(fill?.price);
    const datetime = this.toIsoString(fill?.ctime || fill?.mtime);

    if (!quantity || price === null || !datetime) {
      return null;
    }

    const action = this.determineFillAction(positionSide, fill);
    const type = this.determineFillType(positionSide, fill);

    return {
      type,
      action,
      side: positionSide,
      datetime,
      price,
      quantity,
      positionId,
      tradeId: fill?.tradeId ? String(fill.tradeId) : null,
      orderId: fill?.orderId ? String(fill.orderId) : null,
      reduceOnly: this.parseBoolean(fill?.reduceOnly),
      fee: this.parseNumber(fill?.fee),
      fees: Math.abs(this.parseNumber(fill?.fee) || 0),
      realizedPnl: this.parseNumber(fill?.realizedPNL),
      leverage: fallbackMeta.leverage ?? null,
      marginMode: fallbackMeta.marginMode ?? null,
      positionMode: fallbackMeta.positionMode ?? null,
      liquidationPrice: fallbackMeta.liquidationPrice ?? null
    };
  }

  buildPositionMetaIndex(positions = []) {
    return positions.reduce((acc, position) => {
      if (!position?.positionId) {
        return acc;
      }

      acc[String(position.positionId)] = {
        side: this.normalizePositionSide(position.side),
        leverage: this.parseNumber(position.leverage),
        marginMode: position.marginMode || null,
        positionMode: position.positionMode || null,
        liquidationPrice: this.parseNumber(position.liqPrice)
      };
      return acc;
    }, {});
  }

  buildHistoryTradesIndex(historyTrades = [], historyPositions = [], pendingPositions = []) {
    const positionMetaIndex = this.buildPositionMetaIndex([
      ...historyPositions,
      ...pendingPositions
    ]);

    const historyTradeIndex = {};
    const unmatchedFills = [];

    historyTrades.forEach(fill => {
      if (fill?.positionId) {
        const positionId = String(fill.positionId);
        const positionMeta = positionMetaIndex[positionId];
        if (positionMeta?.side) {
          const parsedFill = this.parseHistoryTradeFill(fill, positionMeta.side, positionMeta, positionId);
          if (parsedFill) {
            if (!historyTradeIndex[positionId]) {
              historyTradeIndex[positionId] = [];
            }
            historyTradeIndex[positionId].push(parsedFill);
            return;
          }
        }
      }

      unmatchedFills.push(fill);
    });

    const availableFills = unmatchedFills
      .map((fill, index) => ({ fill, index }))
      .filter(({ fill }) => fill?.symbol && fill?.ctime);

    const sortedPositions = [...historyPositions]
      .filter(position => position?.positionId && position?.symbol && position?.ctime && position?.mtime)
      .sort((a, b) => Number(a.ctime) - Number(b.ctime));

    sortedPositions.forEach(position => {
      const positionId = String(position.positionId);
      if (historyTradeIndex[positionId]?.length) {
        return;
      }

      const positionMeta = positionMetaIndex[positionId];
      if (!positionMeta?.side) {
        return;
      }

      const positionSymbol = this.normalizeSymbol(position.symbol);
      const entryTime = Number(position.ctime);
      const exitTime = Number(position.mtime);
      const quantity = Math.abs(this.parseNumber(position.maxQty) || 0);
      const tolerance = 60 * 1000;

      const matched = [];
      for (let i = availableFills.length - 1; i >= 0; i--) {
        const candidate = availableFills[i];
        const fill = candidate.fill;
        const fillTime = Number(fill.ctime || fill.mtime);
        const sameSymbol = this.normalizeSymbol(fill.symbol) === positionSymbol;

        if (!sameSymbol || !Number.isFinite(fillTime)) {
          continue;
        }

        if (fillTime < entryTime - tolerance || fillTime > exitTime + tolerance) {
          continue;
        }

        matched.push(candidate);
        availableFills.splice(i, 1);
      }

      if (!matched.length) {
        return;
      }

      const parsedFills = matched
        .sort((a, b) => Number(a.fill.ctime || a.fill.mtime) - Number(b.fill.ctime || b.fill.mtime))
        .map(({ fill }) => this.parseHistoryTradeFill(fill, positionMeta.side, positionMeta, positionId))
        .filter(Boolean);

      if (!parsedFills.length) {
        return;
      }

      const totalEntryQty = parsedFills
        .filter(fill => fill.type === 'entry')
        .reduce((sum, fill) => sum + (fill.quantity || 0), 0);
      const totalExitQty = parsedFills
        .filter(fill => fill.type === 'exit')
        .reduce((sum, fill) => sum + (fill.quantity || 0), 0);

      const hasReasonableCoverage =
        quantity === 0 ||
        totalEntryQty > 0 ||
        totalExitQty > 0;

      if (hasReasonableCoverage) {
        historyTradeIndex[positionId] = parsedFills;
      }
    });

    return historyTradeIndex;
  }

  buildClosedPositionExecutions(position, fallbackExecutions = [], historyTradeIndex = {}) {
    const positionId = position?.positionId ? String(position.positionId) : null;
    const fills = positionId ? (historyTradeIndex[positionId] || []) : [];

    if (!fills.length) {
      return fallbackExecutions;
    }

    const sortedFills = [...fills].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    const entryFills = sortedFills.filter(fill => fill.type === 'entry');
    const exitFills = sortedFills.filter(fill => fill.type === 'exit');

    if (entryFills.length > 0 && exitFills.length > 0) {
      return sortedFills;
    }

    return [
      ...fallbackExecutions.filter(exec => exec.type === 'entry'),
      ...sortedFills,
      ...fallbackExecutions.filter(exec => exec.type === 'exit')
    ];
  }

  parseClosedPosition(position, marginCoin, historyTradeIndex = {}) {
    const side = this.normalizePositionSide(position.side);
    const quantity = Math.abs(parseFloat(position.maxQty || 0));
    const entryTime = this.toIsoString(position.ctime);
    const exitTime = this.toIsoString(position.mtime);
    const originalCurrency = this.normalizeOriginalCurrency(marginCoin);
    const tradingFees = Math.abs(parseFloat(position.fee || 0));
    const fundingFees = Math.abs(parseFloat(position.funding || 0));
    const entryPrice = this.parseNumber(position.entryPrice);
    const exitPrice = this.parseNumber(position.closePrice);
    const leverage = this.parseNumber(position.leverage);
    const notionalValue = quantity && entryPrice !== null
      ? quantity * entryPrice
      : null;
    const marginUsed = leverage && leverage > 0 && notionalValue !== null
      ? notionalValue / leverage
      : null;
    const netPnl = this.parseNumber(position.realizedPNL);
    const positionPnl = this.calculatePositionPnl(entryPrice, exitPrice, quantity, side);
    const pnlPercent = marginUsed && marginUsed > 0 && netPnl !== null
      ? (netPnl / marginUsed) * 100
      : null;

    if (!position.positionId || !position.symbol || !quantity || !entryTime) {
      return null;
    }

    const fallbackExecutions = [
      {
        type: 'entry',
        action: side === 'short' ? 'sell' : 'buy',
        datetime: entryTime,
        price: entryPrice,
        quantity,
        side,
        positionId: String(position.positionId),
        leverage,
        notionalValue,
        marginUsed,
        positionPnl,
        netPnl,
        marginMode: position.marginMode || null,
        positionMode: position.positionMode || null,
        liquidationPrice: this.parseNumber(position.liqPrice)
      },
      {
        type: 'exit',
        action: side === 'short' ? 'buy' : 'sell',
        datetime: exitTime,
        price: exitPrice,
        quantity,
        side,
        positionId: String(position.positionId),
        leverage,
        notionalValue,
        marginUsed,
        positionPnl,
        netPnl,
        marginMode: position.marginMode || null,
        positionMode: position.positionMode || null,
        liquidationPrice: this.parseNumber(position.liqPrice)
      }
    ];

    return {
      symbol: this.normalizeSymbol(position.symbol),
      side,
      quantity,
      entryPrice,
      exitPrice,
      entryTime,
      exitTime,
      tradeDate: this.toTradeDate(position.mtime || position.ctime),
      commission: 0,
      fees: tradingFees + fundingFees,
      pnl: netPnl,
      pnlPercent,
      broker: 'bitunix',
      instrumentType: 'crypto',
      originalCurrency,
      accountIdentifier: `bitunix-${marginCoin.toLowerCase()}`,
      stopLoss: null,
      takeProfit: null,
      takeProfitTargets: [],
      executionData: this.buildClosedPositionExecutions(position, fallbackExecutions, historyTradeIndex)
    };
  }

  buildSyntheticExecution(type, context, extra = {}) {
    const {
      side,
      position,
      positionId,
      entryTime,
      updatedTime,
      leverage,
      notionalValue,
      marginUsed,
      relevantPendingOrders,
      positionTpSlOrders
    } = context;

    return {
      type,
      action: type === 'exit'
        ? (side === 'short' ? 'buy' : 'sell')
        : (side === 'short' ? 'sell' : 'buy'),
      datetime: type === 'entry' ? entryTime : (updatedTime || entryTime),
      price: type === 'entry' ? (parseFloat(position.avgOpenPrice || 0) || null) : null,
      quantity: extra.quantity,
      side,
      positionId,
      leverage,
      notionalValue,
      marginUsed,
      unrealizedPnl: this.parseNumber(position.unrealizedPNL),
      realizedPnl: this.parseNumber(position.realizedPNL),
      liquidationPrice: this.parseNumber(position.liqPrice),
      marginRate: this.parseNumber(position.marginRate),
      marginMode: position.marginMode || null,
      positionMode: position.positionMode || null,
      pendingOrders: relevantPendingOrders,
      positionTpSlOrders,
      synthetic: true,
      syntheticReason: extra.syntheticReason
    };
  }

  getExecutionTotals(executions = [], side) {
    return executions.reduce((acc, execution) => {
      const qty = Math.abs(this.parseNumber(execution?.quantity) || 0);
      const type = String(execution?.type || '').toLowerCase();
      const action = String(execution?.action || execution?.side || '').toLowerCase();

      const isEntryAction = side === 'short'
        ? (action === 'sell' || action === 'short')
        : (action === 'buy' || action === 'long');
      const isExitAction = side === 'short'
        ? (action === 'buy' || action === 'long')
        : (action === 'sell' || action === 'short');

      if (type === 'entry' || isEntryAction) {
        acc.entry += qty;
      } else if (type === 'exit' || isExitAction) {
        acc.exit += qty;
      }

      return acc;
    }, { entry: 0, exit: 0 });
  }

  buildPendingExecutionData(position, historyExecutions, context) {
    const quantity = context.quantity;
    const maxQuantity = context.maxQuantity;
    const tolerance = 1e-8;

    if (!historyExecutions.length) {
      const syntheticExecutions = [
        this.buildSyntheticExecution('entry', context, {
          quantity: maxQuantity || quantity,
          syntheticReason: 'pending-position-entry'
        })
      ];

      const closedQuantity = Math.max((maxQuantity || quantity) - quantity, 0);
      if (closedQuantity > tolerance) {
        syntheticExecutions.push(
          this.buildSyntheticExecution('exit', context, {
            quantity: closedQuantity,
            syntheticReason: 'pending-position-partial-close'
          })
        );
      }

      return syntheticExecutions;
    }

    const reconciledExecutions = [...historyExecutions];
    const totals = this.getExecutionTotals(reconciledExecutions, context.side);
    const missingEntryQuantity = Math.max(maxQuantity - totals.entry, 0);

    if (missingEntryQuantity > tolerance) {
      reconciledExecutions.unshift(
        this.buildSyntheticExecution('entry', context, {
          quantity: missingEntryQuantity,
          syntheticReason: 'missing-entry-coverage'
        })
      );
      reconciledExecutions.push(
        this.buildSyntheticExecution('exit', context, {
          quantity: missingEntryQuantity,
          syntheticReason: 'missing-entry-reconciliation'
        })
      );
    }

    const reconciledTotals = this.getExecutionTotals(reconciledExecutions, context.side);
    const netQuantity = Math.max(reconciledTotals.entry - reconciledTotals.exit, 0);
    const missingExitQuantity = Math.max(netQuantity - quantity, 0);
    const missingNetEntryQuantity = Math.max(quantity - netQuantity, 0);

    if (missingExitQuantity > tolerance) {
      reconciledExecutions.push(
        this.buildSyntheticExecution('exit', context, {
          quantity: missingExitQuantity,
          syntheticReason: 'net-position-reconciliation'
        })
      );
    } else if (missingNetEntryQuantity > tolerance) {
      reconciledExecutions.push(
        this.buildSyntheticExecution('entry', context, {
          quantity: missingNetEntryQuantity,
          syntheticReason: 'net-position-top-up'
        })
      );
    }

    return reconciledExecutions.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  }

  parsePendingPosition(position, marginCoin, pendingOrdersIndex = {}, pendingTpSlIndex = {}, historyTradeIndex = {}) {
    const side = this.normalizePositionSide(position.side);
    const quantity = Math.abs(parseFloat(position.qty || 0));
    const maxQuantity = Math.max(
      quantity,
      Math.abs(this.parseNumber(position.maxQty) || 0)
    );
    const entryTime = this.toIsoString(position.ctime);
    const updatedTime = this.toIsoString(position.utime || position.mtime || position.ctime);
    const originalCurrency = this.normalizeOriginalCurrency(marginCoin);
    const tradingFees = Math.abs(parseFloat(position.fee || 0));
    const fundingFees = Math.abs(parseFloat(position.funding || 0));
    const positionId = String(position.positionId);
    const relevantPendingOrders = this.getRelevantPendingOrders(position, pendingOrdersIndex);
    const positionTpSlOrders = pendingTpSlIndex[positionId] || [];
    const { stopLoss, takeProfit, takeProfitTargets } = this.buildPositionTargets(positionTpSlOrders, relevantPendingOrders);
    const leverage = this.parseNumber(position.leverage);
    const notionalValue = this.parseNumber(position.entryValue) !== null
      ? this.parseNumber(position.entryValue)
      : (quantity && this.parseNumber(position.avgOpenPrice) !== null
        ? quantity * this.parseNumber(position.avgOpenPrice)
        : null);
    const marginUsed = this.parseNumber(position.margin) !== null
      ? this.parseNumber(position.margin)
      : (leverage && leverage > 0 && notionalValue !== null ? notionalValue / leverage : null);

    if (!position.positionId || !position.symbol || !quantity || !entryTime) {
      return null;
    }

    const historyExecutions = Array.isArray(historyTradeIndex[positionId])
      ? [...historyTradeIndex[positionId]].sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      : [];

    const executionContext = {
      side,
      position,
      positionId,
      quantity,
      maxQuantity,
      entryTime,
      updatedTime,
      leverage,
      notionalValue,
      marginUsed,
      relevantPendingOrders,
      positionTpSlOrders
    };

    return {
      symbol: this.normalizeSymbol(position.symbol),
      side,
      quantity,
      entryPrice: parseFloat(position.avgOpenPrice || 0) || null,
      exitPrice: null,
      entryTime,
      exitTime: null,
      tradeDate: this.toTradeDate(position.ctime),
      commission: 0,
      fees: tradingFees + fundingFees,
      pnl: null,
      broker: 'bitunix',
      instrumentType: 'crypto',
      originalCurrency,
      accountIdentifier: `bitunix-${marginCoin.toLowerCase()}`,
      stopLoss,
      takeProfit,
      takeProfitTargets,
      executionData: this.buildPendingExecutionData(position, historyExecutions, executionContext)
    };
  }

  parsePositions(historyPositions, pendingPositions, pendingOrders, pendingTpSlOrders, marginCoin, historyTrades = []) {
    const pendingOrdersIndex = this.buildPendingOrdersIndex(pendingOrders);
    const pendingTpSlIndex = this.buildPendingTpSlIndex(pendingTpSlOrders);
    const historyTradeIndex = this.buildHistoryTradesIndex(historyTrades, historyPositions, pendingPositions);

    const closedTrades = historyPositions
      .map(position => this.parseClosedPosition(position, marginCoin, historyTradeIndex))
      .filter(Boolean);

    const openTrades = pendingPositions
      .map(position => this.parsePendingPosition(position, marginCoin, pendingOrdersIndex, pendingTpSlIndex, historyTradeIndex))
      .filter(Boolean);

    return [...closedTrades, ...openTrades];
  }

  extractPositionIds(executions) {
    let normalized = executions;
    if (typeof normalized === 'string') {
      try {
        normalized = JSON.parse(normalized);
      } catch {
        normalized = [];
      }
    }

    if (!Array.isArray(normalized)) {
      return new Set();
    }

    return new Set(
      normalized
        .map(exec => exec?.positionId)
        .filter(Boolean)
        .map(String)
    );
  }
}

module.exports = BitunixTradeParser;
