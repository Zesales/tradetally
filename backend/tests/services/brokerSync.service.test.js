jest.mock('axios', () => ({
  get: jest.fn()
}));

jest.mock('../../src/utils/csvParser', () => ({
  parseCSV: jest.fn()
}));

jest.mock('../../src/models/Trade', () => ({
  create: jest.fn()
}));

jest.mock('../../src/models/BrokerConnection', () => ({
  findById: jest.fn(),
  createSyncLog: jest.fn(),
  updateSyncLog: jest.fn(),
  updateAfterSync: jest.fn(),
  calculateNextSync: jest.fn(),
  updateSchwabTokens: jest.fn(),
  updateStatus: jest.fn()
}));

jest.mock('../../src/services/analyticsCache', () => ({
  invalidateUserCache: jest.fn()
}));

jest.mock('../../src/utils/cache', () => ({
  data: {},
  del: jest.fn()
}));

jest.mock('../../src/config/database', () => ({
  query: jest.fn()
}));

const Trade = require('../../src/models/Trade');
const BrokerConnection = require('../../src/models/BrokerConnection');
const db = require('../../src/config/database');
const brokerSyncService = require('../../src/services/brokerSync');
const ibkrService = require('../../src/services/brokerSync/ibkrService');
const schwabService = require('../../src/services/brokerSync/schwabService');
const bitunixService = require('../../src/services/brokerSync/bitunixService');

describe('broker sync duplicate protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('IBKR importTrades skips a duplicate trade repeated within the same sync batch', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    Trade.create.mockResolvedValue({ id: 'trade-1' });

    const trade = {
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryTime: '2026-03-06T15:00:00Z',
      tradeDate: '2026-03-06',
      executionData: [
        {
          datetime: '2026-03-06T15:00:00Z',
          quantity: 10,
          type: 'entry'
        }
      ]
    };

    const result = await ibkrService.importTrades('user-1', [trade, { ...trade }], {});

    expect(Trade.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      imported: 1,
      duplicates: 1,
      failed: 0
    });
  });

  test('IBKR existing trade lookup is scoped to the incoming sync date range', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await ibkrService.getExistingTradesForDuplicateCheck('user-1', [
      { tradeDate: '2026-03-05' },
      { entryTime: '2026-03-07T12:30:00Z' }
    ]);

    const [query, params] = db.query.mock.calls[0];
    expect(query).toContain('trade_date >= $2');
    expect(query).toContain('trade_date <= $3');
    expect(query).not.toContain('LIMIT 1000');
    expect(params).toEqual(['user-1', '2026-03-05', '2026-03-07']);
  });

  test('IBKR duplicate detection falls back to closed-trade fields when executions do not match', () => {
    const isDuplicate = ibkrService.isDuplicateTrade(
      {
        symbol: 'AAPL',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        exitPrice: 104,
        pnl: 40,
        entryTime: '2026-03-06T15:00:00Z',
        tradeDate: '2026-03-06',
        executionData: [
          { datetime: '2026-03-06T15:00:05Z', quantity: 10, price: 100, action: 'buy' }
        ]
      },
      [
        {
          symbol: 'AAPL',
          side: 'long',
          quantity: 10,
          entry_price: 100,
          exit_price: 104,
          pnl: 40,
          entry_time: '2026-03-06T15:00:00Z',
          trade_date: '2026-03-06',
          instrument_type: 'stock',
          executions: [
            { datetime: '2026-03-06T15:10:00Z', quantity: 10, price: 104, action: 'sell' }
          ]
        }
      ],
      {}
    );

    expect(isDuplicate).toBe(true);
  });

  test('IBKR execution matching uses order IDs when they are present', () => {
    expect(
      ibkrService.executionsMatch(
        { orderId: 'abc123', datetime: '2026-03-06T15:00:00Z', quantity: 5, price: 100 },
        { orderId: 'abc123', datetime: '2026-03-06T15:30:00Z', quantity: 5, price: 101 }
      )
    ).toBe(true);
  });

  test('IBKR manual sync defaults to a bounded Flex date override window', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-09T12:00:00Z'));

    const params = ibkrService.buildReportRequestParams('token-1', 'query-1', {
      syncType: 'manual'
    });

    const start = new Date(`${params.fd.slice(0, 4)}-${params.fd.slice(4, 6)}-${params.fd.slice(6, 8)}T00:00:00Z`);
    const end = new Date(`${params.td.slice(0, 4)}-${params.td.slice(4, 6)}-${params.td.slice(6, 8)}T00:00:00Z`);
    const daySpan = Math.floor((end - start) / 86400000) + 1;

    expect(params).toMatchObject({
      t: 'token-1',
      q: 'query-1',
      v: '3',
      td: '20260309'
    });
    expect(daySpan).toBe(365);

    jest.useRealTimers();
  });

  test('IBKR explicit Flex date overrides reject ranges longer than 365 days', () => {
    expect(() => {
      ibkrService.normalizeReportDateRange('2025-01-01', '2026-01-01');
    }).toThrow('IBKR Flex Web Service supports up to 365 days per request');
  });

  test('Schwab importTrades skips a trade already imported by a previous sync', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          symbol: 'AAPL',
          side: 'long',
          quantity: 5,
          entry_price: 100,
          exit_price: 105,
          entry_time: '2026-03-06T14:30:00Z',
          exit_time: '2026-03-06T15:00:00Z',
          trade_date: '2026-03-06',
          pnl: 25,
          instrument_type: 'stock',
          executions: [
            {
              datetime: '2026-03-06T15:00:00Z',
              type: 'exit',
              orderId: 'exit-123'
            }
          ]
        }
      ]
    });

    const result = await schwabService.importTrades('user-1', 'conn-1', [
      {
        symbol: 'AAPL',
        side: 'long',
        quantity: 5,
        entryPrice: 100,
        exitPrice: 105,
        entryTime: '2026-03-06T14:30:00Z',
        exitTime: '2026-03-06T15:00:00Z',
        tradeDate: '2026-03-06',
        pnl: 25,
        instrumentType: 'stock',
        executionData: [
          {
            datetime: '2026-03-06T15:00:00Z',
            type: 'exit',
            orderId: 'exit-123'
          }
        ]
      }
    ]);

    expect(Trade.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      imported: 0,
      duplicates: 1,
      failed: 0
    });
  });

  test('Schwab existing trade lookup is scoped to the incoming sync date range', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await schwabService.getExistingTrades('user-1', [
      { tradeDate: '2026-03-05' },
      { exitTime: '2026-03-08T09:15:00Z' }
    ]);

    const [query, params] = db.query.mock.calls[0];
    expect(query).toContain('trade_date >= $2');
    expect(query).toContain('trade_date <= $3');
    expect(query).not.toContain('LIMIT 5000');
    expect(params).toEqual(['user-1', '2026-03-05', '2026-03-08']);
  });

  test('Bitunix sync extends history trade lookup to cover older open position entries', async () => {
    const connection = {
      id: 'conn-1',
      userId: 'user-1',
      bitunixApiKey: 'api-key',
      bitunixApiSecret: 'api-secret',
      bitunixMarginCoin: 'USDT'
    };

    jest.spyOn(bitunixService.apiClient, 'getHistoryPositions').mockResolvedValueOnce([]);
    const pendingPosition = {
      positionId: 'position-1',
      symbol: 'XRPUSDT',
      side: 'LONG',
      qty: '40.9',
      avgOpenPrice: '1.9224',
      ctime: new Date('2025-11-16T21:00:14.000Z').getTime()
    };
    jest.spyOn(bitunixService.apiClient, 'getPendingPositions')
      .mockResolvedValueOnce([pendingPosition])
      .mockResolvedValueOnce([pendingPosition]);
    jest.spyOn(bitunixService.apiClient, 'getPendingOrders').mockResolvedValueOnce([]);
    jest.spyOn(bitunixService.apiClient, 'getPendingTpSlOrders').mockResolvedValueOnce([]);
    jest.spyOn(bitunixService.apiClient, 'getHistoryOrders').mockResolvedValueOnce([]);
    jest.spyOn(bitunixService.apiClient, 'getHistoryTpSlOrders').mockResolvedValueOnce([]);
    const getHistoryTradesSpy = jest
      .spyOn(bitunixService.apiClient, 'getHistoryTrades')
      .mockResolvedValue([]);
    jest.spyOn(bitunixService, 'importTrades').mockResolvedValueOnce({
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      duplicates: 0
    });

    await bitunixService.syncTrades(connection, {
      startDate: '2026-03-20',
      endDate: '2026-03-24'
    });

    expect(getHistoryTradesSpy.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'api-key',
          'api-secret',
          {
            startDate: '2025-11-16',
            endDate: '2026-03-24'
          }
        ],
        [
          'api-key',
          'api-secret',
          {
            startDate: '2026-03-20',
            endDate: '2026-03-24',
            symbol: 'XRPUSDT',
            positionId: 'position-1'
          }
        ]
      ])
    );
  });

  test('scheduled Bitunix no-op sync preserves the previous visible imported count on the connection', async () => {
    const connection = {
      id: 'conn-1',
      userId: 'user-1',
      brokerType: 'bitunix',
      connectionStatus: 'active',
      autoSyncEnabled: true,
      syncFrequency: 'daily',
      syncTime: '06:00:00',
      lastSyncTradesImported: 17,
      lastSyncTradesSkipped: 3
    };

    BrokerConnection.findById.mockResolvedValueOnce(connection);
    BrokerConnection.createSyncLog.mockResolvedValueOnce({ id: 'log-1' });
    BrokerConnection.updateSyncLog.mockResolvedValue({});
    BrokerConnection.updateAfterSync.mockResolvedValue({});
    BrokerConnection.calculateNextSync.mockReturnValue(new Date('2026-03-30T06:00:00Z'));

    jest.spyOn(bitunixService, 'syncTrades').mockResolvedValueOnce({
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      duplicates: 0,
      tradesFetched: 0,
      syncDetails: {
        mode: 'light',
        fullSyncTriggered: false,
        reason: 'no_pending_snapshot_changes'
      }
    });
    jest.spyOn(brokerSyncService, 'closeExpiredOptions').mockResolvedValueOnce(0);

    const result = await brokerSyncService.syncConnection('conn-1', {
      syncType: 'scheduled'
    });

    expect(result).toMatchObject({
      success: true,
      imported: 0,
      tradesImported: 0
    });
    expect(BrokerConnection.updateSyncLog).toHaveBeenLastCalledWith('log-1', 'completed', expect.objectContaining({
      tradesImported: 0
    }));
    expect(BrokerConnection.updateAfterSync).toHaveBeenCalledWith(
      'conn-1',
      17,
      3,
      expect.any(Date)
    );
  });
});
