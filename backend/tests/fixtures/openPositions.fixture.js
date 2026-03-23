function isoDay(day, time) {
  return `2026-03-${String(day).padStart(2, '0')}T${time}:00Z`;
}

function createExecution({
  type = 'entry',
  action,
  quantity,
  price,
  datetime,
  side,
  extra = {}
}) {
  return {
    type,
    action,
    quantity,
    price,
    datetime,
    side,
    ...extra
  };
}

function buildMixedOpenTradesFixture() {
  const trades = [];

  for (let index = 0; index < 8; index += 1) {
    trades.push({
      id: `manual-aapl-${index + 1}`,
      symbol: 'AAPL',
      side: 'long',
      quantity: 1,
      entry_price: 180 + index,
      entry_time: isoDay(20 + (index % 3), `10:${String(index).padStart(2, '0')}`),
      trade_date: `2026-03-${String(20 + (index % 3)).padStart(2, '0')}`,
      broker: null,
      instrument_type: 'stock',
      executions: []
    });
  }

  for (let index = 0; index < 8; index += 1) {
    const quantity = 2 + (index % 3);
    const price = 420 + index;
    trades.push({
      id: `schwab-msft-${index + 1}`,
      symbol: 'MSFT',
      side: 'long',
      quantity,
      entry_price: price,
      entry_time: isoDay(20 + (index % 3), `11:${String(index).padStart(2, '0')}`),
      trade_date: `2026-03-${String(20 + (index % 3)).padStart(2, '0')}`,
      broker: 'schwab',
      instrument_type: 'stock',
      executions: [
        createExecution({
          type: 'entry',
          action: 'buy',
          quantity,
          price,
          datetime: isoDay(20 + (index % 3), `11:${String(index).padStart(2, '0')}`),
          side: 'long'
        })
      ]
    });
  }

  for (let index = 0; index < 7; index += 1) {
    const quantity = 1;
    const price = 6.5 + (index * 0.25);
    trades.push({
      id: `ibkr-aapl-call-${index + 1}`,
      symbol: 'AAPL 2026-04-17 C200',
      side: 'long',
      quantity,
      entry_price: price,
      entry_time: isoDay(21 + (index % 2), `12:${String(index).padStart(2, '0')}`),
      trade_date: `2026-03-${String(21 + (index % 2)).padStart(2, '0')}`,
      broker: 'ibkr',
      instrument_type: 'option',
      contract_size: 100,
      underlying_symbol: 'AAPL',
      strike_price: 200,
      expiration_date: '2026-04-17',
      option_type: 'call',
      executions: [
        createExecution({
          type: 'entry',
          action: 'buy',
          quantity,
          price,
          datetime: isoDay(21 + (index % 2), `12:${String(index).padStart(2, '0')}`),
          side: 'long'
        })
      ]
    });
  }

  const bitunixExecutions = [
    createExecution({
      type: 'entry',
      action: 'buy',
      quantity: 0.004,
      price: 68000,
      datetime: isoDay(20, '13:00'),
      side: 'long',
      extra: { leverage: 20, marginUsed: 13.6, notionalValue: 272, positionId: 'bitunix-btc-open' }
    }),
    createExecution({
      type: 'entry',
      action: 'buy',
      quantity: 0.002,
      price: 69000,
      datetime: isoDay(21, '14:00'),
      side: 'long',
      extra: { leverage: 20, marginUsed: 6.9, notionalValue: 138, positionId: 'bitunix-btc-open' }
    }),
    createExecution({
      type: 'exit',
      action: 'sell',
      quantity: 0.0015,
      price: 70000,
      datetime: isoDay(22, '15:00'),
      side: 'long',
      extra: { leverage: 20, positionId: 'bitunix-btc-open' }
    })
  ];

  trades.push({
    id: 'bitunix-btc-open-1',
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.0045,
    entry_price: 68333.3333,
    entry_time: isoDay(20, '13:00'),
    trade_date: '2026-03-20',
    broker: 'bitunix',
    instrument_type: 'crypto',
    executions: bitunixExecutions
  });

  trades.push({
    id: 'bitunix-btc-open-stale-zero',
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.001,
    entry_price: 67500,
    entry_time: isoDay(20, '09:00'),
    trade_date: '2026-03-20',
    broker: 'bitunix',
    instrument_type: 'crypto',
    executions: [
      createExecution({
        type: 'entry',
        action: 'buy',
        quantity: 0.001,
        price: 67500,
        datetime: isoDay(20, '09:00'),
        side: 'long',
        extra: { positionId: 'bitunix-zero-net' }
      }),
      createExecution({
        type: 'exit',
        action: 'sell',
        quantity: 0.001,
        price: 67600,
        datetime: isoDay(20, '09:30'),
        side: 'long',
        extra: { positionId: 'bitunix-zero-net' }
      })
    ]
  });

  return trades;
}

module.exports = {
  buildMixedOpenTradesFixture
};
