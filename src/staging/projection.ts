import type * as ynab from 'ynab';

/** Store only fields used by read analysis, eligibility and transaction fingerprints. */
const transactionFields = 'id date amount memo cleared approved flag_color flag_name account_id payee_id category_id transfer_account_id transfer_transaction_id matched_transaction_id import_id import_payee_name import_payee_name_original debt_transaction_type deleted account_name payee_name category_name'.split(' ');
const subFields = 'id transaction_id amount memo payee_id payee_name category_id category_name transfer_account_id transfer_transaction_id deleted'.split(' ');
const accountFields = 'id name type on_budget closed balance cleared_balance uncleared_balance transfer_payee_id deleted'.split(' ');
const payeeFields = 'id name transfer_account_id deleted'.split(' ');
const categoryFields = 'id category_group_id category_group_name name hidden original_category_group_id budgeted activity balance goal_type goal_day goal_cadence goal_cadence_frequency goal_creation_month goal_target goal_target_month goal_percentage_complete goal_months_to_budget goal_under_funded goal_overall_funded goal_overall_left goal_needs_whole_amount deleted'.split(' ');
const groupFields = ['id', 'name', 'hidden', 'deleted'];
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function pick(value: unknown, fields: string[]): Record<string, unknown> {
  if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128 || typeof value.deleted !== 'boolean') throw Error('Invalid upstream record');
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const v = value[field];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) throw Error('Invalid upstream field');
    if (typeof v === 'string' && v.length > 10000) throw Error('Oversized upstream field');
    out[field] = v;
  }
  return out;
}
export function projectTransaction(value: unknown): ynab.TransactionDetail {
  const out = pick(value, transactionFields), row = value as Record<string, unknown>;
  if (!row.deleted && (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isSafeInteger(row.amount) || typeof row.approved !== 'boolean' || typeof row.account_id !== 'string' || !['uncleared', 'cleared', 'reconciled'].includes(String(row.cleared)) || !Array.isArray(row.subtransactions))) throw Error('Invalid upstream transaction');
  out.subtransactions = Array.isArray(row.subtransactions) ? row.subtransactions.map(sub => pick(sub, subFields)) : [];
  return out as unknown as ynab.TransactionDetail;
}
export const projectAccount = (value: unknown) => pick(value, accountFields) as unknown as ynab.Account;
export const projectPayee = (value: unknown) => pick(value, payeeFields) as unknown as ynab.Payee;
export function projectGroup(value: unknown): ynab.CategoryGroupWithCategories {
  const out = pick(value, groupFields), row = value as Record<string, unknown>;
  if (!row.deleted && !Array.isArray(row.categories)) throw Error('Invalid upstream category group');
  out.categories = Array.isArray(row.categories) ? row.categories.map(c => pick(c, categoryFields)) : [];
  return out as unknown as ynab.CategoryGroupWithCategories;
}
export function historySince(now: number): string {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}
export function retainTransaction(t: ynab.TransactionDetail, since: string, payees: Map<string, ynab.Payee>): boolean {
  if (t.deleted) return false;
  if (t.date >= since) return true;
  return !t.approved && !t.category_id && t.amount < 0 && t.cleared !== 'reconciled' && !t.transfer_account_id && !(t.payee_id && payees.get(t.payee_id)?.transfer_account_id) && !t.subtransactions.some(s => !s.deleted) && !['Starting Balance', 'Manual Balance Adjustment', 'Reconciliation Balance Adjustment'].includes(t.payee_name ?? '');
}
