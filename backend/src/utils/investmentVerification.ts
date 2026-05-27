import { InvestmentVerification } from '../types';

export function verifyInvestmentCalculation(
  sharesOwned: number,
  currentPrice: number,
  costBasis: number
): InvestmentVerification {
  // Check 1: Raw calculation
  const current_value = parseFloat((sharesOwned * currentPrice).toFixed(10));
  const check1_passed = Math.abs(current_value - sharesOwned * currentPrice) < 0.0001;

  // Check 2: Profit/loss sanity
  const profit_loss = parseFloat((current_value - costBasis).toFixed(10));
  let check2_passed = false;
  if (current_value > costBasis) check2_passed = profit_loss > 0;
  else if (current_value < costBasis) check2_passed = profit_loss < 0;
  else check2_passed = profit_loss === 0;

  // Check 3: Percentage consistency
  const profit_loss_percent = costBasis !== 0
    ? parseFloat(((profit_loss / costBasis) * 100).toFixed(10))
    : 0;
  const reverseCheck = costBasis !== 0
    ? parseFloat(((profit_loss_percent / 100) * costBasis).toFixed(10))
    : 0;
  const check3_passed = Math.abs(reverseCheck - profit_loss) < 0.01;

  const is_verified = check1_passed && check2_passed && check3_passed;

  return {
    current_value: parseFloat(current_value.toFixed(2)),
    profit_loss: parseFloat(profit_loss.toFixed(2)),
    profit_loss_percent: parseFloat(profit_loss_percent.toFixed(4)),
    is_verified,
    check1_passed,
    check2_passed,
    check3_passed,
  };
}

export function verifyPortfolioTotal(
  holdings: { current_value: number }[],
  claimed_total: number
): { verified: boolean; calculated_total: number; discrepancy: number } {
  const calculated_total = holdings.reduce((sum, h) => sum + h.current_value, 0);
  const discrepancy = Math.abs(calculated_total - claimed_total);
  return {
    verified: discrepancy < 0.01,
    calculated_total: parseFloat(calculated_total.toFixed(2)),
    discrepancy: parseFloat(discrepancy.toFixed(2)),
  };
}
