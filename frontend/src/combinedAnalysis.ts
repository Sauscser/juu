export type CombinedOperator = 'add' | 'subtract' | 'multiply' | 'divide'

export type CombinedInputReport = {
  metric: { unit: string }
  timeSeries: Array<{ period: string; value: number }>
}

export type CombinedSide = { value: number; unit: string }
export type CombinedResult = {
  left: CombinedSide
  right: CombinedSide
  value: number | null
  unit: string
  timeSeries: Array<{ period: string; left: number; right: number; value: number | null }>
}

export function combineReportGroups(
  leftReports: CombinedInputReport[],
  rightReports: CombinedInputReport[],
  operator: CombinedOperator,
): CombinedResult {
  if (!leftReports.length || !rightReports.length) {
    throw new Error('Each group must contain at least one metric report.')
  }
  const leftUnit = groupUnit(leftReports)
  const rightUnit = groupUnit(rightReports)
  if ((operator === 'add' || operator === 'subtract') && leftUnit !== rightUnit) {
    throw new Error('Addition and subtraction require both groups to use the same unit.')
  }

  const leftByPeriod = aggregatePeriods(leftReports)
  const rightByPeriod = aggregatePeriods(rightReports)
  const periods = [...new Set([...leftByPeriod.keys(), ...rightByPeriod.keys()])].sort()
  const leftValue = totalAcrossPeriods(leftByPeriod)
  const rightValue = totalAcrossPeriods(rightByPeriod)
  const unit = operator === 'add' || operator === 'subtract'
    ? leftUnit
    : operator === 'multiply'
      ? `${leftUnit}·${rightUnit}`
      : `${leftUnit}/${rightUnit}`
  const timeSeries = periods.map((period) => {
    const left = leftByPeriod.get(period) ?? 0
    const right = rightByPeriod.get(period) ?? 0
    return { period, left, right, value: applyCombinedOperation(operator, left, right) ?? null }
  })

  return {
    left: { value: leftValue, unit: leftUnit },
    right: { value: rightValue, unit: rightUnit },
    value: periods.length ? applyCombinedOperation(operator, leftValue, rightValue) ?? null : null,
    unit,
    timeSeries,
  }
}

function groupUnit(reports: CombinedInputReport[]): string {
  const unit = reports[0].metric.unit
  if (reports.some((report) => report.metric.unit !== unit)) {
    throw new Error('Metrics within each group must use the same unit because the group adds its selected values.')
  }
  return unit
}

function aggregatePeriods(reports: CombinedInputReport[]): Map<string, number> {
  const periods = new Map<string, number>()
  for (const report of reports) {
    for (const item of report.timeSeries) {
      periods.set(item.period, (periods.get(item.period) ?? 0) + item.value)
    }
  }
  return periods
}

function totalAcrossPeriods(periods: Map<string, number>): number {
  const total = [...periods.values()].reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total)) throw new Error('The combined metric value exceeded the finite numeric range.')
  return total
}

export function applyCombinedOperation(operator: CombinedOperator, left: number, right: number): number | undefined {
  if (operator === 'divide' && right === 0) return undefined
  const value = operator === 'add' ? left + right
    : operator === 'subtract' ? left - right
      : operator === 'multiply' ? left * right
        : left / right
  return Number.isFinite(value) ? value : undefined
}
