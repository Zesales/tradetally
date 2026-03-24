const DEFAULT_LOCALE = 'en-US'

function toFiniteNumber(value) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : 0
}

function getDigitsBeforeDecimal(value) {
  const absoluteValue = Math.abs(toFiniteNumber(value))

  if (absoluteValue < 1) {
    return 1
  }

  return Math.floor(absoluteValue).toString().length
}

function resolveMaximumFractionDigits(value, scale = []) {
  const digitsBeforeDecimal = getDigitsBeforeDecimal(value)

  for (const rule of scale) {
    if (digitsBeforeDecimal <= rule.maxDigitsBeforeDecimal) {
      return rule.maxFractionDigits
    }
  }

  const fallbackRule = scale[scale.length - 1]
  return fallbackRule ? fallbackRule.maxFractionDigits : 2
}

export function formatAdaptiveNumber(value, options = {}) {
  const numericValue = toFiniteNumber(value)
  const {
    locale = DEFAULT_LOCALE,
    minimumFractionDigits = 0,
    scale = []
  } = options

  const maximumFractionDigits = resolveMaximumFractionDigits(numericValue, scale)

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits
  }).format(numericValue)
}

export const calendarCurrencyScale = [
  { maxDigitsBeforeDecimal: 2, maxFractionDigits: 2 },
  { maxDigitsBeforeDecimal: 3, maxFractionDigits: 1 },
  { maxDigitsBeforeDecimal: Infinity, maxFractionDigits: 0 }
]

export function formatCalendarCurrency(value, options = {}) {
  return formatAdaptiveNumber(value, {
    scale: calendarCurrencyScale,
    ...options
  })
}

export {
  getDigitsBeforeDecimal,
  resolveMaximumFractionDigits
}
