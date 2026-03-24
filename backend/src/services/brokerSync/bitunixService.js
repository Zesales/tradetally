/**
 * Bitunix Futures API Integration
 * Docs:
 * - Sign: https://www.bitunix.com/api-docs/futures/common/sign.html
 * - Account: GET /api/v1/futures/account
 * - History positions: GET /api/v1/futures/position/get_history_positions
 * - Pending positions: GET /api/v1/futures/position/get_pending_positions
 */

const Trade = require('../../models/Trade');
const BrokerConnection = require('../../models/BrokerConnection');
const AnalyticsCache = require('../analyticsCache');
const cache = require('../../utils/cache');
const db = require('../../config/database');
const BitunixApiClient = require('./bitunix/apiClient');
const BitunixTradeParser = require('./bitunix/tradeParser');
const {
  DEFAULT_MARGIN_COIN,
  FUNDING_HISTORY_START_DATE
} = require('./bitunix/constants');
const OPEN_POSITION_RETRY_DELAY_MS = 2500;
const OPEN_POSITION_HISTORY_LOOKBACK_DAYS = 365;

function invalidateInMemoryCache(userId) {
  const cacheKeys = Object.keys(cache.data || {}).filter(key =>
    key.startsWith(`analytics:user_${userId}:`)
  );
  cacheKeys.forEach(key => cache.del(key));
}

class BitunixService {
  constructor() {
    this.apiClient = new BitunixApiClient();
    this.tradeParser = new BitunixTradeParser();
  }

  toDateOnly(value) {
    if (!value) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return String(value);
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString().slice(0, 10);
  }

  getEarliestPendingPositionDate(pendingPositions = []) {
    const timestamps = pendingPositions
      .map(position => Number(position?.ctime))
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > 0);

    if (!timestamps.length) {
      return null;
    }

    return this.toDateOnly(Math.min(...timestamps));
  }

  resolveHistoryTradeWindow({ startDate, endDate, pendingPositions = [] } = {}) {
    const earliestPendingDate = this.getEarliestPendingPositionDate(pendingPositions);
    const normalizedStartDate = this.toDateOnly(startDate);
    const normalizedEndDate = this.toDateOnly(endDate);

    if (!earliestPendingDate) {
      return {
        startDate: normalizedStartDate,
        endDate: normalizedEndDate
      };
    }

    const effectiveStartDate = !normalizedStartDate || earliestPendingDate < normalizedStartDate
      ? earliestPendingDate
      : normalizedStartDate;

    return {
      startDate: effectiveStartDate,
      endDate: normalizedEndDate
    };
  }

  deriveHistoryStartDateFromTimestamp(timestamp, fallbackStartDate = null) {
    if (fallbackStartDate) {
      return fallbackStartDate;
    }

    const normalizedTimestamp = Number(timestamp);
    if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) {
      return null;
    }

    const lookbackStart = normalizedTimestamp - (OPEN_POSITION_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const floorStart = new Date(FUNDING_HISTORY_START_DATE).getTime();
    return new Date(Math.max(lookbackStart, floorStart)).toISOString().slice(0, 10);
  }

  deriveHistoryStartDateForPendingPosition(position, fallbackStartDate = null) {
    return this.deriveHistoryStartDateFromTimestamp(position?.ctime, fallbackStartDate);
  }

  getUniquePendingPositionTargets(pendingPositions = []) {
    return Array.from(new Map(
      (pendingPositions || [])
        .filter(position => position?.positionId && position?.symbol)
        .map(position => [String(position.positionId), position])
    ).values());
  }

  async getPendingPositionHistoryTrades(apiKey, apiSecret, pendingPositions = [], { startDate, endDate } = {}) {
    const targets = this.getUniquePendingPositionTargets(pendingPositions);
    if (!targets.length) {
      return [];
    }

    const allTrades = [];
    for (const position of targets) {
      const positionStartDate = this.deriveHistoryStartDateForPendingPosition(position, startDate);
      const positionId = String(position.positionId);
      const positionTrades = await this.apiClient.getHistoryTrades(apiKey, apiSecret, {
        startDate: positionStartDate,
        endDate,
        symbol: this.tradeParser.normalizeSymbol(position.symbol),
        positionId
      });
      allTrades.push(...positionTrades.map(fill => ({
        ...fill,
        positionId: fill?.positionId ? String(fill.positionId) : positionId,
        symbol: fill?.symbol || this.tradeParser.normalizeSymbol(position.symbol)
      })));
    }

    return this.tradeParser.mergeHistoryTrades(allTrades, []);
  }

  async fetchTradeHistorySnapshot(apiKey, apiSecret, pendingPositions = [], { startDate, endDate } = {}) {
    const effectiveHistoryStartDate = this.resolveHistoryTradeWindow({
      startDate,
      endDate,
      pendingPositions
    }).startDate;

    const [historyTrades, pendingPositionHistoryTrades] = await Promise.all([
      this.apiClient.getHistoryTrades(apiKey, apiSecret, {
        startDate: effectiveHistoryStartDate,
        endDate
      }),
      this.getPendingPositionHistoryTrades(apiKey, apiSecret, pendingPositions, {
        startDate,
        endDate
      })
    ]);

    return {
      effectiveHistoryStartDate,
      historyTrades: this.tradeParser.mergeHistoryTrades(historyTrades, pendingPositionHistoryTrades)
    };
  }

  async safeOptionalFetch(label, fetcher) {
    try {
      return await fetcher();
    } catch (error) {
      console.warn(`[BITUNIX] Optional ${label} fetch failed:`, error.message);
      return [];
    }
  }

  async validateCredentials(apiKey, apiSecret, marginCoin = DEFAULT_MARGIN_COIN) {
    try {
      await this.apiClient.validateCredentials(apiKey, apiSecret, marginCoin);
      return { valid: true, message: 'Bitunix credentials validated successfully' };
    } catch (error) {
      console.error('[BITUNIX] Credential validation failed:', error.message);
      return { valid: false, message: error.message };
    }
  }

  async syncFundingHistoryForAccount({ userId, accountId, connection, account }) {
    const marginCoin = String(connection?.bitunixMarginCoin || DEFAULT_MARGIN_COIN).toUpperCase();
    const startDate = new Date(FUNDING_HISTORY_START_DATE);
    const startTime = startDate.getTime();
    const endTime = Date.now();

    const [deposits, withdrawals] = await Promise.all([
      this.apiClient.getDepositRecords(connection.bitunixApiKey, connection.bitunixApiSecret, {
        coin: marginCoin,
        startTime,
        endTime
      }),
      this.apiClient.getWithdrawalRecords(connection.bitunixApiKey, connection.bitunixApiSecret, {
        coin: marginCoin,
        startTime,
        endTime
      })
    ]);

    const fundingEvents = [
      ...deposits
        .filter(record =>
          record &&
          String(record.status || '').toLowerCase() === 'success' &&
          String(record.type || '').toLowerCase() === 'deposit' &&
          String(record.coin || '').toUpperCase() === marginCoin
        )
        .map(record => ({
          transactionType: 'deposit',
          amount: parseFloat(record.amount) || 0,
          transactionDate: new Date(Number(record.ctime)).toISOString().slice(0, 10),
          description: `[BITUNIX FUNDING] Deposit ${record.id}`,
          sourceId: String(record.id)
        })),
      ...withdrawals
        .filter(record =>
          record &&
          String(record.status || '').toLowerCase() === 'success' &&
          String(record.type || '').toLowerCase() === 'withdraw' &&
          String(record.coin || '').toUpperCase() === marginCoin
        )
        .map(record => ({
          transactionType: 'withdrawal',
          amount: parseFloat(record.amount) || 0,
          transactionDate: new Date(Number(record.ctime)).toISOString().slice(0, 10),
          description: `[BITUNIX FUNDING] Withdrawal ${record.id}`,
          sourceId: String(record.id)
        }))
    ]
      .filter(event => event.amount > 0 && event.transactionDate)
      .sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));

    const client = await db.connect();
    let insertedCount = 0;
    const existingInitialBalance = parseFloat(
      account?.initial_balance ?? account?.initialBalance ?? 0
    ) || 0;
    const existingInitialBalanceDate = account?.initial_balance_date || account?.initialBalanceDate || null;
    let hasManualBaseline = Math.abs(existingInitialBalance) > 0.000001;

    try {
      await client.query('BEGIN');

      const existingFundingResult = await client.query(
        `SELECT description
         FROM account_transactions
         WHERE user_id = $1
           AND account_id = $2
           AND description LIKE '[BITUNIX FUNDING]%'`,
        [userId, accountId]
      );

      const existingDescriptions = new Set(
        existingFundingResult.rows.map(row => row.description)
      );

      const nonBrokerFundingTransactionsResult = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM account_transactions
         WHERE user_id = $1
           AND account_id = $2
           AND (
             description IS NULL
             OR description !~ '^\\[[^]]+ FUNDING\\]'
           )`,
        [userId, accountId]
      );

      hasManualBaseline =
        hasManualBaseline ||
        Number(nonBrokerFundingTransactionsResult.rows[0]?.count || 0) > 0;

      for (const event of fundingEvents) {
        if (existingDescriptions.has(event.description)) {
          continue;
        }

        await client.query(
          `INSERT INTO account_transactions (
             user_id, account_id, transaction_type, amount, transaction_date, description
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            accountId,
            event.transactionType,
            event.amount,
            event.transactionDate,
            event.description
          ]
        );

        existingDescriptions.add(event.description);
        insertedCount++;
      }

      if (fundingEvents.length > 0 && !hasManualBaseline) {
        const firstFundingDate = fundingEvents[0].transactionDate;
        await client.query(
          `UPDATE user_accounts
           SET initial_balance_date = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
             AND user_id = $2`,
          [accountId, userId, firstFundingDate]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      marginCoin,
      insertedCount,
      depositsImported: fundingEvents.filter(event => event.transactionType === 'deposit').length,
      withdrawalsImported: fundingEvents.filter(event => event.transactionType === 'withdrawal').length,
      totalDeposited: fundingEvents
        .filter(event => event.transactionType === 'deposit')
        .reduce((sum, event) => sum + event.amount, 0),
      totalWithdrawn: fundingEvents
        .filter(event => event.transactionType === 'withdrawal')
        .reduce((sum, event) => sum + event.amount, 0),
      earliestFundingDate: fundingEvents[0]?.transactionDate || null,
      preservedInitialBalance: Math.abs(existingInitialBalance) > 0.000001,
      preservedInitialBalanceDate: Boolean(existingInitialBalanceDate),
      skippedBaselineReset: hasManualBaseline
    };
  }

  getTradeDateRange(trades) {
    const dates = trades
      .map(trade => trade.tradeDate || trade.exitTime?.split('T')[0] || trade.entryTime?.split('T')[0])
      .filter(Boolean)
      .sort();

    if (dates.length === 0) {
      return { minDate: null, maxDate: null };
    }

    return {
      minDate: dates[0],
      maxDate: dates[dates.length - 1]
    };
  }

  async getExistingTrades(userId, incomingTrades = []) {
    if (!Array.isArray(incomingTrades) || incomingTrades.length === 0) {
      return [];
    }

    const { minDate, maxDate } = this.getTradeDateRange(incomingTrades);
    const params = [userId];

    let query = `
      SELECT symbol, side, quantity, entry_price, exit_price, entry_time, exit_time,
             executions, trade_date, pnl, account_identifier, id,
             stop_loss, take_profit, take_profit_targets, fees, commission, pnl_percent
      FROM trades
      WHERE user_id = $1
    `;

    if (minDate && maxDate) {
      params.push(minDate, maxDate);
      query += `
        AND trade_date >= $2
        AND trade_date <= $3
      `;
    }

    query += `
      ORDER BY trade_date DESC, entry_time DESC
    `;

    const result = await db.query(query, params);
    return result.rows;
  }

  extractPositionIds(executions) {
    return this.tradeParser.extractPositionIds(executions);
  }

  calculateTradePnlPercent(tradeData) {
    return tradeData.pnlPercent !== undefined
      ? tradeData.pnlPercent
      : (
        tradeData.exitPrice !== null && tradeData.entryPrice !== null
          ? Trade.calculatePnLPercent(
            tradeData.entryPrice,
            tradeData.exitPrice,
            tradeData.side,
            tradeData.pnl,
            tradeData.quantity,
            tradeData.instrumentType || 'crypto'
          )
          : null
      );
  }

  isDuplicateTrade(newTrade, existingTrades) {
    const newPositionIds = this.extractPositionIds(newTrade.executionData || []);

    for (const existing of existingTrades) {
      if (String(existing.symbol || '').toUpperCase() !== String(newTrade.symbol || '').toUpperCase()) {
        continue;
      }

      if (
        newTrade.accountIdentifier &&
        existing.account_identifier &&
        newTrade.accountIdentifier !== existing.account_identifier
      ) {
        continue;
      }

      const existingPositionIds = this.extractPositionIds(existing.executions);
      if (newPositionIds.size > 0) {
        for (const positionId of newPositionIds) {
          if (existingPositionIds.has(positionId)) {
            return true;
          }
        }
      }

      const sameTradeDate = (existing.trade_date?.toISOString?.().split('T')[0] || String(existing.trade_date || '').split('T')[0]) === newTrade.tradeDate;
      const sameSide = existing.side === newTrade.side;
      const sameQty = Math.abs((this.tradeParser.parseNumber(existing.quantity) || 0) - (this.tradeParser.parseNumber(newTrade.quantity) || 0)) < 0.000001;
      const sameEntry = Math.abs((this.tradeParser.parseNumber(existing.entry_price) || 0) - (this.tradeParser.parseNumber(newTrade.entryPrice) || 0)) < 0.000001;
      const sameExit = Math.abs((this.tradeParser.parseNumber(existing.exit_price) || 0) - (this.tradeParser.parseNumber(newTrade.exitPrice) || 0)) < 0.000001;

      if (sameTradeDate && sameSide && sameQty && sameEntry && sameExit) {
        return true;
      }
    }

    return false;
  }

  findTradeByPositionId(newTrade, existingTrades) {
    const newPositionIds = this.extractPositionIds(newTrade.executionData || []);
    if (newPositionIds.size === 0) {
      return null;
    }

    return existingTrades.find(existing => {
      const existingPositionIds = this.extractPositionIds(existing.executions);
      for (const positionId of newPositionIds) {
        if (existingPositionIds.has(positionId)) {
          return true;
        }
      }
      return false;
    }) || null;
  }

  hasTradeChanged(existingTrade, newTrade) {
    const existingStopLoss = this.tradeParser.parseNumber(existingTrade.stop_loss);
    const existingTakeProfit = this.tradeParser.parseNumber(existingTrade.take_profit);
    const existingPnL = this.tradeParser.parseNumber(existingTrade.pnl);
    const existingFees = this.tradeParser.parseNumber(existingTrade.fees);
    const existingCommission = this.tradeParser.parseNumber(existingTrade.commission);
    const existingPnLPercent = this.tradeParser.parseNumber(existingTrade.pnl_percent);
    const newPnLPercent = this.calculateTradePnlPercent(newTrade);

    const normalizedExistingTargets = JSON.stringify(existingTrade.take_profit_targets || []);
    const normalizedNewTargets = JSON.stringify(newTrade.takeProfitTargets || []);
    const normalizedExistingExecutions = JSON.stringify(existingTrade.executions || []);
    const normalizedNewExecutions = JSON.stringify(newTrade.executionData || []);

    return (
      existingTrade.exit_time !== newTrade.exitTime ||
      Math.abs((this.tradeParser.parseNumber(existingTrade.entry_price) || 0) - (this.tradeParser.parseNumber(newTrade.entryPrice) || 0)) > 0.000001 ||
      Math.abs((this.tradeParser.parseNumber(existingTrade.exit_price) || 0) - (this.tradeParser.parseNumber(newTrade.exitPrice) || 0)) > 0.000001 ||
      Math.abs((this.tradeParser.parseNumber(existingTrade.quantity) || 0) - (this.tradeParser.parseNumber(newTrade.quantity) || 0)) > 0.000001 ||
      Math.abs((existingPnL || 0) - (this.tradeParser.parseNumber(newTrade.pnl) || 0)) > 0.000001 ||
      Math.abs((existingFees || 0) - (this.tradeParser.parseNumber(newTrade.fees) || 0)) > 0.000001 ||
      Math.abs((existingCommission || 0) - (this.tradeParser.parseNumber(newTrade.commission) || 0)) > 0.000001 ||
      Math.abs((existingPnLPercent || 0) - (this.tradeParser.parseNumber(newPnLPercent) || 0)) > 0.000001 ||
      Math.abs((existingStopLoss || 0) - (this.tradeParser.parseNumber(newTrade.stopLoss) || 0)) > 0.000001 ||
      Math.abs((existingTakeProfit || 0) - (this.tradeParser.parseNumber(newTrade.takeProfit) || 0)) > 0.000001 ||
      normalizedExistingTargets !== normalizedNewTargets ||
      normalizedExistingExecutions !== normalizedNewExecutions
    );
  }

  async updateExistingTrade(userId, connectionId, existingTradeId, tradeData) {
    const pnlPercent = this.calculateTradePnlPercent(tradeData);

    const query = `
      UPDATE trades
      SET trade_date = $1,
          entry_time = $2,
          exit_time = $3,
          entry_price = $4,
          exit_price = $5,
          quantity = $6,
          commission = $7,
          fees = $8,
          pnl = $9,
          pnl_percent = $10,
          stop_loss = $11,
          take_profit = $12,
          take_profit_targets = $13::jsonb,
          executions = $14::jsonb,
          broker_connection_id = COALESCE(broker_connection_id, $15),
          account_identifier = COALESCE(account_identifier, $16),
          updated_at = NOW()
      WHERE id = $17
        AND user_id = $18
    `;

    await db.query(query, [
      tradeData.tradeDate,
      tradeData.entryTime,
      tradeData.exitTime,
      tradeData.entryPrice,
      tradeData.exitPrice,
      tradeData.quantity,
      tradeData.commission || 0,
      tradeData.fees || 0,
      tradeData.pnl,
      pnlPercent,
      tradeData.stopLoss,
      tradeData.takeProfit,
      JSON.stringify(tradeData.takeProfitTargets || []),
      JSON.stringify(tradeData.executionData || []),
      connectionId,
      tradeData.accountIdentifier || null,
      existingTradeId,
      userId
    ]);
  }

  async importTrades(userId, connectionId, trades) {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let duplicates = 0;

    const existingTrades = await this.getExistingTrades(userId, trades);

    for (const tradeData of trades) {
      try {
        const matchingTrade = this.findTradeByPositionId(tradeData, existingTrades);
        if (matchingTrade) {
          if (this.hasTradeChanged(matchingTrade, tradeData)) {
            await this.updateExistingTrade(userId, connectionId, matchingTrade.id, tradeData);
            updated++;

            matchingTrade.trade_date = tradeData.tradeDate;
            matchingTrade.entry_time = tradeData.entryTime;
            matchingTrade.exit_time = tradeData.exitTime;
            matchingTrade.entry_price = tradeData.entryPrice;
            matchingTrade.exit_price = tradeData.exitPrice;
            matchingTrade.quantity = tradeData.quantity;
            matchingTrade.commission = tradeData.commission || 0;
            matchingTrade.fees = tradeData.fees || 0;
            matchingTrade.pnl = tradeData.pnl;
            matchingTrade.stop_loss = tradeData.stopLoss;
            matchingTrade.take_profit = tradeData.takeProfit;
            matchingTrade.take_profit_targets = tradeData.takeProfitTargets || [];
            matchingTrade.executions = tradeData.executionData || [];
          } else {
            duplicates++;
          }
          continue;
        }

        if (this.isDuplicateTrade(tradeData, existingTrades)) {
          duplicates++;
          continue;
        }

        tradeData.brokerConnectionId = connectionId;

        await Trade.create(userId, tradeData, {
          skipAchievements: true,
          skipApiCalls: true
        });

        imported++;

        existingTrades.push({
          symbol: tradeData.symbol,
          side: tradeData.side,
          quantity: tradeData.quantity,
          entry_price: tradeData.entryPrice,
          exit_price: tradeData.exitPrice,
          entry_time: tradeData.entryTime,
          exit_time: tradeData.exitTime,
          trade_date: tradeData.tradeDate,
          pnl: tradeData.pnl,
          account_identifier: tradeData.accountIdentifier,
          executions: tradeData.executionData || []
        });
      } catch (error) {
        console.error('[BITUNIX] Failed to import trade:', error.message);
        failed++;
      }
    }

    if (imported > 0 || updated > 0) {
      await AnalyticsCache.invalidateUserCache(userId);
      invalidateInMemoryCache(userId);
    }

    return { imported, updated, skipped, failed, duplicates };
  }

  async syncTrades(connection, options = {}) {
    const { startDate, endDate, syncLogId } = options;
    const marginCoin = String(connection.bitunixMarginCoin || DEFAULT_MARGIN_COIN).toUpperCase();

    if (syncLogId) {
      await BrokerConnection.updateSyncLog(syncLogId, 'fetching');
    }

    const pendingPositions = await this.apiClient.getPendingPositions(
      connection.bitunixApiKey,
      connection.bitunixApiSecret
    );

    const [
      { effectiveHistoryStartDate, historyTrades },
      historyPositions,
      pendingOrders,
      pendingTpSlOrders,
      historyOrders,
      historyTpSlOrders
    ] = await Promise.all([
      this.fetchTradeHistorySnapshot(
        connection.bitunixApiKey,
        connection.bitunixApiSecret,
        pendingPositions,
        { startDate, endDate }
      ),
      this.apiClient.getHistoryPositions(connection.bitunixApiKey, connection.bitunixApiSecret, { startDate, endDate }),
      this.apiClient.getPendingOrders(connection.bitunixApiKey, connection.bitunixApiSecret),
      this.apiClient.getPendingTpSlOrders(connection.bitunixApiKey, connection.bitunixApiSecret),
      this.safeOptionalFetch('history orders', () =>
        this.apiClient.getHistoryOrders(connection.bitunixApiKey, connection.bitunixApiSecret, { startDate, endDate })
      ),
      this.safeOptionalFetch('history TP/SL orders', () =>
        this.apiClient.getHistoryTpSlOrders(connection.bitunixApiKey, connection.bitunixApiSecret, { startDate, endDate })
      )
    ]);

    let finalPendingPositions = pendingPositions;
    let finalHistoryTrades = historyTrades;

    await new Promise(resolve => setTimeout(resolve, OPEN_POSITION_RETRY_DELAY_MS));

    try {
      const retryPendingPositions = await this.apiClient.getPendingPositions(
        connection.bitunixApiKey,
        connection.bitunixApiSecret
      );
      const { historyTrades: retryHistoryTrades } = await this.fetchTradeHistorySnapshot(
        connection.bitunixApiKey,
        connection.bitunixApiSecret,
        retryPendingPositions,
        { startDate: effectiveHistoryStartDate, endDate }
      );

      finalPendingPositions = this.tradeParser.mergePendingPositions(finalPendingPositions, retryPendingPositions);
      finalHistoryTrades = this.tradeParser.mergeHistoryTrades(finalHistoryTrades, retryHistoryTrades);
    } catch (error) {
      console.warn('[BITUNIX] Retry fetch for open positions failed:', error.message);
    }

    const trades = this.tradeParser.parsePositions(
      historyPositions,
      finalPendingPositions,
      pendingOrders,
      pendingTpSlOrders,
      marginCoin,
      finalHistoryTrades,
      historyOrders,
      historyTpSlOrders
    );

    if (syncLogId) {
      await BrokerConnection.updateSyncLog(syncLogId, 'importing', {
        tradesFetched: trades.length
      });
    }

    return this.importTrades(connection.userId, connection.id, trades);
  }
}

module.exports = new BitunixService();
