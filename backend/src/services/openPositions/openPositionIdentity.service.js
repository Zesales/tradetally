const { v5: uuidv5 } = require('uuid');

class OpenPositionIdentityService {
  static TRADE_POSITION_PREFIX = 'position-';

  static LEGACY_TRADE_PREFIX = 'trade-';

  static LEGACY_ENCODED_PREFIX = 'position-';

  static POSITION_NAMESPACE = '3b8ec5ab-5d9f-4c4e-9d69-1e7f5f4f8f35';

  static slugifyPart(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  static buildPositionIdentityKey(position = {}) {
    return JSON.stringify({
      positionKey: position.positionKey || position.symbol || '',
      side: position.side || 'long',
      instrumentType: position.instrumentType || 'stock',
      symbol: position.symbol || ''
    });
  }

  static buildSlugPositionId(position = {}) {
    const parts = [
      this.slugifyPart(position.symbol || 'position'),
      this.slugifyPart(position.side || 'long'),
      this.slugifyPart(position.instrumentType || 'stock'),
      this.slugifyPart(position.positionKey || position.symbol || 'default')
    ].filter(Boolean);

    return `${this.TRADE_POSITION_PREFIX}${parts.join('__')}`;
  }

  static buildPositionId(position = {}) {
    const identityKey = this.buildPositionIdentityKey(position);
    return `${this.TRADE_POSITION_PREFIX}${uuidv5(identityKey, this.POSITION_NAMESPACE)}`;
  }

  static buildLegacyEncodedPositionId(position = {}) {
    const identityPayload = this.buildPositionIdentityKey(position);

    return `${this.LEGACY_ENCODED_PREFIX}${Buffer.from(identityPayload).toString('base64url')}`;
  }

  static buildLegacyPositionId(symbol) {
    return `${this.LEGACY_TRADE_PREFIX}${String(symbol || '').toUpperCase()}`;
  }

  static isTradePositionId(id) {
    const normalizedId = String(id || '');
    return normalizedId.startsWith(this.TRADE_POSITION_PREFIX) || normalizedId.startsWith(this.LEGACY_TRADE_PREFIX);
  }

  static isLegacyTradePositionId(id) {
    return String(id || '').startsWith(this.LEGACY_TRADE_PREFIX);
  }

  static parseLegacyEncodedPositionId(id) {
    const normalizedId = String(id || '');
    if (!normalizedId.startsWith(this.TRADE_POSITION_PREFIX)) {
      return null;
    }

    const encoded = normalizedId.slice(this.TRADE_POSITION_PREFIX.length);
    if (!encoded || encoded.includes('__')) {
      return null;
    }

    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  static matchesPosition(position = {}, id) {
    const normalizedId = String(id || '');
    if (!normalizedId) {
      return false;
    }

    if (
      normalizedId === this.buildPositionId(position)
      || normalizedId === this.buildSlugPositionId(position)
      || normalizedId === this.buildLegacyEncodedPositionId(position)
      || normalizedId === this.buildLegacyPositionId(position.symbol)
    ) {
      return true;
    }

    const parsed = this.parseLegacyEncodedPositionId(normalizedId);
    if (!parsed) {
      return false;
    }

    return String(parsed.positionKey || '') === String(position.positionKey || '')
      && String(parsed.symbol || '').toUpperCase() === String(position.symbol || '').toUpperCase()
      && String(parsed.side || 'long') === String(position.side || 'long')
      && String(parsed.instrumentType || 'stock') === String(position.instrumentType || 'stock');
  }

  static getLegacySymbol(id) {
    if (!this.isLegacyTradePositionId(id)) {
      return null;
    }

    return String(id).slice(this.LEGACY_TRADE_PREFIX.length).toUpperCase() || null;
  }
}

module.exports = OpenPositionIdentityService;
