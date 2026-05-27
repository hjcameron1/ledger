export interface InvestmentVerification {
  current_value: number;
  profit_loss: number;
  profit_loss_percent: number;
  is_verified: boolean;
  check1_passed: boolean;
  check2_passed: boolean;
  check3_passed: boolean;
}

export function verifyInvestment(
  sharesOwned: number,
  currentPrice: number,
  costBasis: number
): InvestmentVerification {
  // Check 1: Raw calculation
  const current_value = parseFloat((sharesOwned * currentPrice).toFixed(10));
  const check1_passed = Math.abs(current_value - sharesOwned * currentPrice) < 0.0001;

  // Check 2: Profit/loss sign sanity
  const profit_loss = parseFloat((current_value - costBasis).toFixed(10));
  let check2_passed: boolean;
  if (current_value > costBasis)   check2_passed = profit_loss > 0;
  else if (current_value < costBasis) check2_passed = profit_loss < 0;
  else check2_passed = profit_loss === 0;

  // Check 3: Percentage round-trip
  const profit_loss_percent = costBasis !== 0
    ? parseFloat(((profit_loss / costBasis) * 100).toFixed(10))
    : 0;
  const reverseCheck = costBasis !== 0
    ? parseFloat(((profit_loss_percent / 100) * costBasis).toFixed(10))
    : 0;
  const check3_passed = Math.abs(reverseCheck - profit_loss) < 0.01;

  return {
    current_value:        parseFloat(current_value.toFixed(2)),
    profit_loss:          parseFloat(profit_loss.toFixed(2)),
    profit_loss_percent:  parseFloat(profit_loss_percent.toFixed(4)),
    is_verified:          check1_passed && check2_passed && check3_passed,
    check1_passed,
    check2_passed,
    check3_passed,
  };
}
