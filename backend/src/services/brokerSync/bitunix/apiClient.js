const axios = require('axios');
const crypto = require('crypto');
const {
  BITUNIX_API_BASE,
  BITUNIX_SPOT_API_BASE,
  DEFAULT_MARGIN_COIN,
  PAGE_SIZE
} = require('./constants');

class BitunixApiClient {
  toBitunixTimestamp(value, { endOfDay = false } = {}) {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value.getTime();
    }

    const normalizedValue = String(value).trim();
    if (!normalizedValue) {
      return null;
    }

    const hasExplicitTime = normalizedValue.includes('T') || /\d{2}:\d{2}/.test(normalizedValue);
    const dateValue = hasExplicitTime
      ? new Date(normalizedValue)
      : new Date(`${normalizedValue}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);

    return Number.isNaN(dateValue.getTime()) ? null : dateValue.getTime();
  }

  generateNonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  buildQuerySignatureString(params = {}) {
    return Object.keys(params)
      .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
      .sort()
      .map(key => `${key}${params[key]}`)
      .join('');
  }

  buildHeaders(apiKey, apiSecret, queryParams = {}, body = '') {
    const nonce = this.generateNonce();
    const timestamp = Date.now().toString();
    const queryString = this.buildQuerySignatureString(queryParams);
    const bodyString = body || '';
    const digest = this.sha256Hex(`${nonce}${timestamp}${apiKey}${queryString}${bodyString}`);
    const sign = this.sha256Hex(`${digest}${apiSecret}`);

    return {
      'api-key': apiKey,
      nonce,
      timestamp,
      sign,
      language: 'en-US',
      'Content-Type': 'application/json'
    };
  }

  async request({ apiKey, apiSecret, method = 'GET', path, query = {}, body = null, baseURL = BITUNIX_API_BASE }) {
    const compactBody = body ? JSON.stringify(body) : '';
    const headers = this.buildHeaders(apiKey, apiSecret, query, compactBody);

    const response = await axios({
      method,
      url: `${baseURL}${path}`,
      params: query,
      data: body || undefined,
      headers,
      timeout: 30000
    });

    if (String(response.data?.code) !== '0') {
      throw new Error(response.data?.msg || `Bitunix API request failed (${response.data?.code ?? 'unknown'})`);
    }

    return response.data;
  }

  async validateCredentials(apiKey, apiSecret, marginCoin = DEFAULT_MARGIN_COIN) {
    const normalizedMarginCoin = String(marginCoin || DEFAULT_MARGIN_COIN).toUpperCase();
    await this.request({
      apiKey,
      apiSecret,
      path: '/api/v1/futures/account',
      query: { marginCoin: normalizedMarginCoin }
    });
  }

  async getHistoryPositions(apiKey, apiSecret, { startDate, endDate } = {}) {
    const positions = [];
    let skip = 0;
    let total = Infinity;

    while (skip < total) {
      const query = {
        skip,
        limit: PAGE_SIZE
      };

      if (startDate) {
        query.startTime = new Date(`${startDate}T00:00:00.000Z`).getTime();
      }
      if (endDate) {
        query.endTime = new Date(`${endDate}T23:59:59.999Z`).getTime();
      }

      const result = await this.request({
        apiKey,
        apiSecret,
        path: '/api/v1/futures/position/get_history_positions',
        query
      });

      const page = result.data?.positionList || [];
      total = Number(result.data?.total || page.length);
      positions.push(...page);

      if (page.length < PAGE_SIZE) {
        break;
      }

      skip += page.length;
    }

    return positions;
  }

  async getPendingPositions(apiKey, apiSecret) {
    const result = await this.request({
      apiKey,
      apiSecret,
      path: '/api/v1/futures/position/get_pending_positions'
    });

    return Array.isArray(result.data) ? result.data : [];
  }

  async getPendingOrders(apiKey, apiSecret) {
    const orders = [];
    let skip = 0;
    let total = Infinity;

    while (skip < total) {
      const result = await this.request({
        apiKey,
        apiSecret,
        path: '/api/v1/futures/trade/get_pending_orders',
        query: {
          skip,
          limit: PAGE_SIZE
        }
      });

      const page = result.data?.orderList || [];
      total = Number(result.data?.total || page.length);
      orders.push(...page);

      if (page.length < PAGE_SIZE) {
        break;
      }

      skip += page.length;
    }

    return orders;
  }

  async getPendingTpSlOrders(apiKey, apiSecret) {
    const orders = [];
    let skip = 0;

    while (true) {
      const result = await this.request({
        apiKey,
        apiSecret,
        path: '/api/v1/futures/tpsl/get_pending_orders',
        query: {
          skip,
          limit: PAGE_SIZE
        }
      });

      const page = Array.isArray(result.data) ? result.data : [];
      orders.push(...page);

      if (page.length < PAGE_SIZE) {
        break;
      }

      skip += page.length;
    }

    return orders;
  }

  async getHistoryTrades(apiKey, apiSecret, { startDate, endDate, symbol, positionId } = {}) {
    const trades = [];
    const seen = new Set();
    const startTime = this.toBitunixTimestamp(startDate);
    let cursorEndTime = this.toBitunixTimestamp(endDate, { endOfDay: true }) || Date.now();
    let previousOldestTime = null;

    for (let windowIndex = 0; windowIndex < 50; windowIndex++) {
      let skip = 0;
      let total = Infinity;
      let windowCount = 0;
      let oldestFillTime = null;

      while (skip < total) {
        const query = {
          skip,
          limit: PAGE_SIZE
        };

        if (startTime) {
          query.startTime = startTime;
        }
        if (cursorEndTime) {
          query.endTime = cursorEndTime;
        }
        if (symbol) {
          query.symbol = symbol;
        }
        if (positionId) {
          query.positionId = positionId;
        }

        const result = await this.request({
          apiKey,
          apiSecret,
          path: '/api/v1/futures/trade/get_history_trades',
          query
        });

        const data = result.data;
        const page = Array.isArray(data)
          ? data
          : (data?.tradeList || data?.orderList || data?.list || []);

        if (!page.length) {
          total = 0;
          break;
        }

        total = Number(data?.total || page.length);
        windowCount += page.length;

        page.forEach(fill => {
          const key = [
            fill?.positionId || '',
            fill?.tradeId || '',
            fill?.orderId || '',
            fill?.ctime || fill?.mtime || '',
            fill?.price || '',
            fill?.qty || ''
          ].join(':');

          if (!seen.has(key)) {
            seen.add(key);
            trades.push(fill);
          }

          const fillTime = Number(fill?.ctime || fill?.mtime);
          if (Number.isFinite(fillTime)) {
            oldestFillTime = oldestFillTime === null ? fillTime : Math.min(oldestFillTime, fillTime);
          }
        });

        if (page.length < PAGE_SIZE) {
          break;
        }

        skip += page.length;

        if (!Number.isFinite(total) || total <= PAGE_SIZE) {
          break;
        }
      }

      if (oldestFillTime === null) {
        break;
      }

      if (startTime !== null && oldestFillTime <= startTime) {
        break;
      }

      if (windowCount < PAGE_SIZE) {
        break;
      }

      if (previousOldestTime !== null && oldestFillTime >= previousOldestTime) {
        break;
      }

      previousOldestTime = oldestFillTime;
      cursorEndTime = oldestFillTime - 1;
    }

    return trades;
  }

  async getHistoryOrders(apiKey, apiSecret, { startDate, endDate } = {}) {
    const orders = [];
    let skip = 0;
    let total = Infinity;

    while (skip < total) {
      const query = {
        skip,
        limit: PAGE_SIZE
      };

      const startTime = this.toBitunixTimestamp(startDate);
      const endTime = this.toBitunixTimestamp(endDate, { endOfDay: true });
      if (startTime) {
        query.startTime = startTime;
      }
      if (endTime) {
        query.endTime = endTime;
      }

      const result = await this.request({
        apiKey,
        apiSecret,
        path: '/api/v1/futures/trade/get_history_orders',
        query
      });

      const page = result.data?.orderList || [];
      total = Number(result.data?.total || page.length);
      orders.push(...page);

      if (page.length < PAGE_SIZE) {
        break;
      }

      skip += page.length;
    }

    return orders;
  }

  async getHistoryTpSlOrders(apiKey, apiSecret, { startDate, endDate } = {}) {
    const orders = [];
    let skip = 0;
    let total = Infinity;

    while (skip < total) {
      const query = {
        skip,
        limit: PAGE_SIZE
      };

      const startTime = this.toBitunixTimestamp(startDate);
      const endTime = this.toBitunixTimestamp(endDate, { endOfDay: true });
      if (startTime) {
        query.startTime = startTime;
      }
      if (endTime) {
        query.endTime = endTime;
      }

      const result = await this.request({
        apiKey,
        apiSecret,
        path: '/api/v1/futures/tpsl/get_history_orders',
        query
      });

      const page = result.data?.orderList || [];
      total = Number(result.data?.total || page.length);
      orders.push(...page);

      if (page.length < PAGE_SIZE) {
        break;
      }

      skip += page.length;
    }

    return orders;
  }

  async getDepositRecords(apiKey, apiSecret, { coin, startTime, endTime, limit = 100 } = {}) {
    const body = {
      coin,
      limit
    };

    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;

    const result = await this.request({
      apiKey,
      apiSecret,
      method: 'POST',
      path: '/api/spot/v1/deposit/page',
      body,
      baseURL: BITUNIX_SPOT_API_BASE
    });

    return Array.isArray(result.data) ? result.data : [];
  }

  async getWithdrawalRecords(apiKey, apiSecret, { coin, startTime, endTime, limit = 100 } = {}) {
    const body = {
      coin,
      limit
    };

    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;

    const result = await this.request({
      apiKey,
      apiSecret,
      method: 'POST',
      path: '/api/spot/v1/withdraw_transfer/page',
      body,
      baseURL: BITUNIX_SPOT_API_BASE
    });

    return Array.isArray(result.data) ? result.data : [];
  }
}

module.exports = BitunixApiClient;
